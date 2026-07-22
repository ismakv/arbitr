import { type PublicClient, type Address, formatEther, parseEther } from "viem";
import { type ChainConfig } from "../config.js";
import { type PendingSwap } from "./monitor.js";
import { getAllQuotes } from "../dex/quoter.js";
import { type Quote, type ArbOpportunity } from "../types.js";
import { log } from "../logger.js";

let backrunCounter = 0;

/**
 * When a large swap lands on DEX A, the price there shifts.
 * We check if the OTHER DEXes now offer a better reverse price → backrun arb.
 *
 * Flow:
 * 1. Victim swaps tokenIn → tokenOut on DEX A (pushes price of tokenOut down on A)
 * 2. We buy tokenOut cheap on A, sell at normal price on B
 *    OR sell tokenOut on B first, buy back cheaper on A (after victim's tx mines)
 */
export async function evaluateBackrun(
  client: PublicClient,
  chainCfg: ChainConfig,
  swap: PendingSwap,
  nativePriceUsd: number,
  gasCostWei: bigint,
  minProfitUsd: number,
): Promise<ArbOpportunity | null> {
  const { tokenIn, tokenOut, amountIn, dex: victimDex } = swap;

  // Use the victim's amount as our trade size (capped)
  const tradeAmount = amountIn > parseEther("10") ? parseEther("10") : amountIn;
  if (tradeAmount === 0n) return null;

  // Get quotes: tokenOut → tokenIn on ALL dexes (this is the reverse leg)
  const reverseQuotes = await getAllQuotes(client, chainCfg, tokenOut, tokenIn, tradeAmount);

  // Get quotes: tokenIn → tokenOut on ALL dexes (forward leg)
  const forwardQuotes = await getAllQuotes(client, chainCfg, tokenIn, tokenOut, tradeAmount);

  // Find best forward NOT on victim's DEX
  const bestForward = forwardQuotes
    .filter((q) => q.dex !== victimDex)
    .sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1))[0];

  // Find best reverse on victim's DEX (price is now worse there = cheaper for us)
  const victimReverse = reverseQuotes
    .filter((q) => q.dex === victimDex)
    .sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1))[0];

  // Also check: buy on victim DEX (cheap after impact), sell on other DEX
  const victimForward = forwardQuotes
    .filter((q) => q.dex === victimDex)
    .sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1))[0];

  const bestReverse = reverseQuotes
    .filter((q) => q.dex !== victimDex)
    .sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1))[0];

  // Strategy A: buy on victim (post-impact cheap), sell on other DEX
  if (victimForward && bestReverse) {
    const opp = buildOpportunity(
      victimForward,
      bestReverse,
      tokenIn,
      tokenOut,
      tradeAmount,
      gasCostWei,
      nativePriceUsd,
      minProfitUsd,
    );
    if (opp) {
      log.info(`Backrun opp (buy victim → sell other): $${opp.profitUsd.toFixed(2)}`);
      return opp;
    }
  }

  // Strategy B: buy on other DEX, sell on victim (if victim price is still better for selling)
  if (bestForward && victimReverse) {
    const opp = buildOpportunity(
      bestForward,
      victimReverse,
      tokenIn,
      tokenOut,
      tradeAmount,
      gasCostWei,
      nativePriceUsd,
      minProfitUsd,
    );
    if (opp) {
      log.info(`Backrun opp (buy other → sell victim): $${opp.profitUsd.toFixed(2)}`);
      return opp;
    }
  }

  return null;
}

function buildOpportunity(
  buy: Quote,
  sell: Quote,
  tokenIn: Address,
  tokenMid: Address,
  amountIn: bigint,
  gasCostWei: bigint,
  nativePriceUsd: number,
  minProfitUsd: number,
): ArbOpportunity | null {
  const sellAmountOut = (sell.amountOut * buy.amountOut) / sell.amountIn;
  const profitWei = sellAmountOut - amountIn;
  if (profitWei <= 0n) return null;

  const netProfitWei = profitWei - gasCostWei;
  if (netProfitWei <= 0n) return null;

  const profitUsd = Number(formatEther(netProfitWei)) * nativePriceUsd;
  if (profitUsd < minProfitUsd) return null;

  return {
    id: `backrun-${++backrunCounter}`,
    buyQuote: buy,
    sellQuote: sell,
    tokenIn,
    tokenMid,
    amountIn,
    expectedOut: sellAmountOut,
    profitWei,
    profitUsd,
    gasCostWei,
    netProfitWei,
    timestamp: Date.now(),
  };
}
