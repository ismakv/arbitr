import { parseEther, formatEther, formatUnits } from "viem";
import { CHAINS } from "./config.js";
import { createClients } from "./providers.js";
import { batchQuotesMulticall } from "./dex/multicall.js";
import { type Quote } from "./types.js";

const DURATION_SEC = 180; // 3 minutes
const POLL_MS = 2000;

interface SpreadRecord {
  time: string;
  pair: string;
  buyDex: string;
  sellDex: string;
  spreadPct: number;
  profitEth: number;
}

function calcBestRoundTrip(
  forwardQuotes: Quote[],
  reverseQuotes: Quote[],
  amountIn: bigint,
): { buyDex: string; sellDex: string; spreadPct: number; profitEth: number } | null {
  let best: { buyDex: string; sellDex: string; spreadPct: number; profitEth: number } | null = null;

  for (const buy of forwardQuotes) {
    for (const sell of reverseQuotes) {
      if (buy.dex === sell.dex) continue;

      // buy: amountIn -> buy.amountOut (mid token)
      // sell: sell.amountIn -> sell.amountOut (back to original)
      // Scale sell to match what we got from buy
      if (sell.amountIn === 0n) continue;
      const sellOut = (sell.amountOut * buy.amountOut) / sell.amountIn;
      const profitWei = sellOut - amountIn;
      const spreadPct = Number(profitWei) / Number(amountIn) * 100;

      if (!best || spreadPct > best.spreadPct) {
        best = {
          buyDex: buy.dex,
          sellDex: sell.dex,
          spreadPct,
          profitEth: Number(formatEther(profitWei)),
        };
      }
    }
  }

  return best;
}

async function main() {
  console.log(`=== Spread Monitor (${DURATION_SEC}s, poll ${POLL_MS}ms) ===`);
  console.log("Looking for round-trip arbitrage spreads on Base...\n");

  const chainCfg = CHAINS["base"];
  const { publicClient } = createClients();
  const amountIn = parseEther("0.1");
  const tokenMap = new Map(chainCfg.tokens.map((t) => [t.address, t]));
  const tokenAddresses = chainCfg.tokens.map((t) => t.address);

  const allSpreads: SpreadRecord[] = [];
  let cycles = 0;
  const startTime = Date.now();

  while (Date.now() - startTime < DURATION_SEC * 1000) {
    cycles++;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

    try {
      const quoteMap = await batchQuotesMulticall(
        publicClient,
        chainCfg,
        chainCfg.tokens,
        amountIn,
      );

      let cycleBest: SpreadRecord | null = null;

      for (let i = 0; i < tokenAddresses.length; i++) {
        for (let j = 0; j < tokenAddresses.length; j++) {
          if (i === j) continue;
          const tIn = tokenAddresses[i];
          const tOut = tokenAddresses[j];

          const forward = quoteMap.get(`${tIn}-${tOut}`);
          const reverse = quoteMap.get(`${tOut}-${tIn}`);
          if (!forward || !reverse || forward.length < 2) continue;

          const result = calcBestRoundTrip(forward, reverse, amountIn);
          if (!result) continue;

          const tInSym = tokenMap.get(tIn)?.symbol || "?";
          const tOutSym = tokenMap.get(tOut)?.symbol || "?";
          const pair = `${tInSym}→${tOutSym}→${tInSym}`;

          const record: SpreadRecord = {
            time: `${elapsed}s`,
            pair,
            buyDex: result.buyDex,
            sellDex: result.sellDex,
            spreadPct: result.spreadPct,
            profitEth: result.profitEth,
          };

          allSpreads.push(record);
          if (!cycleBest || record.spreadPct > cycleBest.spreadPct) {
            cycleBest = record;
          }
        }
      }

      if (cycleBest && cycleBest.spreadPct > -1) {
        const marker = cycleBest.spreadPct > 0 ? "🟢" : cycleBest.spreadPct > -0.5 ? "🟡" : "  ";
        console.log(
          `${marker} [${elapsed}s] best: ${cycleBest.pair} | ` +
          `${cycleBest.buyDex}→${cycleBest.sellDex} | ` +
          `spread: ${cycleBest.spreadPct.toFixed(3)}% | ` +
          `${cycleBest.profitEth.toFixed(6)} ETH`,
        );
      } else {
        process.stdout.write(`\r  [${elapsed}s] scanning... (cycle ${cycles})`);
      }
    } catch (err) {
      console.log(`\n  [${elapsed}s] error: ${err instanceof Error ? err.message : err}`);
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  // Summary
  console.log("\n\n═══════════════════════════════════════");
  console.log("  RESULTS");
  console.log("═══════════════════════════════════════");
  console.log(`Cycles: ${cycles}`);
  console.log(`Total spread measurements: ${allSpreads.length}`);

  if (allSpreads.length > 0) {
    const sorted = allSpreads.sort((a, b) => b.spreadPct - a.spreadPct);
    const positive = sorted.filter((s) => s.spreadPct > 0);
    const aboveHalf = sorted.filter((s) => s.spreadPct > 0.5);
    const aboveOne = sorted.filter((s) => s.spreadPct > 1.0);

    console.log(`\nPositive spreads: ${positive.length}/${allSpreads.length}`);
    console.log(`Above 0.5%: ${aboveHalf.length}`);
    console.log(`Above 1.0%: ${aboveOne.length}`);

    console.log(`\nTop 10 spreads:`);
    for (const s of sorted.slice(0, 10)) {
      console.log(
        `  ${s.spreadPct > 0 ? "+" : ""}${s.spreadPct.toFixed(3)}% | ` +
        `${s.pair} | ${s.buyDex}→${s.sellDex} | ` +
        `${s.profitEth.toFixed(6)} ETH | t=${s.time}`,
      );
    }

    const avg = allSpreads.reduce((s, r) => s + r.spreadPct, 0) / allSpreads.length;
    const max = sorted[0].spreadPct;
    const min = sorted[sorted.length - 1].spreadPct;

    console.log(`\nStats: avg=${avg.toFixed(3)}% max=${max.toFixed(3)}% min=${min.toFixed(3)}%`);

    if (max > 0.6) {
      console.log("\n✅ VIABLE: Spreads exceed fee threshold (0.6%). Arb windows exist.");
    } else if (max > 0) {
      console.log("\n⚠️  MARGINAL: Small positive spreads exist but below fee threshold.");
      console.log("   Might work with flash loans (larger size) or during volatility.");
    } else {
      console.log("\n❌ NOT VIABLE at current conditions. No positive round-trip spreads.");
      console.log("   Consider: different chain, different tokens, or mempool-based strategy.");
    }
  }

  console.log("\n=== Done ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
