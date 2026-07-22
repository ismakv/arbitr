import {
  type PublicClient,
  type Address,
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
} from "viem";
import { type DexConfig, type ChainConfig } from "../config.js";
import { type Quote } from "../types.js";

const V2_ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
]);

const V3_QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)",
]);

// Uniswap V3 QuoterV2 addresses per chain
const V3_QUOTERS: Record<number, Address> = {
  8453: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", // Base
  42161: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", // Arbitrum
};

export async function getV2Quote(
  client: PublicClient,
  dex: DexConfig,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<Quote | null> {
  try {
    const data = encodeFunctionData({
      abi: V2_ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [amountIn, [tokenIn, tokenOut]],
    });

    const result = await client.call({
      to: dex.router,
      data,
    });

    if (!result.data) return null;

    const amounts = decodeFunctionResult({
      abi: V2_ROUTER_ABI,
      functionName: "getAmountsOut",
      data: result.data,
    }) as bigint[];

    if (amounts.length < 2 || amounts[1] === 0n) return null;

    return {
      dex: dex.name,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: amounts[1],
      pool: dex.factory, // simplified; real pool address needs factory.getPair()
      feeBps: 30, // standard 0.3%
    };
  } catch {
    // Pair doesn't exist or insufficient liquidity
    return null;
  }
}

export async function getV3Quote(
  client: PublicClient,
  dex: DexConfig,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  chainId: number,
): Promise<Quote | null> {
  const quoter = V3_QUOTERS[chainId];
  if (!quoter) return null;

  try {
    const data = encodeFunctionData({
      abi: V3_QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [tokenIn, tokenOut, (dex.fee || 3000) as 500 | 3000 | 10000, amountIn, 0n],
    });

    // V3 quoter is not view — must use eth_call
    const result = await client.call({
      to: quoter,
      data,
    });

    if (!result.data) return null;

    const amountOut = decodeFunctionResult({
      abi: V3_QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      data: result.data,
    }) as bigint;

    if (amountOut === 0n) return null;

    return {
      dex: dex.name,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      pool: quoter,
      feeBps: (dex.fee || 3000) / 100,
    };
  } catch {
    return null;
  }
}

export async function getAllQuotes(
  client: PublicClient,
  chainCfg: ChainConfig,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<Quote[]> {
  const promises = chainCfg.dexes.map((dex) =>
    dex.type === "v2"
      ? getV2Quote(client, dex, tokenIn, tokenOut, amountIn)
      : getV3Quote(client, dex, tokenIn, tokenOut, amountIn, chainCfg.id),
  );

  const results = await Promise.allSettled(promises);
  return results
    .filter((r): r is PromiseFulfilledResult<Quote | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((q): q is Quote => q !== null);
}

/**
 * Batch quotes for all token pairs across all DEXes using multicall.
 * Returns a map: "tokenIn-tokenOut" -> Quote[]
 */
export async function batchQuotes(
  client: PublicClient,
  chainCfg: ChainConfig,
  amountIn: bigint,
): Promise<Map<string, Quote[]>> {
  const tokens = chainCfg.tokens;
  const pairs: [Address, Address][] = [];

  for (let i = 0; i < tokens.length; i++) {
    for (let j = 0; j < tokens.length; j++) {
      if (i !== j) pairs.push([tokens[i].address, tokens[j].address]);
    }
  }

  const quoteMap = new Map<string, Quote[]>();

  // Run in batches to avoid RPC rate limits
  const BATCH_SIZE = 10;
  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async ([tokenIn, tokenOut]) => {
        const quotes = await getAllQuotes(client, chainCfg, tokenIn, tokenOut, amountIn);
        return { key: `${tokenIn}-${tokenOut}`, quotes };
      }),
    );

    for (const { key, quotes } of batchResults) {
      if (quotes.length > 0) {
        quoteMap.set(key, quotes);
      }
    }
  }

  return quoteMap;
}
