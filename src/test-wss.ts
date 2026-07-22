import { createPublicClient, webSocket } from "viem";
import { base } from "viem/chains";

const WSS = "wss://base-mainnet.infura.io/ws/v3/04f5929ddb2743528c1eaf8265f0ea31";

async function main() {
  console.log("=== WSS Pending TX Test (15s) ===");

  const client = createPublicClient({
    chain: base,
    transport: webSocket(WSS),
  });

  let count = 0;
  const unwatch = client.watchPendingTransactions({
    onTransactions: (hashes) => {
      count += hashes.length;
      if (count <= 5) {
        console.log(`  tx: ${hashes[0]} (+${hashes.length - 1} more)`);
      }
    },
  });

  console.log("Subscribed. Counting all pending txs for 15s...");
  await new Promise((r) => setTimeout(r, 15_000));
  unwatch();

  console.log(`\nTotal pending txs seen: ${count}`);
  if (count === 0) {
    console.log("⚠️  Infura free tier likely doesn't stream pending txs on Base.");
    console.log("   Base blocks are ~2s — mempool window is tiny.");
    console.log("   Options: use poll-based strategy, or try Arbitrum (slower blocks).");
  } else {
    console.log("✅ Mempool stream works!");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
