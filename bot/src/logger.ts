import { CONFIG } from "./config";

const L: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const lvl = L[CONFIG.LOG_LEVEL] ?? 1;
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

export const log = {
  debug: (...a: unknown[]) => {
    if (lvl <= 0) console.log(`\x1b[90m[${ts()}] [DBG]\x1b[0m`, ...a);
  },
  info: (...a: unknown[]) => {
    if (lvl <= 1) console.log(`\x1b[36m[${ts()}] [INF]\x1b[0m`, ...a);
  },
  warn: (...a: unknown[]) => {
    if (lvl <= 2) console.warn(`\x1b[33m[${ts()}] [WRN]\x1b[0m`, ...a);
  },
  error: (...a: unknown[]) => {
    if (lvl <= 3) console.error(`\x1b[31m[${ts()}] [ERR]\x1b[0m`, ...a);
  },
  ok: (...a: unknown[]) => {
    if (lvl <= 1) console.log(`\x1b[32m[${ts()}] [OK]\x1b[0m`, ...a);
  },
};
