import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { CONFIG, validate } from "./config";
import { log } from "./logger";
import { getHolders, recordWinner } from "./holders";
import { claimFees } from "./fees";
import { buyTokens } from "./swap";
import { distribute, getDecimals } from "./distribute";

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════════════
let cycleCount = 0;
let lastRecipient: {
  wallet: string;
  amount: string;
  time: Date;
  burnTx: string;
} | null = null;

/**
 * Run one complete cycle:
 * 1. Find holder with biggest loss (lowest PnL)
 * 2. Claim creator fees from pump.fun
 * 3. Buy $HOPE tokens with the fees
 * 4. Send 50% to the loser
 * 5. Burn 50%
 */
async function runCycle(conn: Connection, payer: Keypair): Promise<void> {
  cycleCount++;
  
  const separator = "═".repeat(60);
  console.log(`\n\x1b[90m${separator}\x1b[0m`);
  log.info(`🔄 CYCLE #${cycleCount}`);
  console.log(`\x1b[90m${separator}\x1b[0m\n`);

  try {
    // ═══════════════════════════════════════════════════════════════════
    // STEP 1: Find the biggest loser (lowest PnL)
    // ═══════════════════════════════════════════════════════════════════
    log.info("STEP 1 — Finding holder with biggest loss...");
    const holders = await getHolders(conn, cycleCount);

    if (!holders.length) {
      log.warn("⚠️  No holders found. Skipping cycle.");
      return;
    }

    const topLoser = holders[0];

    // If top "loser" is actually profitable, skip
    if (topLoser.pnl >= 0) {
      log.info("🎉 Everyone is in profit! No losers to help. Skipping cycle.");
      return;
    }

    log.info(`\n  ☠️  TOP LOSER: ${topLoser.wallet}`);
    log.info(`     💸 Unrealized Loss: ${topLoser.pnl.toFixed(6)} SOL`);
    log.info(`     💰 Cost Basis: ${topLoser.costBasis.toFixed(6)} SOL`);
    log.info(`     📊 Current Value: ${topLoser.currentValue.toFixed(6)} SOL`);
    log.info(`     🪙 Balance: ${topLoser.balance.toFixed(2)} tokens\n`);

    // ═══════════════════════════════════════════════════════════════════
    // STEP 2: Claim creator fees
    // ═══════════════════════════════════════════════════════════════════
    log.info("STEP 2 — Claiming creator fees...");
    const solAvailable = await claimFees(conn, payer);

    if (solAvailable <= 0) {
      log.warn("⚠️  No fees available. Skipping cycle.");
      return;
    }

    // ═══════════════════════════════════════════════════════════════════
    // STEP 3: Buy $HOPE tokens with the fees
    // ═══════════════════════════════════════════════════════════════════
    log.info("STEP 3 — Buying $HOPE with creator fees...");
    const tokensReceived = await buyTokens(conn, payer, solAvailable);

    if (tokensReceived === 0n) {
      log.error("❌ Swap returned 0 tokens. Aborting cycle.");
      return;
    }

    // ═══════════════════════════════════════════════════════════════════
    // STEP 4: Distribute 50% to loser + Burn 50%
    // ═══════════════════════════════════════════════════════════════════
    log.info("STEP 4 — Distributing 50% to loser + Burning 50%...");
    const decimals = await getDecimals(conn);
    const { txSend, txBurn } = await distribute(
      conn,
      payer,
      topLoser.wallet,
      tokensReceived,
      decimals
    );

    const halfAmount = Number(tokensReceived / 2n) / 10 ** decimals;

    lastRecipient = {
      wallet: topLoser.wallet,
      amount: halfAmount.toFixed(2),
      time: new Date(),
      burnTx: txBurn,
    };

    // Record winner for cooldown (skip next 2 cycles)
    recordWinner(topLoser.wallet, cycleCount);

    // ═══════════════════════════════════════════════════════════════════
    // CYCLE SUMMARY
    // ═══════════════════════════════════════════════════════════════════
    console.log("");
    log.ok("═══════════════════════════════════════════════════════════");
    log.ok("✅ CYCLE COMPLETE");
    log.ok("═══════════════════════════════════════════════════════════");
    log.ok(`🎯 Recipient:      ${topLoser.wallet}`);
    log.ok(`💸 Loser's PnL:    ${topLoser.pnl.toFixed(6)} SOL`);
    log.ok(`💵 SOL used:       ${solAvailable.toFixed(6)} SOL`);
    log.ok(`📤 Sent to loser:  ${halfAmount.toFixed(2)} $HOPE`);
    log.ok(`🔥 Burned:         ${halfAmount.toFixed(2)} $HOPE`);
    log.ok(`📜 Send TX:        ${txSend}`);
    log.ok(`📜 Burn TX:        ${txBurn}`);
    log.ok("═══════════════════════════════════════════════════════════");

    // ═══════════════════════════════════════════════════════════════════
    // Log event for frontend consumption (JSON)
    // ═══════════════════════════════════════════════════════════════════
    const event = {
      type: "distribution",
      cycle: cycleCount,
      recipient: topLoser.wallet,
      loserPnl: topLoser.pnl,
      solUsed: solAvailable,
      tokensSent: halfAmount,
      tokensBurned: halfAmount,
      txSend,
      txBurn,
      timestamp: new Date().toISOString(),
    };

    console.log(`\n[EVENT] ${JSON.stringify(event)}\n`);
  } catch (error) {
    log.error("❌ Cycle failed:", error instanceof Error ? error.message : error);
    
    if (error instanceof Error && error.stack) {
      log.debug("Stack trace:", error.stack);
    }
  }
}

