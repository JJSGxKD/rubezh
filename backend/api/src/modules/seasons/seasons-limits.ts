import type { RateLimit } from "../ingest/rate-limiter.js";

/**
 * Лимиты ручек сезона (tasks/T-0110). Лимит — по аккаунту: за адресом
 * мобильного оператора стоят сотни игроков. Меняются здесь, в карте
 * конфигурации — docs/30-configuration-map.md.
 *
 * Обзор и таблицу читают при открытии экрана рейтинга, переключая сложность и
 * охват: десять в минуту без перерыва живому игроку не нужны. «Забрать» —
 * раз в сезон на аккаунт, остальное — повторы и перебор чужих ключей.
 */
export const SEASONS_LIMITS: Record<"overview" | "board" | "claim", RateLimit> = {
  overview: { scope: "seasons:overview", limit: 600, windowSec: 3600 },
  board: { scope: "seasons:board", limit: 600, windowSec: 3600 },
  claim: { scope: "seasons:claim", limit: 60, windowSec: 3600 },
};
