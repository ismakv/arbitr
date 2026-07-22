import { createPublicClient, http, formatEther, parseAbi, type Address } from "viem";
import { base } from "viem/chains";

const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as Address;

const POOL_ABI = parseAbi([
  "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

// Borrow event: Borrow(reserve, user, onBehalfOf, amount, interestRateMode, borrowRate, referralCode)
const BORROW_TOPIC = "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0" as `0x${string}`;

async function main() {
  console.log("═══ Aave Liquidation Scanner v2 ═══\n");

  // Use public Base RPC (no rate limit for small queries)
  const client = createPublicClient({
    chain: base,
    transport: http("https://mainnet.base.org"),
  });

  const block = await client.getBlockNumber();
  console.log(`Block: ${block}`);

  // Scan smaller range (100 blocks ≈ 200 seconds on Base)
  console.log(`Scanning last 100 blocks for Borrow events...`);

  let users: string[] = [];
  try {
    const logs = await client.getLogs({
      address: AAVE_POOL,
      topics: [BORROW_TOPIC],
      fromBlock: block - 100n,
      toBlock: block,
    });

    console.log(`Found ${logs.length} Borrow events`);

    const userSet = new Set<string>();
    for (const l of logs) {
      if (l.topics.length >= 3) {
        const userAddr = "0x" + l.topics[2].slice(26);
        userSet.add(userAddr);
      }
    }
    users = [...userSet];
    console.log(`Unique borrowers (last 100 blocks): ${users.length}`);
  } catch (err) {
    console.log(`Public RPC getLogs failed: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
  }

  // Also try: scan for LiquidationCall events (shows recent liquidations)
  console.log(`\nScanning for recent LiquidationCall events (last 500 blocks)...`);
  const LIQ_TOPIC = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286" as `0x${string}`;

  try {
    const liqLogs = await client.getLogs({
      address: AAVE_POOL,
      topics: [LIQ_TOPIC],
      fromBlock: block - 500n,
      toBlock: block,
    });

    console.log(`Recent liquidations (last ~15 min): ${liqLogs.length}`);
    if (liqLogs.length > 0) {
      console.log("  Liquidations ARE happening! This strategy is live.");
      for (const l of liqLogs.slice(0, 5)) {
        console.log(`    tx: ${l.transactionHash}`);
      }
    } else {
      console.log("  No liquidations in last ~15 min (normal for calm market).");
    }
  } catch (err) {
    console.log(`  Liq event scan failed: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
  }

  // Check health factors for found borrowers
  if (users.length > 0) {
    console.log(`\nChecking health factors...`);
    for (const addr of users.slice(0, 10)) {
      try {
        const data = await client.readContract({
          address: AAVE_POOL,
          abi: POOL_ABI,
          functionName: "getUserAccountData",
          args: [addr as Address],
        }) as bigint[];

        const collateral = Number(data[0]) / 1e8;
        const debt = Number(data[1]) / 1e8;
        const hf = Number(formatEther(data[5]));

        if (debt > 0) {
          const status = hf < 1.0 ? "🔴 LIQUIDATABLE" : hf < 1.1 ? "🟡 AT RISK" : "🟢";
          console.log(`  ${addr.slice(0, 12)}.. | coll: $${collateral.toFixed(0)} | debt: $${debt.toFixed(0)} | HF: ${hf.toFixed(4)} ${status}`);
        }
      } catch { /* skip */ }
    }
  }

  // Try Aave API for broader data
  console.log(`\nTrying Aave API for user positions...`);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch("https://aave-api-v2.aave.com/data/markets-data", { signal: controller.signal });
    clearTimeout(timeout);

    if (resp.ok) {
      const markets = await resp.json() as { underlyingSymbol?: string; liquidity?: { usd: number } }[];
      if (Array.isArray(markets)) {
        console.log(`  Aave API works! ${markets.length} markets`);
        const totalLiq = markets.reduce((s, m) => s + (m.liquidity?.usd || 0), 0);
        console.log(`  Total liquidity: $${(totalLiq / 1e9).toFixed(2)}B`);
      }
    } else {
      console.log(`  Aave API returned ${resp.status}`);
    }
  } catch {
    console.log("  Aave API unavailable");
  }

  // Final: try broader event scan with Infura (smaller range)
  console.log(`\nBroader scan: last 50 blocks via Infura...`);
  const infuraClient = createPublicClient({
    chain: base,
    transport: http(`https://base-mainnet.infura.io/v3/04f5929ddb2743528c1eaf8265f0ea31`),
  });

  try {
    const logs = await infuraClient.getLogs({
      address: AAVE_POOL,
      topics: [BORROW_TOPIC],
      fromBlock: block - 50n,
      toBlock: block,
    });
    console.log(`  Borrow events (50 blocks): ${logs.length}`);

    const userSet = new Set<string>();
    for (const l of logs) {
      if (l.topics.length >= 3) {
        userSet.add("0x" + l.topics[2].slice(26));
      }
    }

    if (userSet.size > 0) {
      console.log(`  Active borrowers: ${userSet.size}`);
      console.log(`\n  Checking their health factors...`);

      for (const addr of [...userSet].slice(0, 15)) {
        try {
          const data = await infuraClient.readContract({
            address: AAVE_POOL,
            abi: POOL_ABI,
            functionName: "getUserAccountData",
            args: [addr as Address],
          }) as bigint[];

          const collateral = Number(data[0]) / 1e8;
          const debt = Number(data[1]) / 1e8;
          const hf = Number(formatEther(data[5]));

          if (debt > 100) {
            const status = hf < 1.0 ? "🔴 LIQUIDATABLE!" : hf < 1.05 ? "🟠 CRITICAL" : hf < 1.15 ? "🟡 AT RISK" : "🟢";
            console.log(`    ${addr.slice(0, 14)}.. | $${collateral.toFixed(0)} coll | $${debt.toFixed(0)} debt | HF=${hf.toFixed(4)} ${status}`);
          }
        } catch { /* skip */ }
      }
    }
  } catch (err) {
    console.log(`  Infura scan failed: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
  }

  console.log("\n=== Done ===");
}

main().catch((err) => { console.error("Fatal:", err.message); process.exit(1); });
