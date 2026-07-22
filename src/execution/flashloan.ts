import {
  type PublicClient,
  type WalletClient,
  type Address,
  encodeFunctionData,
  parseAbi,
} from "viem";
import { type ArbOpportunity, type ExecutionResult } from "../types.js";
import { CONFIG, CHAINS } from "../config.js";
import { log } from "../logger.js";

const FLASH_ARB_ABI = parseAbi([
  "function executeArbitrage(address flashLoanPool, address token, uint256 amount, (address router, address[] path, uint256 minOut) swap1, (address router, address[] path, uint256 minOut) swap2) external",
]);

// Aave V3 Pool addresses per chain
const AAVE_V3_POOLS: Record<number, Address> = {
  8453: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", // Base
  42161: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // Arbitrum
};

// Deployed FlashArb contract address (set after deployment)
const FLASH_ARB_ADDRESS: Record<number, Address> = {
  // 8453: "0x...", // deploy and fill in
};

export class FlashLoanExecutor {
  constructor(
    private publicClient: PublicClient,
    private walletClient: WalletClient,
  ) {}

  private get account() {
    return this.walletClient.account!;
  }

  async execute(opp: ArbOpportunity): Promise<ExecutionResult> {
    const chainCfg = CHAINS[CONFIG.activeChain];
    const pool = AAVE_V3_POOLS[chainCfg.id];
    const flashArb = FLASH_ARB_ADDRESS[chainCfg.id];

    if (!pool) {
      return { success: false, error: `No Aave V3 pool for chain ${chainCfg.id}` };
    }
    if (!flashArb) {
      return { success: false, error: "FlashArb contract not deployed. Set FLASH_ARB_ADDRESS." };
    }

    try {
      const slippageBps = 50n;
      const minOut1 = opp.buyQuote.amountOut - (opp.buyQuote.amountOut * slippageBps) / 10000n;
      const minOut2 = opp.expectedOut - (opp.expectedOut * slippageBps) / 10000n;

      const data = encodeFunctionData({
        abi: FLASH_ARB_ABI,
        functionName: "executeArbitrage",
        args: [
          pool,
          opp.tokenIn,
          opp.amountIn,
          {
            router: this.getRouterAddress(opp.buyQuote.dex),
            path: [opp.buyQuote.tokenIn, opp.buyQuote.tokenOut],
            minOut: minOut1,
          },
          {
            router: this.getRouterAddress(opp.sellQuote.dex),
            path: [opp.sellQuote.tokenIn, opp.sellQuote.tokenOut],
            minOut: minOut2,
          },
        ],
      });

      log.info(`Flash arb: ${opp.buyQuote.dex} -> ${opp.sellQuote.dex}, amount=${opp.amountIn}`);

      const txHash = await this.walletClient.sendTransaction({
        account: this.account,
        chain: null,
        to: flashArb,
        data,
      });

      log.info(`Flash arb tx sent: ${txHash}`);
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status !== "success") {
        return { success: false, txHash, error: "Flash arb tx reverted" };
      }

      return {
        success: true,
        txHash,
        gasUsed: receipt.gasUsed,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private getRouterAddress(dexName: string): Address {
    const chain = CHAINS[CONFIG.activeChain];
    const dex = chain.dexes.find((d) => d.name === dexName);
    if (!dex) throw new Error(`Unknown DEX: ${dexName}`);
    return dex.router;
  }
}
