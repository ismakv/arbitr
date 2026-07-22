import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseAbi,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import "dotenv/config";

const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as Address;
const PUBLIC_RPC = "https://mainnet.base.org";

const POOL_ABI = parseAbi([
  "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external",
]);

const BORROW_TOPIC = "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0" as `0x${string}`;
const LIQ_TOPIC = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286" as `0x${string}`;

// Aave V3 Base reserves (asset addresses)
const RESERVES: Record<string, Address> = {
  WETH: "0x4200000000000000000000000000000000000006",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  cbETH: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
  cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
  DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  AERO: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
};

interface Position {
  user: Address;
  collateralUsd: number;
  debtUsd: number;
  healthFactor: number;
}

const POLL_BLOCKS = 5; // check every 5 blocks (~10s on Base)

async function getActiveBorrowers(client: ReturnType<typeof createPublicClient>, fromBlock: bigint, toBlock: bigint): Promise<Set<string>> {
  const userSet = new Set<string>();
  try {
    const logs = await client.getLogs({
      address: AAVE_POOL,
      topics: [BORROW_TOPIC],
      fromBlock,
      toBlock,
    });
    for (const l of logs) {
      if (l.topics.length >= 3) {
        userSet.add("0x" + l.topics[2].slice(26));
      }
    }
  } catch { /* rate limited, skip */ }
  return userSet;
}

async function checkPosition(client: ReturnType<typeof createPublicClient>, user: Address): Promise<Position | null> {
  try {
    const data = await client.readContract({
      address: AAVE_POOL,
      abi: POOL_ABI,
      functionName: "getUserAccountData",
      args: [user],
    }) as bigint[];

    const debtUsd = Number(data[1]) / 1e8;
    if (debtUsd < 100) return null; // skip dust positions

    return {
      user,
      collateralUsd: Number(data[0]) / 1e8,
      debtUsd,
      healthFactor: Number(formatEther(data[5])),
    };
  } catch {
    return null;
  }
}

async function executeLiquidation(
  walletClient: ReturnType<typeof createWalletClient>,
  publicClient: ReturnType<typeof createPublicClient>,
  position: Position,
): Promise<boolean> {
  // Determine collateral and debt assets
  // For simplicity, try WETH as collateral and USDC as debt (most common pair)
  // In production: query userReserveData to find exact assets
  const collateralAsset = RESERVES.WETH;
  const debtAsset = RESERVES.USDC;

  // Cover 50% of debt (max close factor for HF > 0.95)
  const debtToCover = BigInt(Math.floor(position.debtUsd * 0.5)) * 10n ** 6n; // USDC 6 dec

  console.log(`  ⚡ LIQUIDATING ${position.user.slice(0, 14)}...`);
  console.log(`     Collateral: $${position.collateralUsd.toFixed(0)} | Debt: $${position.debtUsd.toFixed(0)} | HF: ${position.healthFactor.toFixed(4)}`);
  console.log(`     Covering: $${(Number(debtToCover) / 1e6).toFixed(0)} of debt`);
  console.log(`     Expected bonus: ~$${(position.collateralUsd * 0.5 * 0.05).toFixed(0)} (5% of seized collateral)`);

  try {
    const { request } = await publicClient.simulateContract({
      address: AAVE_POOL,
      abi: POOL_ABI,
      functionName: "liquidationCall",
      args: [collateralAsset, debtAsset, position.user, debtToCover, false],
      account: walletClient.account!,
    });

    const txHash = await walletClient.writeContract(request);
    console.log(`  ✅ Liquidation tx sent: ${txHash}`);

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status === "success") {
      console.log(`  🎉 SUCCESS! Gas used: ${receipt.gasUsed}`);
      return true;
    } else {
      console.log(`  ❌ Tx reverted`);
      return false;
    }
  } catch (err) {
    console.log(`  ❌ Liquidation failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    return false;
  }
}

async function main() {
  console.log("╔═══════════════════════════════════════════╗");
  console.log("║   Aave V3 Liquidation Bot (Base)         ║");
  console.log("╚═══════════════════════════════════════════╝\n");

  const publicClient = createPublicClient({
    chain: base,
    transport: http(PUBLIC_RPC),
  });

  const privateKey = process.env.PRIVATE_KEY;
  let walletClient: ReturnType<typeof createWalletClient> | null = null;

  if (privateKey) {
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    walletClient = createWalletClient({
      account,
      chain: base,
      transport: http(PUBLIC_RPC),
    });
    console.log(`Wallet: ${account.address}`);
    console.log("Mode: EXECUTION ENABLED\n");
  } else {
    console.log("No PRIVATE_KEY — monitor-only mode\n");
  }

  // Track known borrowers (accumulated over time)
  const knownBorrowers = new Set<string>();
  let lastBlock = await publicClient.getBlockNumber();

  console.log(`Starting block: ${lastBlock}`);
  console.log(`Monitoring Aave V3 Base for liquidatable positions...\n`);

  // Seed: scan last 200 blocks for borrowers
  console.log("Seeding borrower list (last 200 blocks)...");
  const seedUsers = await getActiveBorrowers(publicClient, lastBlock - 200n, lastBlock);
  for (const u of seedUsers) knownBorrowers.add(u);
  console.log(`Found ${knownBorrowers.size} borrowers\n`);

  // Main loop
  let cycle = 0;
  const loop = async () => {
    cycle++;
    const currentBlock = await publicClient.getBlockNumber();

    if (currentBlock > lastBlock) {
      // Discover new borrowers
      const newUsers = await getActiveBorrowers(publicClient, lastBlock, currentBlock);
      for (const u of newUsers) knownBorrowers.add(u);
      lastBlock = currentBlock;
    }

    // Check all known positions
    let atRisk = 0;
    let liquidatable = 0;

    for (const addr of knownBorrowers) {
      const pos = await checkPosition(publicClient, addr as Address);
      if (!pos) continue;

      if (pos.healthFactor < 1.0) {
        liquidatable++;
        console.log(`\n🔴 [${new Date().toISOString()}] LIQUIDATABLE: ${addr.slice(0, 14)}.. HF=${pos.healthFactor.toFixed(4)} | $${pos.collateralUsd.toFixed(0)} coll | $${pos.debtUsd.toFixed(0)} debt`);

        if (walletClient) {
          await executeLiquidation(walletClient, publicClient, pos);
        }
      } else if (pos.healthFactor < 1.1) {
        atRisk++;
        if (cycle % 10 === 1) { // log every 10th cycle to reduce noise
          console.log(`🟡 [cycle ${cycle}] AT RISK: ${addr.slice(0, 14)}.. HF=${pos.healthFactor.toFixed(4)} | $${pos.debtUsd.toFixed(0)} debt`);
        }
      }
    }

    if (cycle % 30 === 0) {
      console.log(`[cycle ${cycle}] block=${currentBlock} | borrowers=${knownBorrowers.size} | atRisk=${atRisk} | liquidatable=${liquidatable}`);
    }

    setTimeout(loop, 4000); // ~2 blocks on Base
  };

  await loop();
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
