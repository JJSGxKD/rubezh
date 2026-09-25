import type { RateLimit } from "../ingest/rate-limiter.js";

/**
 * Лимиты частоты панели (docs/29-admin-panel.md §8): вход — по адресу, чтобы
 * подбор не упирался только в скорость сети; изменяющие действия и выгрузки —
 * по аккаунту администратора.
 */
export const ADMIN_LIMITS = {
  login: { scope: "admin:login", limit: 10, windowSec: 60 },
  mutate: { scope: "admin:mutate", limit: 60, windowSec: 60 },
  /** сборка архива читает всю базу выгрузки — не чаще нескольких раз за десять минут */
  export: { scope: "admin:export", limit: 3, windowSec: 600 },
} satisfies Record<string, RateLimit>;
