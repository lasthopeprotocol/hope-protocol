import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { CONFIG } from "./config";
import { log } from "./logger";
import BN from "bn.js";

const RESERVE_SOL = 0.01; // Keep this much SOL for gas fees

// ═══════════════════════════════════════════════════════════════════════════
// PUMP.FUN PROGRAM CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const PUMP_EVENT_AUTHORITY = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
const PUMP_FEE_RECIPIENT = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM");

/**
 * Get bonding curve PDA for a token mint
 */
function getBondingCurvePDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_PROGRAM
  );
}

/**
 * Get associated bonding curve PDA (token account)
 */
function getAssociatedBondingCurvePDA(mint: PublicKey, bondingCurve: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      bondingCurve.toBuffer(),
      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(),
      mint.toBuffer(),
    ],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
  );
}

/**
 * Check if token is still on bonding curve or migrated to Raydium
 */
async function isOnBondingCurve(conn: Connection, mint: PublicKey): Promise<boolean> {
  try {
    const [bondingCurvePDA] = getBondingCurvePDA(mint);
    const accountInfo = await conn.getAccountInfo(bondingCurvePDA);
    
    if (!accountInfo) {
      log.debug("No bonding curve account found - token likely migrated");
      return false;
    }

    // Check if account still has data (bonding curve active)
    return accountInfo.data.length > 0;
  } catch (error) {
    log.debug("Error checking bonding curve status:", error);
    return false;
  }
}

/**
 * Withdraw fees from pump.fun bonding curve
 * 
 * This is needed when token is still on the bonding curve.
 * Fees accumulate in the bonding curve PDA and must be withdrawn.
 */
async function withdrawPumpFunFees(
  conn: Connection,
  payer: Keypair,
  mint: PublicKey
): Promise<number> {
  try {
    log.info("💰 Attempting to withdraw fees from pump.fun bonding curve...");

    const [bondingCurve] = getBondingCurvePDA(mint);
    const [associatedBondingCurve] = getAssociatedBondingCurvePDA(mint, bondingCurve);

    // Check bonding curve balance
    const bondingCurveInfo = await conn.getAccountInfo(bondingCurve);
    if (!bondingCurveInfo) {
      log.warn("⚠️  Bonding curve account not found");
      return 0;
    }

    const bondingCurveBalance = bondingCurveInfo.lamports / LAMPORTS_PER_SOL;
    log.info(`📊 Bonding curve balance: ${bondingCurveBalance.toFixed(6)} SOL`);

    if (bondingCurveBalance < 0.001) {
      log.info("💭 No significant fees to withdraw from bonding curve");
      return 0;
    }

    // Create withdraw instruction
    // Instruction discriminator for "withdraw" = [183, 18, 70, 156, 148, 109, 161, 34]
    const discriminator = Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]);

    const keys = [
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), isSigner: false, isWritable: false },
      { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
    ];

    const withdrawInstruction = new TransactionInstruction({
      keys,
      programId: PUMP_PROGRAM,
      data: discriminator,
    });

    const transaction = new Transaction().add(withdrawInstruction);
    
    // Send and confirm
    const signature = await conn.sendTransaction(transaction, [payer], {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });

    const latestBlockhash = await conn.getLatestBlockhash();
    await conn.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      "confirmed"
    );

    log.ok(`✅ Fees withdrawn! TX: ${signature}`);

    // Get new balance
    const newBalance = await conn.getBalance(payer.publicKey);
    const available = Math.max(0, newBalance / LAMPORTS_PER_SOL - RESERVE_SOL);

    return available;
  } catch (error) {
    log.warn("⚠️  Failed to withdraw from bonding curve:", error instanceof Error ? error.message : error);
    return 0;
  }
}

/**
 * Main function: Claim creator fees
 * 
 * Works in two modes:
 * 1. Token on bonding curve → withdraw from bonding curve PDA
 * 2. Token migrated to Raydium → fees already in wallet, just return available balance
 */
export async function claimFees(conn: Connection, payer: Keypair): Promise<number> {
  log.info("💵 Checking available creator fees...");

  const mint = new PublicKey(CONFIG.TOKEN_MINT);
  const onBondingCurve = await isOnBondingCurve(conn, mint);

  if (onBondingCurve) {
    log.info("🔗 Token is on pump.fun bonding curve - withdrawing fees...");
    return await withdrawPumpFunFees(conn, payer, mint);
  } else {
    log.info("🌊 Token migrated to Raydium - fees go directly to wallet");
    
    // Just check wallet balance
    const balance = await conn.getBalance(payer.publicKey);
    const balanceSOL = balance / LAMPORTS_PER_SOL;
    const available = Math.max(0, balanceSOL - RESERVE_SOL);

    log.info(`💼 Wallet balance: ${balanceSOL.toFixed(6)} SOL`);
    log.info(`✅ Available for buyback: ${available.toFixed(6)} SOL`);

    if (available < CONFIG.MIN_FEE_SOL) {
      log.warn(`⚠️  Below threshold (${CONFIG.MIN_FEE_SOL} SOL). Skipping cycle.`);
      return 0;
    }

    return available;
  }
}
