import { type PublicClient, formatEther } from "viem";
import { rateLimitedCall } from "./rpc.js";

const NATIVE_PRICES_USD: Record<string, number> = {
  base: 1940,
  arbitrum: 1940,
};

export async function getGasCostUsd(
  client: PublicClient,
  chainName: string,
  gasUnits: bigint = 300_000n,
): Promise<number> {
  try {
    const gasPrice = await rateLimitedCall(() => client.getGasPrice());
    const gasCostNative = Number(formatEther(gasPrice * gasUnits));
    const nativePrice = NATIVE_PRICES_USD[chainName] || 2000;
    return gasCostNative * nativePrice;
  } catch {
    return 1.0; // fallback: assume $1 gas cost
  }
}

export function isProfitable(
  bonusUsd: number,
  gasCostUsd: number,
  minProfitUsd: number = 5,
): boolean {
  return bonusUsd - gasCostUsd > minProfitUsd;
}

export function estimateLiquidationProfit(
  collateralUsd: number,
  bonusPct: number = 0.05,
  closeFactor: number = 0.5,
): number {
  return collateralUsd * closeFactor * bonusPct;
}
