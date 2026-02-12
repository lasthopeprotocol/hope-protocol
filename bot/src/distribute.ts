import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  createBurnInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { CONFIG } from "./config";
import { log } from "./logger";

/**
 * Get token decimals from mint account
 */
export async function getDecimals(conn: Connection): Promise<number> {
  try {
    const mintPubkey = new PublicKey(CONFIG.TOKEN_MINT);
    const info = await conn.getParsedAccountInfo(mintPubkey);
    const data = info.value?.data;
    
    if (data && "parsed" in data) {
      return data.parsed?.info?.decimals ?? 6;
    }
    
    return 6; // Default fallback
  } catch (error) {
    log.warn("Could not fetch decimals, using default 6");
    return 6;
  }
}

/**
 * Distribute tokens: 50% to loser, 50% burned
 * 
 * @param conn - Solana connection
 * @param payer - Bot wallet (holds the tokens)
 * @param recipientWallet - Top loser wallet address
 * @param totalRaw - Total tokens to distribute (raw amount)
 * @param decimals - Token decimals for display
 * @returns Transaction signatures for send and burn
 */
export async function distribute(
  conn: Connection,
  payer: Keypair,
  recipientWallet: string,
  totalRaw: bigint,
  decimals: number
): Promise<{ txSend: string; txBurn: string }> {
  
  const mint = new PublicKey(CONFIG.TOKEN_MINT);
  const recipient = new PublicKey(recipientWallet);

  // ═══════════════════════════════════════════════════════════════════
  // Calculate 50/50 split
  // ═══════════════════════════════════════════════════════════════════
  const toSend = totalRaw / 2n;
  const toBurn = totalRaw - toSend; // Ensure no rounding loss

  const uiSend = Number(toSend) / 10 ** decimals;
  const uiBurn = Number(toBurn) / 10 ** decimals;

  log.info("📦 Distribution plan:");
  log.info(`   ➜ Send ${uiSend.toFixed(2)} $HOPE to ${recipientWallet.slice(0, 4)}...${recipientWallet.slice(-4)}`);
  log.info(`   ➜ Burn ${uiBurn.toFixed(2)} $HOPE 🔥`);

  // ═══════════════════════════════════════════════════════════════════
  // Get token accounts
  // ═══════════════════════════════════════════════════════════════════
  const sourceATA = await getAssociatedTokenAddress(
    mint,
    payer.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const destinationATA = await getAssociatedTokenAddress(
    mint,
    recipient,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // ═══════════════════════════════════════════════════════════════════
  // STEP 1: Transfer 50% to loser
  // ═══════════════════════════════════════════════════════════════════
  const tx1 = new Transaction();

  // Check if recipient has token account, create if needed
  try {
    await getAccount(conn, destinationATA, "confirmed", TOKEN_PROGRAM_ID);
    log.debug("Recipient token account exists");
  } catch (error) {
    log.info("Creating recipient token account...");
    tx1.add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        destinationATA,
        recipient,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // Add transfer instruction
  tx1.add(
    createTransferInstruction(
      sourceATA,
      destinationATA,
      payer.publicKey,
      toSend,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  log.info("📤 Sending 50% to loser...");
  const txSend = await sendAndConfirmTransaction(conn, tx1, [payer], {
    commitment: "confirmed",
  });
  
  log.ok(`✅ Transfer confirmed: ${txSend}`);
  log.ok(`🔗 View TX: https://solscan.io/tx/${txSend}`);

  // ═══════════════════════════════════════════════════════════════════
  // STEP 2: Burn 50%
  // ═══════════════════════════════════════════════════════════════════
  let txBurn: string;

  if (CONFIG.BURN_METHOD === "dead_wallet") {
    // ─────────────────────────────────────────────────────────────────
    // Method 1: Send to dead wallet (incinerator)
    // ─────────────────────────────────────────────────────────────────
    log.info("🔥 Sending 50% to dead wallet...");
    
    const deadWallet = new PublicKey(CONFIG.DEAD_WALLET);
    const deadATA = await getAssociatedTokenAddress(
      mint,
      deadWallet,
      true, // Allow owner off curve
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const tx2 = new Transaction();

    try {
      await getAccount(conn, deadATA, "confirmed", TOKEN_PROGRAM_ID);
    } catch (error) {
      tx2.add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          deadATA,
          deadWallet,
          mint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }

    tx2.add(
      createTransferInstruction(
        sourceATA,
        deadATA,
        payer.publicKey,
        toBurn,
        [],
        TOKEN_PROGRAM_ID
      )
    );

    txBurn = await sendAndConfirmTransaction(conn, tx2, [payer], {
      commitment: "confirmed",
    });
    
    log.ok(`✅ Sent to dead wallet: ${txBurn}`);
  } else {
    // ─────────────────────────────────────────────────────────────────
    // Method 2: SPL burn (RECOMMENDED - actually reduces supply)
    // ─────────────────────────────────────────────────────────────────
    log.info("🔥 Burning 50% via SPL burn instruction...");
    
    const tx2 = new Transaction().add(
      createBurnInstruction(
        sourceATA,
        mint,
        payer.publicKey,
        toBurn,
        [],
        TOKEN_PROGRAM_ID
      )
    );

    txBurn = await sendAndConfirmTransaction(conn, tx2, [payer], {
      commitment: "confirmed",
    });
    
    log.ok(`✅ Burned via SPL: ${txBurn}`);
  }

  log.ok(`🔗 View TX: https://solscan.io/tx/${txBurn}`);

  return { txSend, txBurn };
}
