import { Connection, PublicKey, ParsedAccountData } from "@solana/web3.js";
import { CONFIG } from "./config";
import { log } from "./logger";

export interface Holder {
  wallet: string;
  ata: string;
  balance: number;
  balanceRaw: bigint;
  costBasis: number;      // Adjusted (proportional) cost in SOL
  currentValue: number;   // Effective balance × price
  pnl: number;            // currentValue - costBasis
  swapBought: number;     // Tokens acquired via DEX swaps only
  retainedRatio: number;  // Fraction of bought tokens still held
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const GAS_THRESHOLD = 0.001; // SOL spent must exceed this to count as swap

// ═══════════════════════════════════════════════════════════════════
// WINNER COOLDOWN
// ═══════════════════════════════════════════════════════════════════
const recentWinners = new Map<string, number>();
const COOLDOWN_CYCLES = 2;

export function recordWinner(wallet: string, cycle: number): void {
  recentWinners.set(wallet, cycle);
}

export function isOnCooldown(wallet: string, currentCycle: number): boolean {
  const wonAt = recentWinners.get(wallet);
  if (!wonAt) return false;
  return (currentCycle - wonAt) <= COOLDOWN_CYCLES;
}

// ═══════════════════════════════════════════════════════════════════
// EXCLUDED WALLETS
// ═══════════════════════════════════════════════════════════════════
const EXCLUDED = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "1nc1nerator11111111111111111111111111111111",
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
]);

async function getPrice(): Promise<number> {
  try {
    const url = `${CONFIG.JUPITER_API}/price?ids=${CONFIG.TOKEN_MINT}&vsToken=${SOL_MINT}`;
    const resp = await fetch(url);
    const data = await resp.json();
    const price = parseFloat(data?.data?.[CONFIG.TOKEN_MINT]?.price || "0");
    if (price === 0) log.warn("⚠️  Jupiter returned 0 price");
    return price;
  } catch (error) {
    log.warn("⚠️  Price fetch failed:", error instanceof Error ? error.message : error);
    return 0;
  }
}

// ═══════════════════════════════════════════════════════════════════
// SWAP-ONLY HISTORY — core anti-abuse mechanism
//
// Only counts transactions where:
//   tokenDelta > 0  AND  solSpent > GAS_THRESHOLD
//
// SWAP  = got tokens + paid SOL (real purchase)  → COUNTED
// TRANSFER IN = got tokens + paid ~0 SOL (gas)   → IGNORED
// AIRDROP/REWARD = got tokens + paid 0 SOL       → IGNORED
// ═══════════════════════════════════════════════════════════════════

interface SwapHistory {
  totalSolSpent: number;
  totalTokensBought: number;
}

async function getSwapHistory(
  conn: Connection,
  owner: PublicKey,
  mint: PublicKey
): Promise<SwapHistory> {
  let totalSolSpent = 0;
  let totalTokensBought = 0;

  try {
    const signatures = await conn.getSignaturesForAddress(owner, { limit: 30 });

    for (const sig of signatures) {
      try {
        const tx = await conn.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (!tx?.meta) continue;

        const preTok = tx.meta.preTokenBalances?.filter(
          (b) => b.mint === mint.toBase58() && b.owner === owner.toBase58()
        ) ?? [];
        const postTok = tx.meta.postTokenBalances?.filter(
          (b) => b.mint === mint.toBase58() && b.owner === owner.toBase58()
        ) ?? [];

        const preBal = preTok[0]?.uiTokenAmount?.uiAmount ?? 0;
        const postBal = postTok[0]?.uiTokenAmount?.uiAmount ?? 0;
        const tokenDelta = postBal - preBal;

        if (tokenDelta <= 0) continue;

        // Find owner's SOL balance change
        const keys = tx.transaction.message.accountKeys;
        let idx = 0;
        for (let i = 0; i < keys.length; i++) {
          const k = typeof keys[i] === "object" && "pubkey" in keys[i]
            ? (keys[i] as any).pubkey.toBase58()
            : keys[i].toString();
          if (k === owner.toBase58()) { idx = i; break; }
        }

        const preSOL = (tx.meta.preBalances?.[idx] ?? 0) / 1e9;
        const postSOL = (tx.meta.postBalances?.[idx] ?? 0) / 1e9;
        const solSpent = preSOL - postSOL;

        // SWAP: significant SOL spent (not just gas)
        // TRANSFER: solSpent ≈ 0.000005 (gas only)
        if (solSpent > GAS_THRESHOLD) {
          totalSolSpent += solSpent;
          totalTokensBought += tokenDelta;
        }
      } catch { continue; }
    }
  } catch (error) {
    log.debug("Could not fetch swap history for", owner.toBase58());
  }

  return { totalSolSpent, totalTokensBought };
}

