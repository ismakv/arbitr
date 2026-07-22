import { describe, it, expect } from "vitest";
import { parseEther } from "viem";
import { detectArbitrage, scanOpportunities } from "./arbitrage.js";
import { type Quote } from "../types.js";

const WETH = "0x4200000000000000000000000000000000000006" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

function makeQuote(overrides: Partial<Quote> & { dex: string }): Quote {
  return {
    tokenIn: WETH,
    tokenOut: USDC,
    amountIn: parseEther("1"),
    amountOut: 3200_000000n, // $3200 in USDC (6 decimals)
    pool: "0x0000000000000000000000000000000000000001" as const,
    feeBps: 30,
    ...overrides,
  };
}

describe("detectArbitrage", () => {
  it("finds opportunity when sell price > buy price", () => {
    const buyQuote = makeQuote({
      dex: "UniswapV2",
      amountOut: 3200_000000n, // get 3200 USDC per WETH
    });

    const sellQuote = makeQuote({
      dex: "BaseSwap",
      tokenIn: USDC,
      tokenOut: WETH,
      amountIn: 3200_000000n,
      amountOut: parseEther("1.02"), // sell 3200 USDC -> 1.02 WETH
    });

    const gasCost = parseEther("0.001");
    const opps = detectArbitrage(
      [buyQuote],
      [sellQuote],
      WETH,
      USDC,
      gasCost,
      3200,
    );

    expect(opps.length).toBe(1);
    expect(opps[0].buyQuote.dex).toBe("UniswapV2");
    expect(opps[0].sellQuote.dex).toBe("BaseSwap");
    expect(opps[0].netProfitWei).toBeGreaterThan(0n);
  });

  it("skips same-DEX pairs", () => {
    const q1 = makeQuote({ dex: "UniswapV2" });
    const q2 = makeQuote({
      dex: "UniswapV2",
      tokenIn: USDC,
      tokenOut: WETH,
      amountIn: 3200_000000n,
      amountOut: parseEther("1.05"),
    });

    const opps = detectArbitrage([q1], [q2], WETH, USDC, 0n, 3200);
    expect(opps.length).toBe(0);
  });

  it("skips unprofitable after gas", () => {
    const buyQuote = makeQuote({
      dex: "UniswapV2",
      amountOut: 3200_000000n,
    });

    const sellQuote = makeQuote({
      dex: "BaseSwap",
      tokenIn: USDC,
      tokenOut: WETH,
      amountIn: 3200_000000n,
      amountOut: parseEther("1.001"), // tiny profit
    });

    const gasCost = parseEther("0.01"); // high gas
    const opps = detectArbitrage([buyQuote], [sellQuote], WETH, USDC, gasCost, 3200);
    expect(opps.length).toBe(0);
  });

  it("respects MIN_PROFIT_USD threshold", () => {
    const buyQuote = makeQuote({
      dex: "UniswapV2",
      amountOut: 3200_000000n,
    });

    // Profit ~$3.2 (0.001 ETH * $3200) — below default $5 min
    const sellQuote = makeQuote({
      dex: "BaseSwap",
      tokenIn: USDC,
      tokenOut: WETH,
      amountIn: 3200_000000n,
      amountOut: parseEther("1.001"),
    });

    const gasCost = 0n;
    const opps = detectArbitrage([buyQuote], [sellQuote], WETH, USDC, gasCost, 3200);
    expect(opps.length).toBe(0);
  });
});

describe("scanOpportunities", () => {
  it("scans quote map and returns sorted opportunities", () => {
    const quoteMap = new Map<string, Quote[]>();

    quoteMap.set(`${WETH}-${USDC}`, [
      makeQuote({ dex: "UniswapV2", amountOut: 3200_000000n }),
      makeQuote({ dex: "BaseSwap", amountOut: 3190_000000n }),
    ]);

    quoteMap.set(`${USDC}-${WETH}`, [
      makeQuote({
        dex: "UniswapV2",
        tokenIn: USDC,
        tokenOut: WETH,
        amountIn: 3200_000000n,
        amountOut: parseEther("0.99"),
      }),
      makeQuote({
        dex: "BaseSwap",
        tokenIn: USDC,
        tokenOut: WETH,
        amountIn: 3200_000000n,
        amountOut: parseEther("1.03"),
      }),
    ]);

    const opps = scanOpportunities(quoteMap, [WETH, USDC], 0n, 3200);

    // Should find: buy on UniV2 (3200 USDC), sell on BaseSwap (1.03 WETH) = profit
    expect(opps.length).toBeGreaterThan(0);
    expect(opps[0].buyQuote.dex).toBe("UniswapV2");
    expect(opps[0].sellQuote.dex).toBe("BaseSwap");
  });
});
