import "dotenv/config";
import { type Address } from "viem";

export interface TokenConfig {
  address: Address;
  symbol: string;
  decimals: number;
}

export interface DexConfig {
  name: string;
  type: "v2" | "v3" | "solidly";
  router: Address;
  factory: Address;
  fee?: number; // v3 pool fee in bps (500 = 0.05%, 3000 = 0.3%)
}

export interface ChainConfig {
  id: number;
  name: string;
  rpcHttps: string;
  rpcWss?: string;
  nativeSymbol: string;
  wrappedNative: Address;
  multicall3: Address;
  dexes: DexConfig[];
  tokens: TokenConfig[];
}

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

export const CHAINS: Record<string, ChainConfig> = {
  base: {
    id: 8453,
    name: "Base",
    rpcHttps: process.env.BASE_RPC_HTTPS || "https://mainnet.base.org",
    rpcWss: process.env.BASE_RPC_WSS,
    nativeSymbol: "ETH",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    multicall3: MULTICALL3,
    dexes: [
      {
        name: "UniswapV2",
        type: "v2",
        router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
        factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
      },
      {
        name: "BaseSwap",
        type: "v2",
        router: "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86",
        factory: "0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB",
      },
      {
        name: "Aerodrome",
        type: "solidly",
        router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
        factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
      },
      {
        name: "UniswapV3",
        type: "v3",
        router: "0x2626664c2603336E57B271c5C0b26F421741e481",
        factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
        fee: 3000,
      },
      {
        name: "UniswapV3_500",
        type: "v3",
        router: "0x2626664c2603336E57B271c5C0b26F421741e481",
        factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
        fee: 500,
      },
    ],
    tokens: [
      { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
      { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
      { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI", decimals: 18 },
      { address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", symbol: "AERO", decimals: 18 },
      { address: "0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b", symbol: "tBTC", decimals: 18 },
      { address: "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c", symbol: "cbETH", decimals: 18 },
      { address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", symbol: "USDbC", decimals: 6 },
      { address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", symbol: "EURC", decimals: 6 },
    ],
  },

  arbitrum: {
    id: 42161,
    name: "Arbitrum",
    rpcHttps: process.env.ARBITRUM_RPC_HTTPS || "https://arb1.arbitrum.io/rpc",
    rpcWss: process.env.ARBITRUM_RPC_WSS,
    nativeSymbol: "ETH",
    wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    multicall3: MULTICALL3,
    dexes: [
      {
        name: "UniswapV2",
        type: "v2",
        router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
        factory: "0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9",
      },
      {
        name: "SushiSwap",
        type: "v2",
        router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
        factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
      },
      {
        name: "Camelot",
        type: "v2",
        router: "0xc873fEcbd354f5A56E00E710B90EF4201db2448d",
        factory: "0x6EcCab422D763aC031210895C81787E87B43A652",
      },
      {
        name: "UniswapV3",
        type: "v3",
        router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
        factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        fee: 3000,
      },
    ],
    tokens: [
      { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", symbol: "WETH", decimals: 18 },
      { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", decimals: 6 },
      { address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", symbol: "USDC.e", decimals: 6 },
      { address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", symbol: "DAI", decimals: 18 },
      { address: "0x912CE59144191C1204E64559FE8253a0e49E6548", symbol: "ARB", decimals: 18 },
    ],
  },
};

export const CONFIG = {
  privateKey: process.env.PRIVATE_KEY || "",
  minProfitUsd: Number(process.env.MIN_PROFIT_USD || "5"),
  maxGasGwei: Number(process.env.MAX_GAS_GWEI || "50"),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || "1000"),
  executionMode: (process.env.EXECUTION_MODE || "direct") as "direct" | "flashloan",
  tradeAmountEth: Number(process.env.TRADE_AMOUNT_ETH || "0.1"),
  activeChain: process.env.ACTIVE_CHAIN || "base",
};
