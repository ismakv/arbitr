import {
  type PublicClient,
  type Address,
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
} from "viem";
import { type DexConfig, type ChainConfig, type TokenConfig } from "../config.js";
import { type Quote } from "../types.js";

const MULTICALL3_ABI = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

const V2_ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
]);

// Aerodrome/Velodrome (Solidly fork): getAmountsOut(uint256,address[]) also exists
// but some versions use getAmountOut(uint256,address,address)
const SOLIDLY_ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
  "function getAmountOut(uint256 amountIn, address tokenIn, address tokenOut) external view returns (uint256 amountOut)",
]);

const V3_QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)",
]);

const V3_QUOTERS: Record<number, Address> = {
  8453: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  42161: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
};

interface CallEntry {
  dex: DexConfig;
  tokenIn: TokenConfig;
  tokenOut: TokenConfig;
  amountIn: bigint;
}

/** Scale amount based on token decimals: $100 worth */
export function scaleAmount(token: TokenConfig, usdValue: number): bigint {
  // Approximate: for stablecoins 1 token ≈ $1, for others use raw
  const isStable = token.decimals === 6; // USDC, USDbC, EURC
  if (isStable) {
    return BigInt(Math.floor(usdValue)) * 10n ** BigInt(token.decimals);
  }
  // For 18-decimal tokens, treat usdValue as fraction of ETH
  return BigInt(Math.floor(usdValue * 1e6)) * 10n ** BigInt(token.decimals - 6);
}

/**
 * Batch all V2+V3+Solidly quotes into Multicall3.aggregate3() calls.
 */
export async function batchQuotesMulticall(
  client: PublicClient,
  chainCfg: ChainConfig,
  tokens: TokenConfig[],
  amountInWei: bigint, // base amount for 18-dec tokens
): Promise<Map<string, Quote[]>> {
  const calls: { target: Address; allowFailure: boolean; callData: `0x${string}` }[] = [];
  const meta: CallEntry[] = [];

  for (let i = 0; i < tokens.length; i++) {
    for (let j = 0; j < tokens.length; j++) {
      if (i === j) continue;
      const tokenIn = tokens[i];
      const tokenOut = tokens[j];

      // Scale amountIn based on tokenIn decimals
      const amountIn =
        tokenIn.decimals === 6
          ? amountInWei / 10n ** 12n // 0.1 ETH (18dec) -> 0.1 USDC-units (6dec)
          : amountInWei;

      for (const dex of chainCfg.dexes) {
        if (dex.type === "v2") {
          const callData = encodeFunctionData({
            abi: V2_ROUTER_ABI,
            functionName: "getAmountsOut",
            args: [amountIn, [tokenIn.address, tokenOut.address]],
          });
          calls.push({ target: dex.router, allowFailure: true, callData });
          meta.push({ dex, tokenIn, tokenOut, amountIn });
        } else if (dex.type === "solidly") {
          // Try getAmountsOut first (Aerodrome supports it)
          const callData = encodeFunctionData({
            abi: SOLIDLY_ROUTER_ABI,
            functionName: "getAmountsOut",
            args: [amountIn, [tokenIn.address, tokenOut.address]],
          });
          calls.push({ target: dex.router, allowFailure: true, callData });
          meta.push({ dex, tokenIn, tokenOut, amountIn });
        } else {
          // v3
          const quoter = V3_QUOTERS[chainCfg.id];
          if (!quoter) continue;
          const callData = encodeFunctionData({
            abi: V3_QUOTER_ABI,
            functionName: "quoteExactInputSingle",
            args: [tokenIn.address, tokenOut.address, (dex.fee || 3000) as 500 | 3000 | 10000, amountIn, 0n],
          });
          calls.push({ target: quoter, allowFailure: true, callData });
          meta.push({ dex, tokenIn, tokenOut, amountIn });
        }
      }
    }
  }

  if (calls.length === 0) return new Map();

  const CHUNK = 500;
  const quoteMap = new Map<string, Quote[]>();

  for (let c = 0; c < calls.length; c += CHUNK) {
    const chunkCalls = calls.slice(c, c + CHUNK);
    const chunkMeta = meta.slice(c, c + CHUNK);

    try {
      const results = await client.readContract({
        address: chainCfg.multicall3,
        abi: MULTICALL3_ABI,
        functionName: "aggregate3",
        args: [chunkCalls],
      }) as { success: boolean; returnData: `0x${string}` }[];

      for (let k = 0; k < results.length; k++) {
        const { success, returnData } = results[k];
        if (!success || returnData === "0x") continue;

        const entry = chunkMeta[k];
        const quote = decodeQuote(entry, returnData);
        if (!quote) continue;

        const key = `${entry.tokenIn.address}-${entry.tokenOut.address}`;
        const existing = quoteMap.get(key) || [];
        existing.push(quote);
        quoteMap.set(key, existing);
      }
    } catch {
      // chunk failed
    }
  }

  return quoteMap;
}

function decodeQuote(entry: CallEntry, returnData: `0x${string}`): Quote | null {
  try {
    if (entry.dex.type === "v2" || entry.dex.type === "solidly") {
      const amounts = decodeFunctionResult({
        abi: V2_ROUTER_ABI,
        functionName: "getAmountsOut",
        data: returnData,
      }) as bigint[];

      if (amounts.length < 2 || amounts[1] === 0n) return null;

      return {
        dex: entry.dex.name,
        tokenIn: entry.tokenIn.address,
        tokenOut: entry.tokenOut.address,
        amountIn: entry.amountIn,
        amountOut: amounts[1],
        pool: entry.dex.factory,
        feeBps: entry.dex.type === "solidly" ? 5 : 30, // Aerodrome volatile=0.05%, UniV2=0.3%
      };
    } else {
      const amountOut = decodeFunctionResult({
        abi: V3_QUOTER_ABI,
        functionName: "quoteExactInputSingle",
        data: returnData,
      }) as bigint;

      if (amountOut === 0n) return null;

      return {
        dex: entry.dex.name,
        tokenIn: entry.tokenIn.address,
        tokenOut: entry.tokenOut.address,
        amountIn: entry.amountIn,
        amountOut,
        pool: V3_QUOTERS[8453] || entry.dex.factory,
        feeBps: (entry.dex.fee || 3000) / 100,
      };
    }
  } catch {
    return null;
  }
}
