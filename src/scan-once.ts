import { parseEther, formatEther, formatUnits } from "viem";
import { CONFIG, CHAINS } from "./config.js";
import { createClients } from "./providers.js";
import { batchQuotesMulticall } from "./dex/multicall.js";
import { scanOpportunities } from "./strategy/arbitrage.js";

async function main() {
  console.log("=== Single Scan Cycle ===");
  console.log(`Chain: ${CONFIG.activeChain}`);

  const chainCfg = CHAINS[CONFIG.activeChain];
  const { publicClient } = createClients();

  console.log(`Fetching block number...`);
  const block = await publicClient.getBlockNumber();
  console.log(`Block: ${block}`);

  const amountIn = parseEther("0.1"); // 0.1 for 18-dec, auto-scaled for 6-dec
  console.log(`Scanning ${chainCfg.tokens.length} tokens × ${chainCfg.dexes.length} DEXes...`);

  const quoteMap = await batchQuotesMulticall(
    publicClient,
    chainCfg,
    chainCfg.tokens,
    amountIn,
  );

  const totalQuotes = [...quoteMap.values()].reduce((s, q) => s + q.length, 0);
  console.log(`Got ${quoteMap.size} pairs, ${totalQuotes} quotes\n`);

  // Show quotes with proper decimal formatting
  const tokenMap = new Map(chainCfg.tokens.map((t) => [t.address, t]));

  for (const [key, quotes] of quoteMap.entries()) {
    const [addrIn, addrOut] = key.split("-");
    const tIn = tokenMap.get(addrIn as `0x${string}`);
    const tOut = tokenMap.get(addrOut as `0x${string}`);
    if (!tIn || !tOut) continue;

    console.log(`  ${tIn.symbol} → ${tOut.symbol}:`);
    for (const q of quotes) {
      const inFmt = formatUnits(q.amountIn, tIn.decimals);
      const outFmt = formatUnits(q.amountOut, tOut.decimals);
      console.log(`    ${q.dex.padEnd(14)} ${inFmt} → ${outFmt}`);
    }
  }

  // Scan for arb
  const gasPrice = await publicClient.getGasPrice();
  const gasCostWei = gasPrice * 300_000n;
  console.log(`\nGas: ${gasPrice / 1000000000n} gwei, cost ~${formatEther(gasCostWei)} ETH`);

  const tokenAddresses = chainCfg.tokens.map((t) => t.address);
  const opps = scanOpportunities(quoteMap, tokenAddresses, gasCostWei, 1940);
  console.log(`\nOpportunities: ${opps.length}`);
  for (const opp of opps.slice(0, 10)) {
    const tIn = tokenMap.get(opp.tokenIn);
    const tMid = tokenMap.get(opp.tokenMid);
    console.log(
      `  ${opp.buyQuote.dex}→${opp.sellQuote.dex} | ` +
      `${tIn?.symbol}→${tMid?.symbol}→${tIn?.symbol} | ` +
      `$${opp.profitUsd.toFixed(2)} | ${formatEther(opp.netProfitWei)} ETH net`,
    );
  }

  console.log("\n=== Done ===");
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
