import {
  type PublicClient,
  type WalletClient,
  type Address,
  formatEther,
  parseAbi,
} from "viem";
import { type Position, type LiquidationResult, type ProtocolMonitor } from "./types.js";
import { withFallback, rateLimitedCall } from "../utils/rpc.js";

const POOL_ABI = parseAbi([
  "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external",
  "function getReservesList() external view returns (address[])",
]);

const BORROW_TOPIC = "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0" as `0x${string}`;

interface AaveConfig {
  chain: string;
  pool: Address;
}

const CONFIGS: AaveConfig[] = [
  { chain: "base", pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" },
  { chain: "arbitrum", pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" },
];

export class AaveMonitor implements ProtocolMonitor {
  name = "Aave V3";
  chain: string;
  private pool: Address;
  private knownBorrowers = new Set<string>();
  private lastBlock = 0n;

  constructor(config: AaveConfig) {
    this.chain = config.chain;
    this.pool = config.pool;
  }

  async scan(): Promise<Position[]> {
    return withFallback(this.chain, async (client) => {
      const block = await rateLimitedCall(() => client.getBlockNumber());

      // Discover new borrowers from events
      if (block > this.lastBlock) {
        const from = this.lastBlock === 0n ? block - 200n : this.lastBlock;
        try {
          const logs = await rateLimitedCall(() =>
            client.getLogs({
              address: this.pool,
              topics: [BORROW_TOPIC],
              fromBlock: from,
              toBlock: block,
            }),
          );
          for (const l of logs) {
            if (l.topics.length >= 3) {
              this.knownBorrowers.add("0x" + l.topics[2].slice(26));
            }
          }
        } catch { /* rate limited */ }
        this.lastBlock = block;
      }

      // Check health factors
      const positions: Position[] = [];
      const BATCH = 10;
      const users = [...this.knownBorrowers];

      for (let i = 0; i < users.length; i += BATCH) {
        const batch = users.slice(i, i + BATCH);
        const results = await Promise.allSettled(
          batch.map((addr) =>
            rateLimitedCall(() =>
              client.readContract({
                address: this.pool,
                abi: POOL_ABI,
                functionName: "getUserAccountData",
                args: [addr as Address],
              }),
            ),
          ),
        );

        for (let j = 0; j < results.length; j++) {
          const r = results[j];
          if (r.status !== "fulfilled") continue;

          const data = r.value as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
          const debtUsd = Number(data[1]) / 1e8;
          if (debtUsd < 100) continue;

          const hf = Number(formatEther(data[5]));
          positions.push({
            protocol: "Aave V3",
            chain: this.chain,
            user: users[j] as Address,
            collateralUsd: Number(data[0]) / 1e8,
            debtUsd,
            healthFactor: hf,
          });
        }
      }

      return positions;
    });
  }

  async liquidate(position: Position, walletClient: WalletClient): Promise<LiquidationResult> {
    try {
      const client = walletClient as unknown as { chain: unknown };
      // Determine assets — default to WETH/USDC (most common)
      const collateralAsset = position.collateralAsset ||
        (this.chain === "base"
          ? "0x4200000000000000000000000000000000000006"
          : "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
      const debtAsset = position.debtAsset ||
        (this.chain === "base"
          ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
          : "0xaf88d065e77c8cC2239327C5EDb3A432268e5831");

      const debtToCover = BigInt(Math.floor(position.debtUsd * 0.5)) * 10n ** 6n;

      const { request } = await (walletClient as any).publicClient.simulateContract({
        address: this.pool,
        abi: POOL_ABI,
        functionName: "liquidationCall",
        args: [collateralAsset, debtAsset, position.user, debtToCover, false],
        account: walletClient.account!,
      });

      const txHash = await (walletClient as any).writeContract(request);
      return { success: true, txHash, profitUsd: position.collateralUsd * 0.5 * 0.05 };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  get borrowerCount(): number {
    return this.knownBorrowers.size;
  }
}

export function createAaveMonitors(): AaveMonitor[] {
  return CONFIGS.map((c) => new AaveMonitor(c));
}
