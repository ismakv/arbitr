import {
  type PublicClient,
  type WalletClient,
  type Address,
  formatEther,
  parseAbi,
} from "viem";
import { type Position, type LiquidationResult, type ProtocolMonitor } from "./types.js";
import { withFallback, rateLimitedCall } from "../utils/rpc.js";

const COMET_ABI = parseAbi([
  "function isLiquidatable(address account) external view returns (bool)",
  "function userBasic(address account) external view returns (int104 principal, uint64 baseTrackingIndex, uint64 baseTrackingAccrued, uint16 assetsIn, uint8 _reserved)",
  "function userCollateral(address account, address asset) external view returns (uint128 balance, uint128 _reserved)",
  "function absorb(address absorber, address[] calldata accounts) external",
  "function numAssets() external view returns (uint8)",
  "function getAssetInfo(uint8 i) external view returns (uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap)",
  "function totalsBasic() external view returns (uint64 baseSupplyIndex, uint64 baseBorrowIndex, uint64 trackingSupplyIndex, uint64 trackingBorrowIndex, uint104 totalSupplyBase, uint104 totalBorrowBase, uint40 lastAccrualTime, uint8 pauseFlags)",
  "function baseToken() external view returns (address)",
]);

interface CompoundConfig {
  chain: string;
  comet: Address;
  name: string;
}

const CONFIGS: CompoundConfig[] = [
  { chain: "base", comet: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", name: "Compound V3 USDC" },
  { chain: "arbitrum", comet: "0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA", name: "Compound V3 USDC" },
];

// Compound V3 liquidation:
// - absorb(absorber, accounts[]) — absorbs underwater positions
// - Absorber gets collateral at liquidationFactor discount (typically 5-8%)
// - No flash loan needed — protocol socializes the loss

export class CompoundMonitor implements ProtocolMonitor {
  name = "Compound V3";
  chain: string;
  private comet: Address;
  private cometName: string;
  private knownBorrowers = new Set<string>();
  private collateralAssets: Address[] = [];

  constructor(config: CompoundConfig) {
    this.chain = config.chain;
    this.comet = config.comet;
    this.cometName = config.name;
  }

  async scan(): Promise<Position[]> {
    return withFallback(this.chain, async (client) => {
      // Discover collateral assets
      if (this.collateralAssets.length === 0) {
        try {
          const numAssets = await rateLimitedCall(() =>
            client.readContract({
              address: this.comet,
              abi: COMET_ABI,
              functionName: "numAssets",
            }),
          ) as number;

          for (let i = 0; i < Number(numAssets); i++) {
            const info = await rateLimitedCall(() =>
              client.readContract({
                address: this.comet,
                abi: COMET_ABI,
                functionName: "getAssetInfo",
                args: [i],
              }),
            ) as readonly [bigint, Address, Address, bigint, bigint, bigint, bigint, bigint];
            this.collateralAssets.push(info[1]);
          }
        } catch { /* ok */ }
      }

      // Discover borrowers from Absorb/AbsorbDebt events or Transfer events
      const block = await rateLimitedCall(() => client.getBlockNumber());
      try {
        const logs = await rateLimitedCall(() =>
          client.getLogs({
            address: this.comet,
            fromBlock: block - 500n,
            toBlock: block,
          }),
        );
        for (const l of logs) {
          for (const topic of l.topics.slice(1, 3)) {
            if (topic && topic.length >= 66) {
              const addr = "0x" + topic.slice(26);
              if (addr !== "0x0000000000000000000000000000000000000000") {
                this.knownBorrowers.add(addr);
              }
            }
          }
        }
      } catch { /* rate limited */ }

      // Check isLiquidatable for known users
      const positions: Position[] = [];
      const users = [...this.knownBorrowers].slice(0, 100);
      const BATCH = 10;

      for (let i = 0; i < users.length; i += BATCH) {
        const batch = users.slice(i, i + BATCH);
        const results = await Promise.allSettled(
          batch.map((addr) =>
            rateLimitedCall(() =>
              client.readContract({
                address: this.comet,
                abi: COMET_ABI,
                functionName: "isLiquidatable",
                args: [addr as Address],
              }),
            ),
          ),
        );

        for (let j = 0; j < results.length; j++) {
          const r = results[j];
          if (r.status !== "fulfilled" || r.value !== true) continue;

          // User is liquidatable! Get their collateral info
          let totalCollateralUsd = 0;
          for (const asset of this.collateralAssets.slice(0, 3)) {
            try {
              const coll = await rateLimitedCall(() =>
                client.readContract({
                  address: this.comet,
                  abi: COMET_ABI,
                  functionName: "userCollateral",
                  args: [users[j] as Address, asset],
                }),
              ) as readonly [bigint, bigint];
              // Rough USD estimate (assumes 18-dec collateral ~$1940 for WETH)
              totalCollateralUsd += Number(formatEther(coll[0])) * 1940;
            } catch { /* skip */ }
          }

          positions.push({
            protocol: "Compound V3",
            chain: this.chain,
            user: users[j] as Address,
            collateralUsd: totalCollateralUsd,
            debtUsd: 0, // Compound V3 socializes debt
            healthFactor: 0.99, // isLiquidatable = true means HF < 1
            extra: { comet: this.comet },
          });
        }
      }

      return positions;
    });
  }

  async liquidate(position: Position, walletClient: WalletClient): Promise<LiquidationResult> {
    try {
      const comet = (position.extra?.comet as Address) || this.comet;

      const { request } = await (walletClient as any).publicClient.simulateContract({
        address: comet,
        abi: COMET_ABI,
        functionName: "absorb",
        args: [walletClient.account!.address, [position.user]],
        account: walletClient.account!,
      });

      const txHash = await (walletClient as any).writeContract(request);
      // Compound absorb profit ≈ liquidationFactor discount on collateral (5-8%)
      return { success: true, txHash, profitUsd: position.collateralUsd * 0.06 };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function createCompoundMonitors(): CompoundMonitor[] {
  return CONFIGS.map((c) => new CompoundMonitor(c));
}