// ═══════════════════════════════════════════════════════════════════
// MAIN: Fetch holders with anti-abuse PnL
// ═══════════════════════════════════════════════════════════════════

export async function getHolders(conn: Connection, currentCycle?: number): Promise<Holder[]> {
  const mint = new PublicKey(CONFIG.TOKEN_MINT);

  log.info("🔍 Fetching token holders...");

  const accounts = await conn.getParsedProgramAccounts(TOKEN_PROGRAM, {
    filters: [
      { dataSize: 165 },
      { memcmp: { offset: 0, bytes: mint.toBase58() } },
    ],
  });

  log.info(`📊 Found ${accounts.length} token accounts`);

  const price = await getPrice();
  log.info(`💰 Token price: ${price.toFixed(12)} SOL`);

  // Exclude bot wallet
  let botWallet = "";
  try {
    const bs58 = require("bs58");
    const { Keypair } = require("@solana/web3.js");
    botWallet = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY)).publicKey.toBase58();
  } catch {}

  const holders: Holder[] = [];

  for (const account of accounts) {
    const parsed = account.account.data as ParsedAccountData;
    const info = parsed.parsed?.info;
    if (!info) continue;

    const owner: string = info.owner;
    const balance = parseFloat(info.tokenAmount?.uiAmountString ?? "0");
    const balanceRaw = BigInt(info.tokenAmount?.amount ?? "0");

    if (balance <= 0 || EXCLUDED.has(owner) || owner === botWallet) continue;

    // ═══════════════════════════════════════════════════════
    // ANTI-ABUSE: Proportional PnL based on SWAPS ONLY
    //
    // effectiveBalance = min(currentBalance, totalBoughtViaSwap)
    //   → Tokens received via transfer DON'T inflate your value
    //
    // retainedRatio = min(1, currentBalance / totalBoughtViaSwap)
    //   → If you transferred tokens out, cost basis shrinks proportionally
    //
    // adjustedCost = totalSolSpent × retainedRatio
    //   → Fair cost basis that can't be gamed by transfers
    //
    // PnL = (effectiveBalance × price) - adjustedCost
    // ═══════════════════════════════════════════════════════

    const { totalSolSpent, totalTokensBought } = await getSwapHistory(conn, new PublicKey(owner), mint);

    // No swap history → not a real buyer (got tokens via transfer/airdrop)
    if (totalTokensBought <= 0 || totalSolSpent <= 0) continue;

    const retainedRatio = Math.min(1, balance / totalTokensBought);
    const effectiveBalance = Math.min(balance, totalTokensBought);
    const adjustedCostBasis = totalSolSpent * retainedRatio;
    const currentValue = effectiveBalance * price;
    const pnl = currentValue - adjustedCostBasis;

    holders.push({
      wallet: owner,
      ata: account.pubkey.toBase58(),
      balance,
      balanceRaw,
      costBasis: adjustedCostBasis,
      currentValue,
      pnl,
      swapBought: totalTokensBought,
      retainedRatio,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // FILTERS: cooldown + minimum value
  // ═══════════════════════════════════════════════════════════════
  const MIN_VALUE_SOL = 0.001;

  const eligible = holders.filter(h => {
    if (h.currentValue < MIN_VALUE_SOL) return false;
    if (currentCycle !== undefined && isOnCooldown(h.wallet, currentCycle)) {
      log.debug(`  ${h.wallet.slice(0,4)}...${h.wallet.slice(-4)}: cooldown, skip`);
      return false;
    }
    return true;
  });

  eligible.sort((a, b) => a.pnl - b.pnl);

  log.info(`👥 Eligible: ${eligible.length} of ${holders.length}`);

  if (eligible[0]) {
    const t = eligible[0];
    log.info(
      `☠️  Top loser: ${t.wallet.slice(0,4)}...${t.wallet.slice(-4)} | ` +
      `PnL: ${t.pnl.toFixed(6)} SOL | ` +
      `Bal: ${t.balance.toFixed(2)} | ` +
      `Bought: ${t.swapBought.toFixed(2)} | ` +
      `Retained: ${(t.retainedRatio*100).toFixed(0)}%`
    );
  }

  return eligible;
}
