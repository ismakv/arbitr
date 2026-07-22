import {
  type PublicClient,
  type WalletClient,
  type Address,
  encodeFunctionData,
  parseAbi,
} from "viem";
import { type ArbOpportunity, type ExecutionResult } from "./types.js";
import { CONFIG, CHAINS } from "./config.js";
import { log } from "./logger.js";

const V2_ROUTER_ABI = parseAbi([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external payable returns (uint256[] memory amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts)",
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
]);

export class Executor {
  constructor(
    private publicClient: PublicClient,
    private walletClient: WalletClient,
  ) {}

  private get account() {
    return this.walletClient.account!;
  }

  async executeDirect(opp: ArbOpportunity): Promise<ExecutionResult> {
    try {
      const { buyQuote, sellQuote } = opp;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
      const slippageBps = 50n; // 0.5%
      const minOutBuy = buyQuote.amountOut - (buyQuote.amountOut * slippageBps) / 10000n;
      const minOutSell = sellQuote.amountOut - (sellQuote.amountOut * slippageBps) / 10000n;

      // Step 1: Ensure token approval for buy router
      await this.ensureApproval(buyQuote.tokenIn, this.getRouterAddress(buyQuote.dex), buyQuote.amountIn);

      // Step 2: Execute buy (tokenIn -> tokenOut i.e. mid token)
      log.info(`Executing buy: ${buyQuote.dex} ${buyQuote.tokenIn} -> ${buyQuote.tokenOut}`);

      const buyData = encodeFunctionData({
        abi: V2_ROUTER_ABI,
        functionName: "swapExactTokensForTokens",
        args: [
          buyQuote.amountIn,
          minOutBuy,
          [buyQuote.tokenIn, buyQuote.tokenOut],
          this.account.address,
          deadline,
        ],
      });

      const buyTxHash = await this.walletClient.sendTransaction({
        account: this.account,
        chain: null,
        to: this.getRouterAddress(buyQuote.dex),
        data: buyData,
        value: 0n,
      });

      log.info(`Buy tx sent: ${buyTxHash}`);
      const buyReceipt = await this.publicClient.waitForTransactionReceipt({ hash: buyTxHash });
      if (buyReceipt.status !== "success") {
        return { success: false, txHash: buyTxHash, error: "Buy tx reverted" };
      }

      // Step 3: Approve + sell (mid token -> tokenIn)
      const midToken = buyQuote.tokenOut;
      const midBalance = await this.getTokenBalance(midToken);
      await this.ensureApproval(midToken, this.getRouterAddress(sellQuote.dex), midBalance);

      log.info(`Executing sell: ${sellQuote.dex} ${sellQuote.tokenIn} -> ${sellQuote.tokenOut}`);

      const sellData = encodeFunctionData({
        abi: V2_ROUTER_ABI,
        functionName: "swapExactTokensForTokens",
        args: [
          midBalance,
          minOutSell,
          [sellQuote.tokenIn, sellQuote.tokenOut],
          this.account.address,
          deadline,
        ],
      });

      const sellTxHash = await this.walletClient.sendTransaction({
        account: this.account,
        chain: null,
        to: this.getRouterAddress(sellQuote.dex),
        data: sellData,
        value: 0n,
      });

      log.info(`Sell tx sent: ${sellTxHash}`);
      const sellReceipt = await this.publicClient.waitForTransactionReceipt({ hash: sellTxHash });

      if (sellReceipt.status !== "success") {
        return { success: false, txHash: sellTxHash, error: "Sell tx reverted" };
      }

      const totalGas = buyReceipt.gasUsed + sellReceipt.gasUsed;
      return {
        success: true,
        txHash: sellTxHash,
        gasUsed: totalGas,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async ensureApproval(token: Address, spender: Address, amount: bigint) {
    const allowance = (await this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [this.account.address, spender],
    })) as bigint;

    if (allowance >= amount) return;

    log.info(`Approving ${token} for ${spender}`);
    const approveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender, amount * 2n],
    });

    const hash = await this.walletClient.sendTransaction({
      account: this.account,
      chain: null,
      to: token,
      data: approveData,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
  }

  private async getTokenBalance(token: Address): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [this.account.address],
    })) as bigint;
  }

  private getRouterAddress(dexName: string): Address {
    const chain = CHAINS[CONFIG.activeChain];
    const dex = chain.dexes.find((d) => d.name === dexName);
    if (!dex) throw new Error(`Unknown DEX: ${dexName}`);
    return dex.router;
  }
}
