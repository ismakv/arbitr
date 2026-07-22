import { createPublicClient, http, parseEther, formatEther, formatUnits, parseAbi, encodeFunctionData, decodeFunctionResult, type Address } from "viem";
import { base, arbitrum } from "viem/chains";

const INFURA = "04f5929ddb2743528c1eaf8265f0ea31";

const V2_ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
]);

// WETH and USDC per chain
const TOKENS = {
  base: {
    WETH: "0x4200000000000000000000000000000000000006" as Address,
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
    routers: [
      { name: "UniswapV2", addr: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24" as Address },
      { name: "BaseSwap", addr: "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86" as Address },
    ],
  },
  arbitrum: {
    WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as Address,
    USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address,
    routers: [
      { name: "UniswapV2", addr: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24" as Address },
      { name: "SushiSwap", addr: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506" as Address },
      { name: "Camelot", addr: "0xc873fEcbd354f5A56E00E710B90EF4201db2448d" as Address },
    ],
  },
};

async function getPrice(client: ReturnType<typeof createPublicClient>, router: Address, tokenIn: Address, tokenOut: Address, amountIn: bigint, outDecimals: number): Promise<number | null> {
  try {
    const data = encodeFunctionData({
      abi: V2_ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [amountIn, [tokenIn, tokenOut]],
    });
    const result = await client.call({ to: router, data });
    if (!result.data) return null;
    const amounts = decodeFunctionResult({ abi: V2_ROUTER_ABI, functionName: "getAmountsOut", data: result.data }) as bigint[];
    if (amounts.length < 2 || amounts[1] === 0n) return null;
    return Number(formatUnits(amounts[1], outDecimals));
  } catch {
    return null;
  }
}

async function main() {
  console.log("=== Cross-Chain Price Comparison ===\n");

  const baseClient = createPublicClient({ chain: base, transport: http(`https://base-mainnet.infura.io/v3/${INFURA}`) });
  const arbClient = createPublicClient({ chain: arbitrum, transport: http(`https://arbitrum-mainnet.infura.io/v3/${INFURA}`) });

  const amountWeth = parseEther("1"); // 1 WETH
  const amountUsdc = 1000n * 10n ** 6n; // 1000 USDC

  console.log("--- WETH → USDC (1 WETH) ---");
  const prices: { chain: string; dex: string; price: number }[] = [];

  for (const r of TOKENS.base.routers) {
    const p = await getPrice(baseClient, r.addr, TOKENS.base.WETH, TOKENS.base.USDC, amountWeth, 6);
    if (p) { prices.push({ chain: "Base", dex: r.name, price: p }); console.log(`  Base/${r.name}: ${p.toFixed(2)} USDC`); }
  }
  for (const r of TOKENS.arbitrum.routers) {
    const p = await getPrice(arbClient, r.addr, TOKENS.arbitrum.WETH, TOKENS.arbitrum.USDC, amountWeth, 6);
    if (p) { prices.push({ chain: "Arbitrum", dex: r.name, price: p }); console.log(`  Arbitrum/${r.name}: ${p.toFixed(2)} USDC`); }
  }

  console.log("\n--- USDC → WETH (1000 USDC) ---");
  const pricesReverse: { chain: string; dex: string; price: number }[] = [];

  for (const r of TOKENS.base.routers) {
    const p = await getPrice(baseClient, r.addr, TOKENS.base.USDC, TOKENS.base.WETH, amountUsdc, 18);
    if (p) { pricesReverse.push({ chain: "Base", dex: r.name, price: p }); console.log(`  Base/${r.name}: ${p.toFixed(6)} WETH`); }
  }
  for (const r of TOKENS.arbitrum.routers) {
    const p = await getPrice(arbClient, r.addr, TOKENS.arbitrum.USDC, TOKENS.arbitrum.WETH, amountUsdc, 18);
    if (p) { pricesReverse.push({ chain: "Arbitrum", dex: r.name, price: p }); console.log(`  Arbitrum/${r.name}: ${p.toFixed(6)} WETH`); }
  }

  // Find cross-chain spread
  console.log("\n--- Cross-Chain Spreads ---");
  if (prices.length >= 2) {
    const sorted = [...prices].sort((a, b) => a.price - b.price);
    const cheapest = sorted[0];
    const dearest = sorted[sorted.length - 1];
    const spreadPct = ((dearest.price - cheapest.price) / cheapest.price) * 100;
    const spreadUsd = dearest.price - cheapest.price;

    console.log(`  Cheapest WETH: ${cheapest.chain}/${cheapest.dex} = ${cheapest.price.toFixed(2)} USDC`);
    console.log(`  Dearest WETH:  ${dearest.chain}/${dearest.dex} = ${dearest.price.toFixed(2)} USDC`);
    console.log(`  Spread: ${spreadPct.toFixed(3)}% ($${spreadUsd.toFixed(2)})`);
    console.log(`  Bridge cost (Hop/Stargate): ~$1-3`);
    console.log(`  Net after bridge: $${(spreadUsd - 2).toFixed(2)}`);

    if (spreadUsd > 5) {
      console.log("\n  ✅ VIABLE: Spread exceeds bridge cost!");
    } else if (spreadUsd > 2) {
      console.log("\n  ⚠️  MARGINAL: Spread barely covers bridge. Need larger size.");
    } else {
      console.log("\n  ❌ NOT VIABLE: Spread < bridge cost.");
    }
  }

  // Also check: same-chain cross-DEX on Arbitrum (more DEXes = more chance)
  console.log("\n--- Arbitrum Intra-Chain Spreads (1 WETH) ---");
  const arbPrices = prices.filter((p) => p.chain === "Arbitrum");
  if (arbPrices.length >= 2) {
    for (let i = 0; i < arbPrices.length; i++) {
      for (let j = i + 1; j < arbPrices.length; j++) {
        const spread = Math.abs(arbPrices[i].price - arbPrices[j].price);
        const spreadPct = (spread / Math.min(arbPrices[i].price, arbPrices[j].price)) * 100;
        console.log(`  ${arbPrices[i].dex} vs ${arbPrices[j].dex}: $${spread.toFixed(2)} (${spreadPct.toFixed(3)}%)`);
      }
    }
  }

  console.log("\n=== Done ===");
}

main().catch((err) => { console.error("Error:", err.message); process.exit(1); });
