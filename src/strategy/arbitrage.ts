import { type Address, parseEther, formatEther } from "viem";
import { type Quote, type ArbOpportunity } from "../types.js";
import { CONFIG } from "../config.js";

let opportunityCounter = 0;

/**
 * Detect 2-hop arbitrage: buy tokenMid on DEX A, sell on DEX B.
 * For each token pair, compare best buy vs best sell across DEXes.
 */
export function detectArbitrage(
  quotesForward: Quote[], // tokenIn -> tokenMid
  quotesReverse: Quote[], // tokenMid -> tokenIn
  tokenIn: Address,
  tokenMid: Address,
  gasCostWei: bigint,
  nativePriceUsd: number,
): ArbOpportunity[] {
  const opportunities: ArbOpportunity[] = [];

  for (const buy of quotesForward) {
    for (const sell of quotesReverse) {
      if (buy.dex === sell.dex) continue; // same DEX = no arb

      const amountMid = buy.amountOut;
      // Scale sell input to match what we got from buy
      const sellAmountOut = (sell.amountOut * amountMid) / sell.amountIn;

      const profitWei = sellAmountOut - buy.amountIn;
      if (profitWei <= 0n) continue;

      const netProfitWei = profitWei - gasCostWei;
      if (netProfitWei <= 0n) continue;

      const profitUsd = Number(formatEther(netProfitWei)) * nativePriceUsd;
      if (profitUsd < CONFIG.minProfitUsd) continue;

      opportunities.push({
        id: `arb-${++opportunityCounter}`,
        buyQuote: buy,
        sellQuote: sell,
        tokenIn,
        tokenMid,
        amountIn: buy.amountIn,
        expectedOut: sellAmountOut,
        profitWei,
        profitUsd,
        gasCostWei,
        netProfitWei,
        timestamp: Date.now(),
      });
    }
  }

  // Sort by net profit descending
  opportunities.sort((a, b) => (b.netProfitWei > a.netProfitWei ? 1 : -1));
  return opportunities;
}

/**
 * Scan all quote pairs for arbitrage opportunities.
 */
export function scanOpportunities(
  quoteMap: Map<string, Quote[]>,
  tokens: Address[],
  gasCostWei: bigint,
  nativePriceUsd: number,
): ArbOpportunity[] {
  const allOpps: ArbOpportunity[] = [];

  for (let i = 0; i < tokens.length; i++) {
    for (let j = 0; j < tokens.length; j++) {
      if (i === j) continue;
      const tokenIn = tokens[i];
      const tokenMid = tokens[j];

      const forwardKey = `${tokenIn}-${tokenMid}`;
      const reverseKey = `${tokenMid}-${tokenIn}`;

      const forward = quoteMap.get(forwardKey);
      const reverse = quoteMap.get(reverseKey);
      if (!forward || !reverse) continue;

      const opps = detectArbitrage(
        forward,
        reverse,
        tokenIn,
        tokenMid,
        gasCostWei,
        nativePriceUsd,
      );
      allOpps.push(...opps);
    }
  }

  allOpps.sort((a, b) => (b.netProfitWei > a.netProfitWei ? 1 : -1));
  return allOpps;
}
