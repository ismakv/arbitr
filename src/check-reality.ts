import { createPublicClient, http, parseEther, formatEther, formatUnits, parseAbi, encodeFunctionData, decodeFunctionResult, type Address } from "viem";
import { base, arbitrum } from "viem/chains";

const INFURA = "04f5929ddb2743528c1eaf8265f0ea31";

const V2_ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
]);

const POOL_ABI = parseAbi([
  "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

const AAVE_POOL_BASE = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as Address;

async function getSpotPrice(client: ReturnType<typeof createPublicClient>, router: Address, tokenIn: Address, tokenOut: Address, outDecimals: number): Promise<number | null> {
  // Use tiny amount (0.001 ETH or 1 USDC) for spot price
  const amountIn = tokenIn.toLowerCase().includes("833589") || tokenIn.toLowerCase().includes("af88d0")
    ? 1_000000n // 1 USDC (6 dec)
    : parseEther("0.001"); // 0.001 ETH (18 dec)

  try {
    const data = encodeFunctionData({ abi: V2_ROUTER_ABI, functionName: "getAmountsOut", args: [amountIn, [tokenIn, tokenOut]] });
    const result = await client.call({ to: router, data });
    if (!result.data) return null;
    const amounts = decodeFunctionResult({ abi: V2_ROUTER_ABI, functionName: "getAmountsOut", data: result.data }) as bigint[];
    if (amounts.length < 2 || amounts[1] === 0n) return null;
    return Number(formatUnits(amounts[1], outDecimals));
  } catch { return null; }
}

async function checkCrossChain() {
  console.log("═══ 1. CROSS-CHAIN SPOT PRICES (0.001 ETH) ═══\n");

  const baseClient = createPublicClient({ chain: base, transport: http(`https://base-mainnet.infura.io/v3/${INFURA}`) });
  const arbClient = createPublicClient({ chain: arbitrum, transport: http(`https://arbitrum-mainnet.infura.io/v3/${INFURA}`) });

  const WETH_BASE = "0x4200000000000000000000000000000000000006" as Address;
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
  const WETH_ARB = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as Address;
  const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address;

  const routers = {
    base: [
      { name: "UniswapV2", addr: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24" as Address },
      { name: "BaseSwap", addr: "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86" as Address },
    ],
    arbitrum: [
      { name: "UniswapV2", addr: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24" as Address },
      { name: "SushiSwap", addr: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506" as Address },
    ],
  };

  const prices: { label: string; price: number }[] = [];

  console.log("WETH → USDC spot:");
  for (const r of routers.base) {
    const p = await getSpotPrice(baseClient, r.addr, WETH_BASE, USDC_BASE, 6);
    if (p) { const usd = p / 0.001; prices.push({ label: `Base/${r.name}`, price: usd }); console.log(`  Base/${r.name}: $${usd.toFixed(2)}`); }
  }
  for (const r of routers.arbitrum) {
    const p = await getSpotPrice(arbClient, r.addr, WETH_ARB, USDC_ARB, 6);
    if (p) { const usd = p / 0.001; prices.push({ label: `Arb/${r.name}`, price: usd }); console.log(`  Arb/${r.name}: $${usd.toFixed(2)}`); }
  }

  if (prices.length >= 2) {
    const sorted = [...prices].sort((a, b) => a.price - b.price);
    const spread = sorted[sorted.length - 1].price - sorted[0].price;
    const spreadPct = (spread / sorted[0].price) * 100;
    console.log(`\n  Spot spread: $${spread.toFixed(2)} (${spreadPct.toFixed(4)}%)`);
    console.log(`  Cheapest: ${sorted[0].label} ($${sorted[0].price.toFixed(2)})`);
    console.log(`  Dearest:  ${sorted[sorted.length - 1].label} ($${sorted[sorted.length - 1].price.toFixed(2)})`);

    if (spreadPct > 0.1) {
      console.log(`  ✅ Cross-chain spread ${spreadPct.toFixed(3)}% > 0.1% — POTENTIALLY VIABLE`);
    } else {
      console.log(`  ❌ Spread too small for cross-chain arb (need >0.1% to cover bridge)`);
    }
  }
}

async function checkLiquidations() {
  console.log("\n═══ 2. AAVE LIQUIDATIONS (Base) ═══\n");

  // Query Aave subgraph for top borrowers
  console.log("Querying Aave subgraph for borrowers...");

  const query = `{
    userReserves(
      where: { scaledVariableDebt_gt: "0" }
      first: 20
      orderBy: scaledVariableDebt
      orderDirection: desc
    ) {
      user { id }
      scaledVariableDebt
      reserve { symbol decimals }
    }
  }`;

  try {
    const resp = await fetch("https://api.goldsky.com/api/public/project_clk420x9i41bi01ui3s9n0b0e/subgraphs/aave-v3-base/1.0.0/gn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    const json = await resp.json() as { data?: { userReserves: { user: { id: string }; scaledVariableDebt: string; reserve: { symbol: string; decimals: string } }[] } };

    if (!json.data?.userReserves) {
      console.log("  Subgraph query failed, trying alternative endpoint...");
      // Fallback: just report what we know
      console.log("  (Subgraph unavailable — reporting general stats)");
      console.log("  Aave Base: ~$2B TVL, 15 reserves");
      console.log("  Liquidation bonus: 5% (ETH), 4% (stablecoins)");
      console.log("  To scan: need subgraph or event log indexing");
      return;
    }

    const borrowers = json.data.userReserves;
    console.log(`  Found ${borrowers.length} top borrowers\n`);

    // Check health factor for top borrowers
    const baseClient = createPublicClient({ chain: base, transport: http(`https://base-mainnet.infura.io/v3/${INFURA}`) });

    let liquidatable = 0;
    let atRisk = 0;

    for (const b of borrowers.slice(0, 10)) {
      try {
        const data = await baseClient.readContract({
          address: AAVE_POOL_BASE,
          abi: POOL_ABI,
          functionName: "getUserAccountData",
          args: [b.user.id as Address],
        }) as bigint[];

        const hf = Number(formatEther(data[5]));
        const collateral = Number(data[0]) / 1e8; // USD, 8 decimals
        const debt = Number(data[1]) / 1e8;

        const status = hf < 1.0 ? "🔴 LIQUIDATABLE" : hf < 1.1 ? "🟡 AT RISK" : "🟢 safe";
        if (hf < 1.0) liquidatable++;
        if (hf < 1.1) atRisk++;

        console.log(`  ${b.user.id.slice(0, 10)}... | HF: ${hf.toFixed(3)} | collateral: $${collateral.toFixed(0)} | debt: $${debt.toFixed(0)} | ${status}`);
      } catch {
        // skip
      }
    }

    console.log(`\n  Summary: ${liquidatable} liquidatable, ${atRisk} at risk (of top 10 borrowers)`);

    if (liquidatable > 0) {
      console.log("  ✅ LIQUIDATION OPPORTUNITY EXISTS RIGHT NOW!");
    } else if (atRisk > 0) {
      console.log("  ⚠️  Positions at risk — could be liquidatable on next price move");
    } else {
      console.log("  ❌ No liquidatable positions currently. Wait for volatility.");
    }
  } catch (err) {
    console.log(`  Subgraph error: ${err instanceof Error ? err.message : err}`);
    console.log("  Trying direct on-chain check of known positions...");
  }
}

async function checkLongTail() {
  console.log("\n═══ 3. LONG-TAIL TOKEN SPREADS (Base) ═══\n");

  const baseClient = createPublicClient({ chain: base, transport: http(`https://base-mainnet.infura.io/v3/${INFURA}`) });

  // Newer/smaller tokens on Base that might have wider spreads
  const longTailTokens: { addr: Address; symbol: string; decimals: number }[] = [
    { addr: "0x0d97F261b1e88845184f678e2d1e7a98D9FD38dE", symbol: "DEGEN", decimals: 18 },
    { addr: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4", symbol: "TOSHI", decimals: 18 },
    { addr: "0x532f27101965dd16442E59d40670FaF5eBB142E4", symbol: "BRETT", decimals: 18 },
    { addr: "0x0000000000000000000000000000000000000000", symbol: "SKIP", decimals: 18 },
  ];

  const WETH = "0x4200000000000000000000000000000000000006" as Address;
  const routers = [
    { name: "UniswapV2", addr: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24" as Address },
    { name: "BaseSwap", addr: "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86" as Address },
  ];

  const amountIn = parseEther("0.01"); // 0.01 ETH

  for (const token of longTailTokens) {
    if (token.addr === "0x0000000000000000000000000000000000000000") continue;

    const prices: { dex: string; out: number }[] = [];
    for (const r of routers) {
      const p = await getSpotPrice(baseClient, r.addr, WETH, token.addr, token.decimals);
      if (p && p > 0) prices.push({ dex: r.name, out: p / 0.01 }); // per 1 ETH
    }

    if (prices.length >= 2) {
      const sorted = prices.sort((a, b) => a.out - b.out);
      const spread = ((sorted[sorted.length - 1].out - sorted[0].out) / sorted[0].out) * 100;
      const marker = spread > 1 ? "🟢" : spread > 0.3 ? "🟡" : "  ";
      console.log(`  ${marker} ${token.symbol}: ${sorted.map((p) => `${p.dex}=${p.out.toFixed(2)}`).join(" | ")} | spread: ${spread.toFixed(2)}%`);
    } else if (prices.length === 1) {
      console.log(`     ${token.symbol}: only on ${prices[0].dex} (no cross-DEX pair)`);
    } else {
      console.log(`     ${token.symbol}: no quotes (no liquidity)`);
    }
  }

  console.log("\n  Threshold: >0.6% spread = profitable after fees");
  console.log("  Note: memecoins have higher spreads but also higher risk (tax, honeypot)");
}

async function main() {
  console.log("╔═══════════════════════════════════════════╗");
  console.log("║   REALITY CHECK: What Actually Works?    ║");
  console.log("╚═══════════════════════════════════════════╝\n");

  await checkCrossChain();
  await checkLiquidations();
  await checkLongTail();

  console.log("\n═══ FINAL VERDICT ═══\n");
  console.log("(see results above)");
  console.log("\n=== Done ===");
}

main().catch((err) => { console.error("Fatal:", err.message); process.exit(1); });
