import { parseEther, formatEther } from "viem";
import { CONFIG, CHAINS } from "./config.js";
import { createClients } from "./providers.js";
import { batchQuotesMulticall } from "./dex/multicall.js";
import { scanOpportunities } from "./strategy/arbitrage.js";
import { Executor } from "./executor.js";
import { FlashLoanExecutor } from "./execution/flashloan.js";
import { MempoolMonitor } from "./mempool/monitor.js";
import { evaluateBackrun } from "./mempool/backrun.js";
import { log } from "./logger.js";
import { type ArbOpportunity } from "./types.js";

async function getGasCostWei(gasPriceFallback: bigint): Promise<bigint> {
  const { publicClient } = createClients();
  try {
    const gasPrice = await publicClient.getGasPrice();
    return gasPrice * 300_000n; // ~300k gas for 2-swap arb
  } catch {
    return gasPriceFallback;
  }
}

async function getNativePriceUsd(): Promise<number> {
  // TODO: Chainlink oracle or CoinGecko
  const prices: Record<string, number> = { base: 3200, arbitrum: 3200 };
  return prices[CONFIG.activeChain] || 3000;
}

async function runPollCycle(
  executor: Executor | FlashLoanExecutor | null,
): Promise<void> {
  const chainCfg = CHAINS[CONFIG.activeChain];
  if (!chainCfg) {
    log.error(`Chain config not found: ${CONFIG.activeChain}`);
    return;
  }

  const { publicClient } = createClients();
  const amountIn = parseEther(CONFIG.tradeAmountEth.toString());

  log.debug(
    `Poll: ${chainCfg.name} — ${chainCfg.tokens.length} tokens × ${chainCfg.dexes.length} DEXes (multicall)`,
  );

  const quoteMap = await batchQuotesMulticall(
    publicClient,
    chainCfg,
    chainCfg.tokens,
    amountIn,
  );

  const totalQuotes = [...quoteMap.values()].reduce((s, q) => s + q.length, 0);
  log.debug(`Poll: ${quoteMap.size} pairs, ${totalQuotes} quotes`);

  const gasCostWei = await getGasCostWei(parseEther("0.015"));
  const nativePriceUsd = await getNativePriceUsd();

  const tokenAddresses = chainCfg.tokens.map((t) => t.address);
  const opportunities = scanOpportunities(
    quoteMap,
    tokenAddresses,
    gasCostWei,
    nativePriceUsd,
  );

  if (opportunities.length === 0) {
    log.debug("Poll: no opportunities");
    return;
  }

  log.info(`Poll: ${opportunities.length} opportunities found`);
  for (const opp of opportunities.slice(0, 3)) {
    log.info(
      `  ${opp.id}: ${opp.buyQuote.dex}→${opp.sellQuote.dex} | ` +
      `profit $${opp.profitUsd.toFixed(2)} (${formatEther(opp.netProfitWei)} ETH)`,
    );
  }

  if (executor) {
    const best = opportunities[0];
    log.info(`Executing: ${best.id} ($${best.profitUsd.toFixed(2)})`);

    const result =
      executor instanceof FlashLoanExecutor
        ? await executor.execute(best)
        : await executor.executeDirect(best);

    if (result.success) {
      log.info(`SUCCESS tx=${result.txHash} gas=${result.gasUsed}`);
    } else {
      log.error(`FAILED: ${result.error}`);
    }
  }
}

function startMempoolMonitor(
  executor: Executor | FlashLoanExecutor | null,
): MempoolMonitor | null {
  const chainCfg = CHAINS[CONFIG.activeChain];
  const { publicClient } = createClients();

  // Mempool requires WebSocket
  if (!chainCfg.rpcWss) {
    log.warn("No WSS RPC configured — mempool monitor disabled");
    return null;
  }

  const monitor = new MempoolMonitor(publicClient, chainCfg, parseEther("1"));

  monitor.onSwap(async (swap) => {
    try {
      const gasCostWei = await getGasCostWei(parseEther("0.015"));
      const nativePriceUsd = await getNativePriceUsd();

      const opp = await evaluateBackrun(
        publicClient,
        chainCfg,
        swap,
        nativePriceUsd,
        gasCostWei,
        CONFIG.minProfitUsd,
      );

      if (!opp) return;

      log.info(
        `Mempool backrun: ${opp.buyQuote.dex}→${opp.sellQuote.dex} | ` +
        `$${opp.profitUsd.toFixed(2)} | triggered by ${swap.hash.slice(0, 14)}...`,
      );

      if (executor) {
        const result =
          executor instanceof FlashLoanExecutor
            ? await executor.execute(opp)
            : await executor.executeDirect(opp);

        if (result.success) {
          log.info(`BACKRUN SUCCESS tx=${result.txHash}`);
        } else {
          log.error(`BACKRUN FAILED: ${result.error}`);
        }
      }
    } catch (err) {
      log.error(`Backrun eval error: ${err instanceof Error ? err.message : err}`);
    }
  });

  monitor.start();
  return monitor;
}

async function main() {
  log.info("═══════════════════════════════════════");
  log.info("  Arbitr Bot v0.1.0");
  log.info("═══════════════════════════════════════");
  log.info(`Chain:    ${CONFIG.activeChain}`);
  log.info(`Mode:     ${CONFIG.executionMode}`);
  log.info(`Min prof: $${CONFIG.minProfitUsd}`);
  log.info(`Interval: ${CONFIG.pollIntervalMs}ms`);
  log.info(`Amount:   ${CONFIG.tradeAmountEth} ETH`);

  const { publicClient, walletClient } = createClients();

  let executor: Executor | FlashLoanExecutor | null = null;
  if (walletClient) {
    if (CONFIG.executionMode === "flashloan") {
      executor = new FlashLoanExecutor(publicClient, walletClient);
      log.info(`FlashLoan executor: ${walletClient.account!.address}`);
    } else {
      executor = new Executor(publicClient, walletClient);
      log.info(`Direct executor: ${walletClient.account!.address}`);
    }
  } else {
    log.warn("No PRIVATE_KEY — monitor-only mode (no execution)");
  }

  // Start mempool monitor (requires WSS)
  const mempoolMonitor = startMempoolMonitor(executor);

  // Main poll loop
  const loop = async () => {
    try {
      await runPollCycle(executor);
    } catch (err) {
      log.error(`Poll error: ${err instanceof Error ? err.message : err}`);
    }
    setTimeout(loop, CONFIG.pollIntervalMs);
  };

  await loop();
}

main().catch((err) => {
  log.error(`Fatal: ${err}`);
  process.exit(1);
});
