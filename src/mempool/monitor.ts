import {
  type PublicClient,
  type Address,
  decodeFunctionData,
  parseAbi,
  formatEther,
} from "viem";
import { type ChainConfig, type DexConfig } from "../config.js";
import { log } from "../logger.js";

const SWAP_ABI = parseAbi([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) external returns (uint256[] memory)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) external payable returns (uint256[] memory)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) external returns (uint256[] memory)",
  "function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data) external",
]);

export interface PendingSwap {
  hash: `0x${string}`;
  from: Address;
  dex: string;
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  functionName: string;
}

export type SwapCallback = (swap: PendingSwap) => void;

export class MempoolMonitor {
  private unwatch: (() => void) | null = null;
  private routerSet: Map<string, DexConfig>;
  private callbacks: SwapCallback[] = [];

  constructor(
    private client: PublicClient,
    private chainCfg: ChainConfig,
    private minAmountEth: bigint = 1_000_000_000_000_000_000n, // 1 ETH minimum to care
  ) {
    this.routerSet = new Map(
      chainCfg.dexes.map((d) => [d.router.toLowerCase(), d]),
    );
  }

  onSwap(cb: SwapCallback) {
    this.callbacks.push(cb);
  }

  start() {
    log.info("Mempool monitor: subscribing to pending transactions...");

    this.unwatch = this.client.watchPendingTransactions({
      onTransactions: (hashes) => {
        for (const hash of hashes) {
          this.processTx(hash).catch(() => {});
        }
      },
    });

    log.info("Mempool monitor: active");
  }

  stop() {
    if (this.unwatch) {
      this.unwatch();
      this.unwatch = null;
      log.info("Mempool monitor: stopped");
    }
  }

  private async processTx(hash: `0x${string}`) {
    try {
      const tx = await this.client.getTransaction({ hash });
      if (!tx || !tx.to) return;

      const toLower = tx.to.toLowerCase();
      const dex = this.routerSet.get(toLower);
      if (!dex) return; // not a known router

      if (!tx.input || tx.input === "0x") return;

      const decoded = this.tryDecodeSwap(tx.input);
      if (!decoded) return;

      const { tokenIn, tokenOut, amountIn, functionName } = decoded;

      // Filter: only care about swaps involving our monitored tokens
      const tokenSet = new Set(this.chainCfg.tokens.map((t) => t.address.toLowerCase()));
      if (!tokenSet.has(tokenIn.toLowerCase()) && !tokenSet.has(tokenOut.toLowerCase())) {
        return;
      }

      // Filter: minimum size
      if (amountIn < this.minAmountEth) return;

      const swap: PendingSwap = {
        hash,
        from: tx.from,
        dex: dex.name,
        router: tx.to,
        tokenIn,
        tokenOut,
        amountIn,
        functionName,
      };

      log.info(
        `Mempool: ${dex.name} swap detected | ${functionName} | ` +
        `${tokenIn.slice(0, 10)}→${tokenOut.slice(0, 10)} | ` +
        `${formatEther(amountIn)} | tx=${hash.slice(0, 14)}...`,
      );

      for (const cb of this.callbacks) {
        cb(swap);
      }
    } catch {
      // Tx dropped or not accessible — ignore
    }
  }

  private tryDecodeSwap(input: `0x${string}`): {
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    functionName: string;
  } | null {
    try {
      const { functionName, args } = decodeFunctionData({
        abi: SWAP_ABI,
        data: input,
      });

      switch (functionName) {
        case "swapExactTokensForTokens": {
          const [amountIn, , path] = args as unknown as [bigint, bigint, Address[]];
          if (path.length < 2) return null;
          return {
            tokenIn: path[0],
            tokenOut: path[path.length - 1],
            amountIn,
            functionName,
          };
        }
        case "swapExactTokensForETH": {
          const [amountIn, , path] = args as unknown as [bigint, bigint, Address[]];
          if (path.length < 2) return null;
          return {
            tokenIn: path[0],
            tokenOut: path[path.length - 1],
            amountIn,
            functionName,
          };
        }
        case "swapExactETHForTokens": {
          const [, path] = args as unknown as [bigint, Address[]];
          if (path.length < 2) return null;
          return {
            tokenIn: path[0], // WETH
            tokenOut: path[path.length - 1],
            amountIn: 0n, // ETH amount is in tx.value, not decoded here
            functionName,
          };
        }
        default:
          return null;
      }
    } catch {
      return null;
    }
  }
}
