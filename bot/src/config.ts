import dotenv from "dotenv";
dotenv.config();

export const CONFIG = {
  // ═══════════════════════════════════════════════════════════════
  // SOLANA RPC – use Helius/QuickNode/Triton for reliability
  // ═══════════════════════════════════════════════════════════════
  RPC_URL: process.env.RPC_URL || "https://api.mainnet-beta.solana.com",

  // ═══════════════════════════════════════════════════════════════
  // BOT WALLET PRIVATE KEY (base58) – MUST be creator wallet
  // ═══════════════════════════════════════════════════════════════
  PRIVATE_KEY: process.env.PRIVATE_KEY || "",

  // ═══════════════════════════════════════════════════════════════
  // $HOPE TOKEN MINT ADDRESS
  // ═══════════════════════════════════════════════════════════════
  TOKEN_MINT: process.env.TOKEN_MINT || "",

  // ═══════════════════════════════════════════════════════════════
  // PLATFORM (always pumpfun for this bot)
  // ═══════════════════════════════════════════════════════════════
  PLATFORM: "pumpfun" as const,

  // ═══════════════════════════════════════════════════════════════
  // CYCLE TIMING
  // ═══════════════════════════════════════════════════════════════
  INTERVAL_SEC: parseInt(process.env.INTERVAL_SEC || "300", 10),
  JITTER_SEC: parseInt(process.env.JITTER_SEC || "2", 10),

  // ═══════════════════════════════════════════════════════════════
  // JUPITER V6 API
  // ═══════════════════════════════════════════════════════════════
  JUPITER_API: process.env.JUPITER_API || "https://quote-api.jup.ag/v6",

  // ═══════════════════════════════════════════════════════════════
  // MINIMUM SOL FROM FEES TO TRIGGER CYCLE
  // ═══════════════════════════════════════════════════════════════
  MIN_FEE_SOL: parseFloat(process.env.MIN_FEE_SOL || "0.005"),

  // ═══════════════════════════════════════════════════════════════
  // BURN METHOD
  // ═══════════════════════════════════════════════════════════════
  BURN_METHOD: (process.env.BURN_METHOD || "spl") as "spl" | "dead_wallet",
  DEAD_WALLET: process.env.DEAD_WALLET || "1nc1nerator11111111111111111111111111111111",

  // ═══════════════════════════════════════════════════════════════
  // LOGGING LEVEL
  // ═══════════════════════════════════════════════════════════════
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
};

/**
 * Validate configuration on startup
 */
export function validate(): void {
  if (!CONFIG.PRIVATE_KEY) {
    throw new Error("❌ PRIVATE_KEY is required in .env file");
  }
  if (!CONFIG.TOKEN_MINT) {
    throw new Error("❌ TOKEN_MINT is required in .env file");
  }
  if (CONFIG.PRIVATE_KEY.length < 32) {
    throw new Error("❌ PRIVATE_KEY looks invalid (too short)");
  }
  if (CONFIG.TOKEN_MINT.length < 32) {
    throw new Error("❌ TOKEN_MINT looks invalid (too short)");
  }
}
