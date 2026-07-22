import { type Address } from "viem";

export interface Quote {
  dex: string;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  pool: Address;
  feeBps: number;
}

export interface ArbOpportunity {
  id: string;
  buyQuote: Quote;
  sellQuote: Quote;
  tokenIn: Address;
  tokenMid: Address;
  amountIn: bigint;
  expectedOut: bigint;
  profitWei: bigint;
  profitUsd: number;
  gasCostWei: bigint;
  netProfitWei: bigint;
  timestamp: number;
}

export interface ExecutionResult {
  success: boolean;
  txHash?: `0x${string}`;
  error?: string;
  gasUsed?: bigint;
  actualProfitWei?: bigint;
}
