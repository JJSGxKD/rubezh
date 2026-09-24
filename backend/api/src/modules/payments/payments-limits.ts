import type { RateLimit } from "../ingest/rate-limiter.js";

/**
 * Лимиты оплаты (docs/34-stage3-plan.md, WP5) — по аккаунту, как у забегов:
 * за адресом мобильного оператора стоят сотни игроков. Бизнес-параметры, в
 * карте конфигурации — docs/30-configuration-map.md.
 *
 * Цену спрашивают на каждой смерти, поэтому её лимит вдвое выше лимита
 * забегов. Счёт — только по нажатию «Продолжить». Состояние покупки клиент
 * опрашивает раз в секунду, пока ждёт подтверждения, — отсюда запас.
 */
export const PAYMENTS_LIMITS: Record<"quote" | "invoice" | "status", RateLimit> = {
  quote: { scope: "payments:quote", limit: 240, windowSec: 3600 },
  invoice: { scope: "payments:invoice", limit: 60, windowSec: 3600 },
  status: { scope: "payments:status", limit: 1200, windowSec: 3600 },
};
