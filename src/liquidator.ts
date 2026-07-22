import {
  createWalletClient,
  http,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, arbitrum } from "viem/chains";
import "dotenv/config";
import { notify, notifyLiquidatable, notifyAtRisk, notifyExecuted } from "./notify.js";
import { type ProtocolMonitor, type Position } from "./protocols/types.js";
import { createAaveMonitors } from "./protocols/aave.js";
import { createMorphoMonitors } from "./protocols/morpho.js";
import { createCompoundMonitors } from "./protocols/compound.js";
import { getGasCostUsd, isProfitable, estimateLiquidationProfit } from "./utils/gas.js";
import { getClient } from "./utils/rpc.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || "4000");
const MIN_PROFIT_USD = Number(process.env.MIN_PROFIT_USD || "5");

let running = true;

function setupGracefulShutdown() {
  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] Shutting down gracefully...`);
    running = false;
    await notify(`⚪ <b>Bot stopped</b> (${signal})`);
    setTimeout(() => process.exit(0), 2000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

async function main() {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║  Multi-Protocol Liquidation Bot v2.0         ║");
  console.log("║  Aave V3 + Morpho Blue + Compound V3         ║");
  console.log("║  Chains: Base + Arbitrum                     ║");
  console.log("╚═══════════════════════════════════════════════╝\n");

  setupGracefulShutdown();

  // Initialize all protocol monitors
  const monitors: ProtocolMonitor[] = [
    ...createAaveMonitors(),
    ...createMorphoMonitors(),
    ...createCompoundMonitors(),
  ];

  console.log(`Protocols: ${monitors.map((m) => `${m.name} (${m.chain})`).join(", ")}`);

  // Wallet setup
  const privateKey = process.env.PRIVATE_KEY;
  let walletClient: WalletClient | null = null;

  if (privateKey) {
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    walletClient = createWalletClient({
      account,
      chain: base,
      transport: http(process.env.BASE_RPC_HTTPS || "https://mainnet.base.org"),
    });
    console.log(`Wallet: ${account.address}`);
    console.log("Mode: EXECUTION ENABLED\n");
  } else {
    console.log("No PRIVATE_KEY — monitor-only mode\n");
  }

  await notify(
    `🟢 <b>Liquidation bot v2.0 started</b>\n` +
    `Protocols: ${monitors.length} (Aave, Morpho, Compound)\n` +
    `Chains: Base + Arbitrum\n` +
    `Mode: ${walletClient ? "EXECUTION" : "monitor-only"}\n` +
    `Poll: ${POLL_INTERVAL_MS}ms`,
  );

  // Alert deduplication (don't spam for same position)
  const alertedPositions = new Map<string, number>();
  const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 min

  let cycle = 0;
  let totalLiquidatable = 0;
  let totalExecuted = 0;
  let totalProfitUsd = 0;

  const loop = async () => {
    if (!running) return;
    cycle++;

    try {
      // Scan all protocols concurrently
      const scanResults = await Promise.allSettled(
        monitors.map((m) => m.scan()),
      );

      let allPositions: Position[] = [];
      let atRiskCount = 0;
      let liquidatableCount = 0;

      for (let i = 0; i < scanResults.length; i++) {
        const r = scanResults[i];
        if (r.status === "fulfilled") {
          allPositions = allPositions.concat(r.value);
        }
      }

      // Process positions
      for (const pos of allPositions) {
        const key = `${pos.protocol}-${pos.chain}-${pos.user}`;

        if (pos.healthFactor < 1.0) {
          liquidatableCount++;
          totalLiquidatable++;

          const lastAlert = alertedPositions.get(key) || 0;
          if (Date.now() - lastAlert > ALERT_COOLDOWN_MS) {
            alertedPositions.set(key, Date.now());

            console.log(
              `\n🔴 [${new Date().toISOString()}] ${pos.protocol} (${pos.chain})\n` +
              `   User: ${pos.user.slice(0, 16)}.. | HF=${pos.healthFactor.toFixed(4)}\n` +
              `   Collateral: $${pos.collateralUsd.toFixed(0)} | Debt: $${pos.debtUsd.toFixed(0)}`,
            );

            await notifyLiquidatable(pos.user, pos.healthFactor, pos.collateralUsd, pos.debtUsd);

            // Execute if wallet available
            if (walletClient) {
              const client = await getClient(pos.chain);
              const gasCostUsd = await getGasCostUsd(client, pos.chain);
              const bonusUsd = estimateLiquidationProfit(pos.collateralUsd);

              if (isProfitable(bonusUsd, gasCostUsd, MIN_PROFIT_USD)) {
                console.log(`   ⚡ Executing (profit ~$${bonusUsd.toFixed(0)}, gas ~$${gasCostUsd.toFixed(2)})`);
                const monitor = monitors.find((m) => m.name === pos.protocol && m.chain === pos.chain);
                if (monitor) {
                  const result = await monitor.liquidate(pos, walletClient);
                  if (result.success) {
                    totalExecuted++;
                    totalProfitUsd += result.profitUsd || 0;
                    console.log(`   🎉 SUCCESS tx=${result.txHash} profit~$${result.profitUsd?.toFixed(0)}`);
                    await notifyExecuted(pos.user, result.txHash || "", result.profitUsd || 0);
                  } else {
                    console.log(`   ❌ FAILED: ${result.error}`);
                  }
                }
              } else {
                console.log(`   ⏭️ Skip: profit $${bonusUsd.toFixed(0)} < gas $${gasCostUsd.toFixed(2)} + min $${MIN_PROFIT_USD}`);
              }
            }
          }
        } else if (pos.healthFactor < 1.1) {
          atRiskCount++;
          const lastAlert = alertedPositions.get(key) || 0;
          if (Date.now() - lastAlert > ALERT_COOLDOWN_MS && cycle % 10 === 1) {
            alertedPositions.set(key, Date.now());
            console.log(`🟡 ${pos.protocol} (${pos.chain}) AT RISK: ${pos.user.slice(0, 14)}.. HF=${pos.healthFactor.toFixed(4)} | $${pos.debtUsd.toFixed(0)} debt`);
            await notifyAtRisk(pos.user, pos.healthFactor, pos.debtUsd);
          }
        }
      }

      // Periodic status
      if (cycle % 30 === 0) {
        const borrowerInfo = monitors
          .filter((m) => "borrowerCount" in m)
          .map((m) => `${m.name}(${m.chain}):${(m as any).borrowerCount}`)
          .join(" ");
        console.log(
          `[cycle ${cycle}] positions=${allPositions.length} | atRisk=${atRiskCount} | ` +
          `liquidatable=${liquidatableCount} | executed=${totalExecuted} | profit=$${totalProfitUsd.toFixed(0)} | ${borrowerInfo}`,
        );
      }
    } catch (err) {
      console.error(`[cycle ${cycle}] Error: ${err instanceof Error ? err.message : err}`);
    }

    if (running) setTimeout(loop, POLL_INTERVAL_MS);
  };

  await loop();
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
