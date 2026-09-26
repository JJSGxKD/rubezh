import type { RateLimit } from "../ingest/rate-limiter.js";

/**
 * Частота по аккаунту (docs/30-configuration-map.md). Инвентарь читает экран
 * арсенала; изменения делает человек нажатиями — «улучшить» пятьдесят раз
 * подряд честно, тысяча в час — уже скрипт.
 */
export const ITEM_LIMITS: Record<"read" | "write", RateLimit> = {
  read: { scope: "items:read", limit: 600, windowSec: 3600 },
  write: { scope: "items:write", limit: 900, windowSec: 3600 },
};
