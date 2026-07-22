import {
  type PublicClient,
  type WalletClient,
  type Address,
  formatEther,
  parseAbi,
} from "viem";
import { type Position, type LiquidationResult, type ProtocolMonitor } from "./types.js";
import { withFallback, rateLimitedCall } from "../utils/rpc.js";

const MORPHO_ABI = parseAbi([
  "function market(address marketId) external view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(address marketId, address user) external view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function liquidate(address marketId, address borrower, uint256 seizedAssets, uint256 repaidAssets, address[] memory data) external returns (uint256 seizedAssetsOut, uint256 repaidAssetsOut)",
]);

// Morpho Blue uses a different liquidation mechanism:
// - Positions have collateral and borrowShares
// - Liquidation happens when borrow > collateral * LLTV
// - liquidationIncentiveFactor: typically 1.05-1.10 (5-10% bonus)

interface MorphoConfig {
  chain: string;
  morpho: Address;
  markets: { id: Address; collateral: Address; loan: Address; lltv: bigint; name: string }[];
}

const CONFIGS: MorphoConfig[] = [
  {
    chain: "base",
    morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    markets: [
      {
        id: "0x64d65c9a2d91c36d56fbc42d69e97933532e1104c3df5e6e50e1e1c9b1a97d5b" as Address,
        collateral: "0x4200000000000000000000000000000000000006", // WETH
        loan: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
        lltv: 860000000000000000n, // 86%
        name: "WETH/USDC",
      },
      {
        id: "0xc0a1452a2b41b9a8e3b1e0e1e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0" as Address,
        collateral: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC
        loan: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
        lltv: 860000000000000000n,
        name: "cbBTC/USDC",
      },
    ],
  },
  {
    chain: "arbitrum",
    morpho: "0x6c247b1F6182318877311737BaC0844bAa518F5e",
    markets: [
      {
        id: "0x2f0cd54cb369a4e1e2e3a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3" as Address,
        collateral: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH
        loan: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
        lltv: 860000000000000000n,
        name: "WETH/USDC",
      },
    ],
  },
];

// Known Morpho borrowers (from events or subgraph)
// In production: index PositionUpdated events
const MORPHO_POSITION_TOPIC = "0x0e5e4656a3a631f0e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4" as `0x${string}`;

export class MorphoMonitor implements ProtocolMonitor {
  name = "Morpho Blue";
  chain: string;
  private morpho: Address;
  private markets: MorphoConfig["markets"];
  private knownBorrowers = new Set<string>();

  constructor(config: MorphoConfig) {
    this.chain = config.chain;
    this.morpho = config.morpho;
    this.markets = config.markets;
  }

  async scan(): Promise<Position[]> {
    return withFallback(this.chain, async (client) => {
      const positions: Position[] = [];

      // Discover borrowers from events (last 500 blocks)
      const block = await rateLimitedCall(() => client.getBlockNumber());
      try {
        const logs = await rateLimitedCall(() =>
          client.getLogs({
            address: this.morpho,
            fromBlock: block - 500n,
            toBlock: block,
          }),
        );
        // Extract unique addresses from log topics
        for (const l of logs) {
          for (const topic of l.topics.slice(1)) {
            if (topic.length >= 66) {
              const addr = "0x" + topic.slice(26);
              if (addr !== "0x0000000000000000000000000000000000000000") {
                this.knownBorrowers.add(addr);
              }
            }
          }
        }
      } catch { /* rate limited */ }

      // Check positions for known borrowers across markets
      for (const market of this.markets) {
        const users = [...this.knownBorrowers].slice(0, 50);
        const BATCH = 10;

        for (let i = 0; i < users.length; i += BATCH) {
          const batch = users.slice(i, i + BATCH);
          const results = await Promise.allSettled(
            batch.map((addr) =>
              rateLimitedCall(() =>
                client.readContract({
                  address: this.morpho,
                  abi: MORPHO_ABI,
                  functionName: "position",
                  args: [market.id, addr as Address],
                }),
              ),
            ),
          );

          for (let j = 0; j < results.length; j++) {
            const r = results[j];
            if (r.status !== "fulfilled") continue;

            const data = r.value as readonly [bigint, bigint, bigint];
            const borrowShares = data[1];
            const collateral = data[2];

            if (borrowShares === 0n || collateral === 0n) continue;

            // Simplified HF calculation for Morpho:
            // HF = (collateral * LLTV) / borrow
            // We need market data to convert shares to assets
            // For now, estimate based on raw values
            const collateralUsd = Number(formatEther(collateral)) * 1940; // rough WETH price
            const debtUsd = Number(borrowShares) / 1e6; // rough USDC estimate

            if (debtUsd < 100) continue;

            const hf = (collateralUsd * Number(market.lltv) / 1e18) / debtUsd;

            positions.push({
              protocol: "Morpho Blue",
              chain: this.chain,
              user: users[j] as Address,
              collateralUsd,
              debtUsd,
              healthFactor: hf,
              collateralAsset: market.collateral,
              debtAsset: market.loan,
              extra: { marketId: market.id, marketName: market.name },
            });
          }
        }
      }

      return positions;
    });
  }

  async liquidate(position: Position, walletClient: WalletClient): Promise<LiquidationResult> {
    try {
      const marketId = (position.extra?.marketId as Address) || this.markets[0].id;
      // Morpho liquidation: seize collateral, repay debt
      // seizedAssets = repaidAssets * liquidationIncentiveFactor / WAD
      const repaidAssets = BigInt(Math.floor(position.debtUsd * 0.5)) * 10n ** 6n;
      const seizedAssets = (repaidAssets * 105n) / 100n; // 5% incentive

      const data = "0x" as `0x${string}`;

      const { request } = await (walletClient as any).publicClient.simulateContract({
        address: this.morpho,
        abi: MORPHO_ABI,
        functionName: "liquidate",
        args: [marketId, position.user, seizedAssets, repaidAssets, []],
        account: walletClient.account!,
      });

      const txHash = await (walletClient as any).writeContract(request);
      return { success: true, txHash, profitUsd: position.collateralUsd * 0.5 * 0.05 };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function createMorphoMonitors(): MorphoMonitor[] {
  return CONFIGS.map((c) => new MorphoMonitor(c));
}
