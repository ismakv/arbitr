import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, arbitrum } from "viem/chains";
import { CONFIG, CHAINS } from "./config.js";

const chainMap: Record<string, Chain> = {
  base,
  arbitrum,
};

export function getChain(): Chain {
  const c = chainMap[CONFIG.activeChain];
  if (!c) throw new Error(`Unknown chain: ${CONFIG.activeChain}`);
  return c;
}

export function createClients(): {
  publicClient: PublicClient;
  walletClient: WalletClient | null;
} {
  const chainCfg = CHAINS[CONFIG.activeChain];
  const chain = getChain();

  const transport: Transport = chainCfg.rpcWss
    ? webSocket(chainCfg.rpcWss)
    : http(chainCfg.rpcHttps);

  const publicClient = createPublicClient({
    chain,
    transport,
  }) as PublicClient;

  let walletClient: WalletClient | null = null;
  if (CONFIG.privateKey) {
    const account = privateKeyToAccount(CONFIG.privateKey as `0x${string}`);
    walletClient = createWalletClient({
      account,
      chain,
      transport,
    });
  }

  return { publicClient, walletClient };
}
