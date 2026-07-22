import { createPublicClient, http, parseEther, formatEther, formatUnits, parseAbi, encodeFunctionData, decodeFunctionResult, type Address } from "viem";
import { base } from "viem/chains";

const INFURA = "04f5929ddb2743528c1eaf8265f0ea31";

const V2_ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
]);

const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function owner() view returns (address)",
]);

const WETH = "0x4200000000000000000000000000000000000006" as Address;
const TOSHI = "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4" as Address;

const UNIV2_ROUTER = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24" as Address;
const BASESWAP_ROUTER = "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86" as Address;

async function quote(client: ReturnType<typeof createPublicClient>, router: Address, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint | null> {
  try {
    const data = encodeFunctionData({ abi: V2_ROUTER_ABI, functionName: "getAmountsOut", args: [amountIn, [tokenIn, tokenOut]] });
    const result = await client.call({ to: router, data });
    if (!result.data) return null;
    const amounts = decodeFunctionResult({ abi: V2_ROUTER_ABI, functionName: "getAmountsOut", data: result.data }) as bigint[];
    return amounts.length >= 2 ? amounts[1] : null;
  } catch { return null; }
}

async function main() {
  console.log("═══ TOSHI Round-Trip Arbitrage Check ═══\n");

  const client = createPublicClient({ chain: base, transport: http(`https://base-mainnet.infura.io/v3/${INFURA}`) });

  // Token info
  console.log("--- Token Info ---");
  try {
    const [name, symbol, decimals, supply] = await Promise.all([
      client.readContract({ address: TOSHI, abi: ERC20_ABI, functionName: "name" }) as Promise<string>,
      client.readContract({ address: TOSHI, abi: ERC20_ABI, functionName: "symbol" }) as Promise<string>,
      client.readContract({ address: TOSHI, abi: ERC20_ABI, functionName: "decimals" }) as Promise<number>,
      client.readContract({ address: TOSHI, abi: ERC20_ABI, functionName: "totalSupply" }) as Promise<bigint>,
    ]);
    console.log(`  Name: ${name} (${symbol})`);
    console.log(`  Decimals: ${decimals}`);
    console.log(`  Supply: ${formatUnits(supply, decimals)}`);
  } catch (err) {
    console.log(`  Token info failed: ${err instanceof Error ? err.message : err}`);
  }

  // Test multiple sizes
  const sizes = [
    { label: "0.01 ETH", amount: parseEther("0.01") },
    { label: "0.05 ETH", amount: parseEther("0.05") },
    { label: "0.1 ETH", amount: parseEther("0.1") },
    { label: "0.5 ETH", amount: parseEther("0.5") },
    { label: "1.0 ETH", amount: parseEther("1.0") },
  ];

  console.log("\n--- Round-Trip: Buy TOSHI on BaseSwap → Sell on UniV2 ---\n");
  console.log("  Size       | Buy (BSwap)      | Sell (UniV2)     | Profit ETH   | Profit %  | Verdict");
  console.log("  " + "-".repeat(95));

  for (const { label, amount } of sizes) {
    // Leg 1: WETH → TOSHI on BaseSwap
    const toshiOut = await quote(client, BASESWAP_ROUTER, WETH, TOSHI, amount);
    if (!toshiOut) { console.log(`  ${label.padEnd(10)} | NO QUOTE (BaseSwap)`); continue; }

    // Leg 2: TOSHI → WETH on UniV2
    const ethOut = await quote(client, UNIV2_ROUTER, TOSHI, WETH, toshiOut);
    if (!ethOut) { console.log(`  ${label.padEnd(10)} | ${formatUnits(toshiOut, 18).slice(0, 12)} TOSHI | NO QUOTE (UniV2 reverse)`); continue; }

    const profitWei = ethOut - amount;
    const profitPct = Number(profitWei) / Number(amount) * 100;
    const profitEth = formatEther(profitWei);
    const verdict = profitWei > 0n ? "✅ PROFIT" : "❌ loss";

    console.log(
      `  ${label.padEnd(10)} | ${formatUnits(toshiOut, 18).slice(0, 16).padEnd(16)} | ${formatEther(ethOut).slice(0, 16).padEnd(16)} | ${profitEth.slice(0, 12).padEnd(12)} | ${profitPct.toFixed(3).padStart(7)}% | ${verdict}`,
    );
  }

  // Also check reverse: Buy on UniV2 → Sell on BaseSwap
  console.log("\n--- Round-Trip: Buy TOSHI on UniV2 → Sell on BaseSwap ---\n");
  console.log("  Size       | Buy (UniV2)      | Sell (BSwap)     | Profit ETH   | Profit %  | Verdict");
  console.log("  " + "-".repeat(95));

  for (const { label, amount } of sizes) {
    const toshiOut = await quote(client, UNIV2_ROUTER, WETH, TOSHI, amount);
    if (!toshiOut) { console.log(`  ${label.padEnd(10)} | NO QUOTE (UniV2)`); continue; }

    const ethOut = await quote(client, BASESWAP_ROUTER, TOSHI, WETH, toshiOut);
    if (!ethOut) { console.log(`  ${label.padEnd(10)} | ${formatUnits(toshiOut, 18).slice(0, 12)} TOSHI | NO QUOTE (BSwap reverse)`); continue; }

    const profitWei = ethOut - amount;
    const profitPct = Number(profitWei) / Number(amount) * 100;
    const profitEth = formatEther(profitWei);
    const verdict = profitWei > 0n ? "✅ PROFIT" : "❌ loss";

    console.log(
      `  ${label.padEnd(10)} | ${formatUnits(toshiOut, 18).slice(0, 16).padEnd(16)} | ${formatEther(ethOut).slice(0, 16).padEnd(16)} | ${profitEth.slice(0, 12).padEnd(12)} | ${profitPct.toFixed(3).padStart(7)}% | ${verdict}`,
    );
  }

  // Gas cost estimate
  const gasPrice = await client.getGasPrice();
  const gasCost = gasPrice * 300_000n;
  console.log(`\n--- Costs ---`);
  console.log(`  Gas: ${gasPrice / 1000000000n} gwei × 300k = ${formatEther(gasCost)} ETH (~$${(Number(formatEther(gasCost)) * 1939).toFixed(3)})`);
  console.log(`  DEX fees: 0.3% × 2 = 0.6% per round-trip`);
  console.log(`  Slippage: depends on size vs pool depth`);

  console.log("\n=== Done ===");
}

main().catch((err) => { console.error("Error:", err.message); process.exit(1); });
