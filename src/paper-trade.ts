import { createPublicClient, http, formatEther, parseAbi, type Address } from "viem";
import { base } from "viem/chains";

const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as Address;
const PUBLIC_RPC = "https://mainnet.base.org";

const POOL_ABI = parseAbi([
  "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

const BORROW_TOPIC = "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0" as `0x${string}`;
const LIQ_TOPIC = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286" as `0x${string}`;

// LiquidationCall event: liquidationCall(reserve, user, liquidator, debtToCover, liquidatedCollateralAmount, receiveAToken)
// Topics: [event_sig, collateralAsset, debtAsset, user]
// Data: liquidator, debtToCover, liquidatedCollateralAmount, receiveAToken

interface PaperLiq {
  time: string;
  user: string;
  collateralUsd: number;
  debtUsd: number;
  hf: number;
  theoreticalProfit: number;
}

interface RealLiq {
  txHash: string;
  user: string;
  liquidator: string;
  debtCovered: bigint;
  collateralSeized: bigint;
}

async function analyzeRecentLiquidations(client: ReturnType<typeof createPublicClient>) {
  console.log("═══ ANALYZING RECENT LIQUIDATIONS ═══\n");

  const block = await client.getBlockNumber();
  console.log(`Current block: ${block}`);
  console.log(`Scanning last 2000 blocks (~65 min) for LiquidationCall events...\n`);

  let logs;
  try {
    logs = await client.getLogs({
      address: AAVE_POOL,
      topics: [LIQ_TOPIC],
      fromBlock: block - 2000n,
      toBlock: block,
    });
  } catch (err) {
    console.log(`getLogs failed: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
    console.log("Trying smaller range (500 blocks)...");
    logs = await client.getLogs({
      address: AAVE_POOL,
      topics: [LIQ_TOPIC],
      fromBlock: block - 500n,
      toBlock: block,
    });
  }

  console.log(`Found ${logs.length} LiquidationCall events\n`);

  if (logs.length === 0) {
    console.log("No liquidations in this window. Market is calm.");
    return;
  }

  // Parse events
  const liquidations: { tx: string; user: string; liquidator: string; block: bigint }[] = [];
  const liquidatorProfits = new Map<string, number>();

  for (const l of logs) {
    const user = l.topics.length >= 4 ? "0x" + l.topics[3].slice(26) : "unknown";
    // Data contains: liquidator (address), debtToCover (uint256), liquidatedCollateral (uint256), receiveAToken (bool)
    let liquidator = "unknown";
    let debtToCover = 0n;
    let collateralSeized = 0n;

    if (l.data && l.data.length >= 194) {
      const data = l.data.slice(2); // remove 0x
      liquidator = "0x" + data.slice(24, 64);
      debtToCover = BigInt("0x" + data.slice(64, 128));
      collateralSeized = BigInt("0x" + data.slice(128, 192));
    }

    liquidations.push({ tx: l.transactionHash, user, liquidator, block: l.blockNumber });

    // Track liquidator activity
    const count = liquidatorProfits.get(liquidator) || 0;
    liquidatorProfits.set(liquidator, count + 1);
  }

  // Report
  console.log(`--- Liquidation Stats (last ~65 min) ---`);
  console.log(`Total liquidations: ${liquidations.length}`);
  console.log(`Unique users liquidated: ${new Set(liquidations.map((l) => l.user)).size}`);
  console.log(`Unique liquidators: ${liquidatorProfits.size}`);

  console.log(`\nTop liquidators (bots):`);
  const sortedLiqs = [...liquidatorProfits.entries()].sort((a, b) => b[1] - a[1]);
  for (const [addr, count] of sortedLiqs.slice(0, 5)) {
    console.log(`  ${addr.slice(0, 16)}... — ${count} liquidations`);
  }

  // Estimate profits (5% bonus on collateral)
  // We can't easily get USD values from raw event data without knowing the asset
  // But we can estimate: avg liquidation on Base ≈ $500-2000 collateral
  const avgCollateralUsd = 1000; // conservative estimate
  const bonusPct = 0.05;
  const estProfitPerLiq = avgCollateralUsd * bonusPct;
  const totalEstProfit = liquidations.length * estProfitPerLiq;

  console.log(`\n--- Estimated Profits ---`);
  console.log(`Avg collateral per liq (est): $${avgCollateralUsd}`);
  console.log(`Liquidation bonus: 5%`);
  console.log(`Est profit per liq: $${estProfitPerLiq}`);
  console.log(`Total est profit (all bots, 65 min): $${totalEstProfit.toFixed(0)}`);
  console.log(`Per bot (if ${liquidatorProfits.size} bots): $${(totalEstProfit / Math.max(liquidatorProfits.size, 1)).toFixed(0)}`);

  // Show sample txs
  console.log(`\nSample transactions:`);
  for (const l of liquidations.slice(0, 3)) {
    console.log(`  tx: ${l.tx}`);
    console.log(`  user: ${l.user} | liquidator: ${l.liquidator} | block: ${l.block}`);
  }
}

async function paperTrade(durationSec: number) {
  console.log(`\n═══ PAPER TRADING (${durationSec}s) ═══\n`);

  const client = createPublicClient({
    chain: base,
    transport: http(PUBLIC_RPC),
  });

  const knownBorrowers = new Set<string>();
  const paperLiqs: PaperLiq[] = [];
  let lastBlock = await client.getBlockNumber();

  // Seed borrowers
  console.log("Seeding borrower list...");
  try {
    const logs = await client.getLogs({
      address: AAVE_POOL,
      topics: [BORROW_TOPIC],
      fromBlock: lastBlock - 500n,
      toBlock: lastBlock,
    });
    for (const l of logs) {
      if (l.topics.length >= 3) knownBorrowers.add("0x" + l.topics[2].slice(26));
    }
  } catch { /* ok */ }
  console.log(`Tracking ${knownBorrowers.size} borrowers\n`);

  const startTime = Date.now();
  let cycle = 0;

  while (Date.now() - startTime < durationSec * 1000) {
    cycle++;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

    try {
      const currentBlock = await client.getBlockNumber();
      if (currentBlock > lastBlock) {
        const newLogs = await client.getLogs({
          address: AAVE_POOL,
          topics: [BORROW_TOPIC],
          fromBlock: lastBlock,
          toBlock: currentBlock,
        }).catch(() => []);
        for (const l of newLogs) {
          if (l.topics.length >= 3) knownBorrowers.add("0x" + l.topics[2].slice(26));
        }
        lastBlock = currentBlock;
      }

      // Check positions
      for (const addr of knownBorrowers) {
        try {
          const data = await client.readContract({
            address: AAVE_POOL,
            abi: POOL_ABI,
            functionName: "getUserAccountData",
            args: [addr as Address],
          }) as bigint[];

          const debtUsd = Number(data[1]) / 1e8;
          if (debtUsd < 100) continue;

          const hf = Number(formatEther(data[5]));
          const collateralUsd = Number(data[0]) / 1e8;

          if (hf < 1.0) {
            const profit = collateralUsd * 0.5 * 0.05; // 50% close factor × 5% bonus
            paperLiqs.push({
              time: `${elapsed}s`,
              user: addr,
              collateralUsd,
              debtUsd,
              hf,
              theoreticalProfit: profit,
            });
            console.log(`🔴 [${elapsed}s] WOULD LIQUIDATE: ${addr.slice(0, 14)}.. | HF=${hf.toFixed(4)} | profit ~$${profit.toFixed(0)}`);
            knownBorrowers.delete(addr); // don't re-alert
          } else if (hf < 1.05 && cycle % 5 === 0) {
            console.log(`🟠 [${elapsed}s] CLOSE: ${addr.slice(0, 14)}.. | HF=${hf.toFixed(4)} | debt=$${debtUsd.toFixed(0)}`);
          }
        } catch { /* skip */ }
      }
    } catch { /* skip cycle */ }

    if (cycle % 15 === 0) {
      console.log(`  [${elapsed}s] cycle ${cycle} | borrowers=${knownBorrowers.size} | paper-liqs=${paperLiqs.length}`);
    }

    await new Promise((r) => setTimeout(r, 4000));
  }

  // Summary
  console.log(`\n═══ PAPER TRADING RESULTS (${durationSec}s) ═══`);
  console.log(`Cycles: ${cycle}`);
  console.log(`Borrowers tracked: ${knownBorrowers.size}`);
  console.log(`Liquidation opportunities: ${paperLiqs.length}`);

  if (paperLiqs.length > 0) {
    const totalProfit = paperLiqs.reduce((s, p) => s + p.theoreticalProfit, 0);
    console.log(`Theoretical profit: $${totalProfit.toFixed(0)}`);
    console.log(`\nOpportunities:`);
    for (const p of paperLiqs) {
      console.log(`  [${p.time}] ${p.user.slice(0, 14)}.. | HF=${p.hf.toFixed(4)} | ~$${p.theoreticalProfit.toFixed(0)}`);
    }
  } else {
    console.log(`No liquidation opportunities in this window.`);
    console.log(`This is normal for calm markets. Run during volatility for action.`);
  }
}

async function main() {
  const client = createPublicClient({ chain: base, transport: http(PUBLIC_RPC) });

  await analyzeRecentLiquidations(client);
  await paperTrade(120); // 2 minutes paper trading

  console.log("\n=== Done ===");
  process.exit(0);
}

main().catch((err) => { console.error("Fatal:", err.message); process.exit(1); });
