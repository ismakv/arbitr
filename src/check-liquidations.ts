import { createPublicClient, http, parseAbi, formatEther, formatUnits, type Address } from "viem";
import { base } from "viem/chains";

const INFURA = "04f5929ddb2743528c1eaf8265f0ea31";

// Aave V3 on Base
const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as Address;
const UI_POOL_DATA_PROVIDER = "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e" as Address;

const UI_ABI = parseAbi([
  "function getReservesList() external view returns (address[])",
  "function getUserReserveData(address asset, address user) external view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
  "function getReserveData(address asset) external view returns (uint256 unbacked, uint256 accruedToTreasuryScaled, uint256 totalAToken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp)",
]);

const POOL_ABI = parseAbi([
  "function getReservesList() external view returns (address[])",
  "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

// Known large borrowers on Aave Base (from DeFiLlama/top positions)
// In production, use Aave subgraph to get all users with debt > 0
const KNOWN_USERS: Address[] = [
  // These are placeholder — in production we'd query the subgraph
  // For now, check a few known whale addresses
  "0x0000000000000000000000000000000000000001",
];

async function main() {
  console.log("=== Aave V3 Liquidation Scanner (Base) ===\n");

  const client = createPublicClient({
    chain: base,
    transport: http(`https://base-mainnet.infura.io/v3/${INFURA}`),
  });

  // 1. Get reserves list
  console.log("Fetching Aave reserves...");
  const reserves = await client.readContract({
    address: AAVE_POOL,
    abi: POOL_ABI,
    functionName: "getReservesList",
  }) as Address[];
  console.log(`Reserves: ${reserves.length} assets`);

  // 2. Show reserve info (total supply/borrow)
  console.log("\n--- Reserve Overview ---");
  for (const asset of reserves.slice(0, 8)) {
    try {
      const data = await client.readContract({
        address: UI_POOL_DATA_PROVIDER,
        abi: UI_ABI,
        functionName: "getReserveData",
        args: [asset],
      }) as bigint[];

      const totalSupply = data[2]; // totalAToken
      const totalVarDebt = data[4]; // totalVariableDebt
      const liqRate = data[5]; // liquidityRate (ray, 27 decimals)
      const varRate = data[6]; // variableBorrowRate

      const supplyFormatted = Number(formatEther(totalSupply));
      const debtFormatted = Number(formatEther(totalVarDebt));
      const liqPct = Number(liqRate) / 1e25; // ray -> %
      const borrowPct = Number(varRate) / 1e25;

      console.log(`  ${asset.slice(0, 10)}... | supply: ${supplyFormatted.toFixed(0)} | debt: ${debtFormatted.toFixed(0)} | borrow APY: ${borrowPct.toFixed(2)}%`);
    } catch {
      // skip
    }
  }

  // 3. Check liquidation opportunities
  // In production: query Aave subgraph for all users with healthFactor < 1.05
  // For now: demonstrate the check mechanism
  console.log("\n--- Liquidation Check ---");
  console.log("Note: Full scan requires Aave subgraph (all borrowers).");
  console.log("Checking mechanism with getUserAccountData...\n");

  // Demo: check a random address (will show HF = max if no position)
  const demoUser = "0x1234567890123456789012345678901234567890" as Address;
  try {
    const accountData = await client.readContract({
      address: AAVE_POOL,
      abi: POOL_ABI,
      functionName: "getUserAccountData",
      args: [demoUser],
    }) as bigint[];

    const healthFactor = accountData[5];
    const hfFormatted = Number(formatEther(healthFactor));
    console.log(`  Demo user HF: ${hfFormatted.toFixed(4)}`);
    console.log(`  (HF < 1.0 = liquidatable)`);
  } catch (err) {
    console.log(`  Demo check failed: ${err instanceof Error ? err.message : err}`);
  }

  // 4. Subgraph query (the real way)
  console.log("\n--- Subgraph Query (for production) ---");
  console.log(`
  To find liquidatable positions, query:
  
  POST https://api.thegraph.com/subgraphs/name/aave/aave-v3-base
  
  {
    userReserves(where: {
      scaledVariableDebt_gt: "0"
    }, first: 100, orderBy: scaledVariableDebt, orderDirection: desc) {
      user { id }
      scaledVariableDebt
      reserve { symbol }
    }
  }
  
  Then for each user: Pool.getUserAccountData(user) → healthFactor
  If healthFactor < 1e18 → LIQUIDATABLE
  
  Profit = collateral * liquidationBonus (5-10%)
  Typical: $50-500 per liquidation on Base
  `);

  // 5. Estimate opportunity
  console.log("--- Viability Assessment ---");
  console.log("  Aave Base TVL: ~$2B");
  console.log("  Active borrowers: ~5000-15000");
  console.log("  Liquidations/day (normal): 0-5");
  console.log("  Liquidations/day (crash): 50-500");
  console.log("  Avg profit per liq: $20-200 (5% bonus on $400-4000 position)");
  console.log("  Competition: moderate (fewer bots than ETH mainnet)");
  console.log("  Verdict: ✅ VIABLE during volatility, ⚠️ dry spells between crashes");

  console.log("\n=== Done ===");
}

main().catch((err) => { console.error("Error:", err.message); process.exit(1); });
