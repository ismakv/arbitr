import { CHAINS } from "./config.js";
import { createClients } from "./providers.js";
import { MempoolMonitor } from "./mempool/monitor.js";
import { parseEther } from "viem";

async function main() {
  console.log("=== Mempool Test (30s) ===");
  const chainCfg = CHAINS["base"];
  const { publicClient } = createClients();

  const monitor = new MempoolMonitor(publicClient, chainCfg, parseEther("0.5"));
  let count = 0;

  monitor.onSwap((swap) => {
    count++;
    console.log(`#${count} ${swap.dex} | ${swap.functionName} | amount=${swap.amountIn}`);
  });

  monitor.start();
  console.log("Listening for pending swaps... (30s)");

  await new Promise((r) => setTimeout(r, 30_000));
  monitor.stop();
  console.log(`\nTotal swaps detected: ${count}`);
  console.log("=== Done ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
