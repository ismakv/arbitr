import { type Address, type PublicClient, type WalletClient } from "viem";

export interface Position {
  protocol: string;
  chain: string;
  user: Address;
  collateralUsd: number;
  debtUsd: number;
  healthFactor: number;
  collateralAsset?: Address;
  debtAsset?: Address;
  extra?: Record<string, unknown>;
}

export interface LiquidationResult {
  success: boolean;
  txHash?: `0x${string}`;
  error?: string;
  gasUsed?: bigint;
  profitUsd?: number;
}

export interface ProtocolMonitor {
  name: string;
  chain: string;
  scan(): Promise<Position[]>;
  liquidate(position: Position, walletClient: WalletClient): Promise<LiquidationResult>;
}

export interface ChainRpcConfig {
  chain: string;
  chainId: number;
  endpoints: string[];
}
