import { createPublicClient, http, formatEther, parseAbi, type Address } from "viem";
import { base } from "viem/chains";

const INFURA = "04f5929ddb2743528c1eaf8265f0ea31";
const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as Address;

const POOL_ABI = parseAbi([
  "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

// Aave V3 Base subgraph endpoints to try
const SUBGRAPH_URLS = [
  "https://api.goldsky.com/api/public/project_clk420x9i41bi01ui3s9n0b0e/subgraphs/aave-v3-base/1.0.0/gn",
  "https://gateway-arbitrum.network.thegraph.com/api/subgraphs/id/GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF",
  "https://api.thegraph.com/subgraphs/name/aave/aave-v3-base",
];

interface Borrower {
  user: string;
  debtUsd: number;
  collateralUsd: number;
  healthFactor: number;
}

async function querySubgraph(url: string): Promise<string[] | null> {
  const query = `{
    userReserves(
      where: { scaledVariableDebt_gt: "0" }
      first: 100
      orderBy: scaledVariableDebt
      orderDirection: desc
    ) {
      user { id }
    }
  }`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) return null;
    const json = await resp.json() as { data?: { userReserves?: { user: { id: string } }[] }; errors?: unknown[] };
    if (json.errors || !json.data?.userReserves) return null;

    return json.data.userReserves.map((r) => r.user.id);
  } catch {
    return null;
  }
}

async function main() {
  console.log("═══ Aave V3 Liquidation Scanner (Base) ═══\n");

  const client = createPublicClient({
    chain: base,
    transport: http(`https://base-mainnet.infura.io/v3/${INFURA}`),
  });

  // Step 1: Find borrowers via subgraph
  console.log("Searching for working subgraph endpoint...");
  let users: string[] | null = null;

  for (const url of SUBGRAPH_URLS) {
    console.log(`  Trying: ${url.slice(0, 60)}...`);
    users = await querySubgraph(url);
    if (users && users.length > 0) {
      console.log(`  ✅ Found ${users.length} borrowers`);
      break;
    }
    console.log(`  ❌ Failed`);
  }

  if (!users || users.length === 0) {
    console.log("\n⚠️  All subgraph endpoints failed.");
    console.log("   Alternative: scan Transfer/Borrow events from logs.");
    console.log("   Trying event-based approach...\n");

    // Fallback: get recent borrowers from event logs
    const block = await client.getBlockNumber();
    console.log(`  Current block: ${block}`);
    console.log(`  Scanning last 1000 blocks for Borrow events...`);

    // Aave V3 Borrow event topic
    const BORROW_TOPIC = "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0" as `0x${string}`;

    try {
      const logs = await client.getLogs({
        address: AAVE_POOL,
        topics: [BORROW_TOPIC],
        fromBlock: block - 1000n,
        toBlock: block,
      });

      console.log(`  Found ${logs.length} Borrow events in last 1000 blocks`);

      // Extract unique user addresses from event data
      const userSet = new Set<string>();
      for (const log of logs) {
        // Borrow event: reserve, user, onBehalfOf, amount, ...
        // user is typically in topics[2] or data
        if (log.topics.length >= 3) {
          const userAddr = "0x" + log.topics[2].slice(26);
          userSet.add(userAddr.toLowerCase());
        }
      }

      users = [...userSet];
      console.log(`  Unique borrowers: ${users.length}`);
    } catch (err) {
      console.log(`  Event scan failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (!users || users.length === 0) {
    console.log("\n❌ Could not find borrowers. Need a working data source.");
    console.log("   Options:");
    console.log("   1. Get a Goldsky/Graph API key (free tier available)");
    console.log("   2. Use Aave UI API: https://aave-api-v2.aave.com/data/markets-data");
    console.log("   3. Run own indexer");
    process.exit(0);
  }

  // Step 2: Check health factors
  console.log(`\nChecking health factors for ${users.length} users...\n`);

  const borrowers: Borrower[] = [];
  const BATCH = 10;

  for (let i = 0; i < Math.min(users.length, 50); i += BATCH) {
    const batch = users.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (addr) => {
        const data = await client.readContract({
          address: AAVE_POOL,
          abi: POOL_ABI,
          functionName: "getUserAccountData",
          args: [addr as Address],
        }) as bigint[];

        return {
          user: addr,
          collateralUsd: Number(data[0]) / 1e8,
          debtUsd: Number(data[1]) / 1e8,
          healthFactor: Number(formatEther(data[5])),
        };
      }),
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value.debtUsd > 0) {
        borrowers.push(r.value);
      }
    }
  }

  // Step 3: Report
  borrowers.sort((a, b) => a.healthFactor - b.healthFactor);

  console.log("  User          | Collateral | Debt       | Health Factor | Status");
  console.log("  " + "-".repeat(80));

  let liquidatable = 0;
  let atRisk = 0;

  for (const b of borrowers.slice(0, 20)) {
    const status = b.healthFactor < 1.0 ? "🔴 LIQUIDATABLE" : b.healthFactor < 1.05 ? "🟠 CRITICAL" : b.healthFactor < 1.15 ? "🟡 AT RISK" : "🟢 safe";
    if (b.healthFactor < 1.0) liquidatable++;
    if (b.healthFactor < 1.15) atRisk++;

    console.log(
      `  ${b.user.slice(0, 12)}.. | $${b.collateralUsd.toFixed(0).padStart(8)} | $${b.debtUsd.toFixed(0).padStart(8)} | ${b.healthFactor.toFixed(4).padStart(12)} | ${status}`,
    );
  }

  console.log(`\n═══ SUMMARY ═══`);
  console.log(`  Total borrowers checked: ${borrowers.length}`);
  console.log(`  Liquidatable (HF < 1.0): ${liquidatable}`);
  console.log(`  At risk (HF < 1.15): ${atRisk}`);

  if (liquidatable > 0) {
    console.log(`\n  🚨 ${liquidatable} POSITIONS CAN BE LIQUIDATED RIGHT NOW!`);
    console.log(`  Profit = 5% of collateral (Aave liquidation bonus)`);
    const liqProfit = borrowers
      .filter((b) => b.healthFactor < 1.0)
      .reduce((sum, b) => sum + b.collateralUsd * 0.05, 0);
    console.log(`  Potential profit: $${liqProfit.toFixed(0)}`);
  } else if (atRisk > 0) {
    console.log(`\n  ⚠️  ${atRisk} positions close to liquidation.`);
    console.log(`  A 3-5% price drop could trigger them.`);
    console.log(`  Keep this scanner running during volatility!`);
  } else {
    console.log(`\n  All positions healthy. No opportunities right now.`);
    console.log(`  Run during market crashes for liquidation profits.`);
  }

  console.log("\n=== Done ===");
}

main().catch((err) => { console.error("Fatal:", err.message); process.exit(1); });
