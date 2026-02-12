import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { CONFIG } from "./config";
import { log } from "./logger";

const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Buy tokens using Jupiter aggregator
 * 
 * @param conn - Solana connection
 * @param payer - Wallet that pays for the swap
 * @param solAmount - Amount of SOL to spend
 * @returns Amount of tokens received (raw amount as bigint)
 */
export async function buyTokens(
  conn: Connection,
  payer: Keypair,
  solAmount: number
): Promise<bigint> {
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  
  log.info(`🔄 Swapping ${solAmount.toFixed(6)} SOL → $HOPE...`);

  try {
    // ═══════════════════════════════════════════════════════════════════
    // STEP 1: Get quote from Jupiter
    // ═══════════════════════════════════════════════════════════════════
    const quoteUrl = `${CONFIG.JUPITER_API}/quote?inputMint=${SOL_MINT}&outputMint=${CONFIG.TOKEN_MINT}&amount=${lamports}&slippageBps=500`;
    
    log.debug("Fetching quote from Jupiter...");
    const quoteResponse = await fetch(quoteUrl);
    
    if (!quoteResponse.ok) {
      throw new Error(`Quote request failed: ${quoteResponse.status} ${quoteResponse.statusText}`);
    }

    const quote = await quoteResponse.json();

    if (!quote.outAmount) {
      throw new Error("Jupiter returned no output amount - possibly no liquidity");
    }

    const outputAmount = BigInt(quote.outAmount);
    log.info(`📊 Quote received: ${solAmount.toFixed(6)} SOL → ${outputAmount.toString()} tokens (raw)`);

    if (outputAmount === 0n) {
      throw new Error("Zero output amount - no liquidity available");
    }

    // ═══════════════════════════════════════════════════════════════════
    // STEP 2: Get swap transaction from Jupiter
    // ═══════════════════════════════════════════════════════════════════
    log.debug("Building swap transaction...");
    
    const swapResponse = await fetch(`${CONFIG.JUPITER_API}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: payer.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 100000, // Higher priority fee for faster execution
      }),
    });

    if (!swapResponse.ok) {
      throw new Error(`Swap request failed: ${swapResponse.status} ${swapResponse.statusText}`);
    }

    const { swapTransaction } = await swapResponse.json();

    if (!swapTransaction) {
      throw new Error("No swap transaction returned from Jupiter");
    }

    // ═══════════════════════════════════════════════════════════════════
    // STEP 3: Deserialize, sign, and send transaction
    // ═══════════════════════════════════════════════════════════════════
    const transactionBuffer = Buffer.from(swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(transactionBuffer);
    
    transaction.sign([payer]);

    log.debug("Sending transaction...");
    const signature = await conn.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    log.info(`📤 Swap TX sent: ${signature}`);

    // ═══════════════════════════════════════════════════════════════════
    // STEP 4: Confirm transaction
    // ═══════════════════════════════════════════════════════════════════
    const latestBlockhash = await conn.getLatestBlockhash();
    await conn.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      "confirmed"
    );

    log.ok(`✅ Swap confirmed! Received ~${outputAmount.toString()} tokens`);
    log.ok(`🔗 View TX: https://solscan.io/tx/${signature}`);

    return outputAmount;
  } catch (error) {
    log.error("❌ Swap failed:", error instanceof Error ? error.message : error);
    throw error;
  }
}