/**
 * Calculate next interval with random jitter
 */
function getNextInterval(): number {
  const baseMs = CONFIG.INTERVAL_SEC * 1000;
  const jitterMs = CONFIG.JITTER_SEC * 1000;
  const randomJitter = Math.floor(Math.random() * jitterMs * 2) - jitterMs;
  return baseMs + randomJitter;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // ═══════════════════════════════════════════════════════════════════
  // Print banner
  // ═══════════════════════════════════════════════════════════════════
  console.log(`\x1b[37m
  ██   ██  ██████  ██████  ███████
  ██   ██ ██    ██ ██   ██ ██
  ███████ ██    ██ ██████  █████
  ██   ██ ██    ██ ██      ██
  ██   ██  ██████  ██      ███████
\x1b[90m
  HOPELESS — Redistribution Bot v1.0
  "The token that rewards pain"
\x1b[0m`);

  // ═══════════════════════════════════════════════════════════════════
  // Validate configuration
  // ═══════════════════════════════════════════════════════════════════
  try {
    validate();
    log.ok("✅ Configuration validated");
  } catch (error) {
    log.error("Configuration error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Connect to Solana
  // ═══════════════════════════════════════════════════════════════════
  const conn = new Connection(CONFIG.RPC_URL, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
  });
  log.info(`🌐 RPC: ${CONFIG.RPC_URL}`);

  // ═══════════════════════════════════════════════════════════════════
  // Load bot wallet
  // ═══════════════════════════════════════════════════════════════════
  const payer = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
  log.info(`👛 Bot wallet: ${payer.publicKey.toBase58()}`);

  // ═══════════════════════════════════════════════════════════════════
  // Check wallet balance
  // ═══════════════════════════════════════════════════════════════════
  const balance = await conn.getBalance(payer.publicKey);
  const balanceSOL = balance / 1e9;
  log.info(`💰 Wallet balance: ${balanceSOL.toFixed(6)} SOL`);

  if (balance < 5000000) {
    // Less than 0.005 SOL
    log.error("❌ Wallet balance too low. Please fund the wallet with at least 0.01 SOL.");
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Print configuration
  // ═══════════════════════════════════════════════════════════════════
  log.info(`🪙 Token: ${CONFIG.TOKEN_MINT}`);
  log.info(`🏦 Platform: ${CONFIG.PLATFORM}`);
  log.info(`⏱️  Cycle interval: ${CONFIG.INTERVAL_SEC}s ± ${CONFIG.JITTER_SEC}s`);
  log.info(`🔥 Burn method: ${CONFIG.BURN_METHOD}`);
  console.log("");

  // ═══════════════════════════════════════════════════════════════════
  // Run first cycle immediately
  // ═══════════════════════════════════════════════════════════════════
  await runCycle(conn, payer);

  // ═══════════════════════════════════════════════════════════════════
  // Schedule subsequent cycles
  // ═══════════════════════════════════════════════════════════════════
  function scheduleNextCycle() {
    const intervalMs = getNextInterval();
    const intervalSec = intervalMs / 1000;
    
    log.info(`⏳ Next cycle in ${intervalSec.toFixed(1)}s`);
    
    setTimeout(async () => {
      await runCycle(conn, payer);
      scheduleNextCycle(); // Schedule next one
    }, intervalMs);
  }

  scheduleNextCycle();

  // ═══════════════════════════════════════════════════════════════════
  // Graceful shutdown handler
  // ═══════════════════════════════════════════════════════════════════
  process.on("SIGINT", () => {
    console.log("");
    log.warn("🛑 Shutting down gracefully...");
    
    if (lastRecipient) {
      log.info(`📊 Last recipient: ${lastRecipient.wallet}`);
      log.info(`📊 Amount: ${lastRecipient.amount} $HOPE`);
      log.info(`📊 Time: ${lastRecipient.time.toISOString()}`);
    }
    
    log.info(`📊 Total cycles completed: ${cycleCount}`);
    console.log("");
    process.exit(0);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Start the bot
// ═══════════════════════════════════════════════════════════════════════════
main().catch((error) => {
  log.error("❌ Fatal error:", error);
  process.exit(1);
});
