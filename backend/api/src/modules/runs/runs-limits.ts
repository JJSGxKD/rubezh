import type { RateLimit } from "../ingest/rate-limiter.js";

/**
 * Лимиты приёма забегов (docs/34-stage3-plan.md, WP4). Бизнес-параметры, а
 * не пороги антифрода: меняются здесь, в карте конфигурации —
 * docs/30-configuration-map.md.
 *
 * Лимит — по аккаунту, а не по адресу: за адресом мобильного оператора стоят
 * сотни игроков. 120 забегов в час — это забег каждые полминуты без
 * перерыва; живой игрок столько не сыграет, а скрипт, долбящий приём,
 * упрётся сюда.
 */
export const RUNS_LIMITS: Record<"start" | "finish", RateLimit> = {
  start: { scope: "runs:start", limit: 120, windowSec: 3600 },
  finish: { scope: "runs:finish", limit: 120, windowSec: 3600 },
};
