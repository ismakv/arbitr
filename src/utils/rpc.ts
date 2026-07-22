import { createPublicClient, http, type PublicClient, type Chain } from "viem";
import { base, arbitrum } from "viem/chains";

const INFURA_KEY = process.env.INFURA_KEY || "04f5929ddb2743528c1eaf8265f0ea31";

const RPC_ENDPOINTS: Record<string, string[]> = {
  base: [
    process.env.BASE_RPC_HTTPS || "https://mainnet.base.org",
    `https://base-mainnet.infura.io/v3/${INFURA_KEY}`,
    "https://base.drpc.org",
    "https://1rpc.io/base",
  ],
  arbitrum: [
    process.env.ARBITRUM_RPC_HTTPS || "https://arb1.arbitrum.io/rpc",
    `https://arbitrum-mainnet.infura.io/v3/${INFURA_KEY}`,
    "https://arbitrum.drpc.org",
    "https://1rpc.io/arb",
  ],
};

const CHAIN_MAP: Record<string, Chain> = { base, arbitrum };

const clients: Map<string, { client: PublicClient; endpointIdx: number }> = new Map();
let lastRequestTime = 0;
const MIN_INTERVAL_MS = 200; // rate limit: max 5 req/s per endpoint

export async function getClient(chainName: string): Promise<PublicClient> {
  const existing = clients.get(chainName);
  if (existing) return existing.client;

  const endpoints = RPC_ENDPOINTS[chainName];
  const chain = CHAIN_MAP[chainName];
  if (!endpoints || !chain) throw new Error(`Unknown chain: ${chainName}`);

  const client = createPublicClient({
    chain,
    transport: http(endpoints[0]),
  }) as PublicClient;

  clients.set(chainName, { client, endpointIdx: 0 });
  return client;
}

export async function rateLimitedCall<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastRequestTime));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestTime = Date.now();
  return fn();
}

export async function withFallback<T>(
  chainName: string,
  fn: (client: PublicClient) => Promise<T>,
): Promise<T> {
  const endpoints = RPC_ENDPOINTS[chainName];
  const chain = CHAIN_MAP[chainName];
  let lastErr: Error | null = null;

  for (const endpoint of endpoints) {
    try {
      const client = createPublicClient({ chain, transport: http(endpoint) }) as PublicClient;
      return await fn(client);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      continue;
    }
  }

  throw lastErr || new Error(`All RPC endpoints failed for ${chainName}`);
}
