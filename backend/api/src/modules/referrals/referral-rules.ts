import type { RateLimit } from "../ingest/rate-limiter.js";

/**
 * Числа рефералки (docs/35-stage4-plan.md, О16). **Рабочие** (Р31): стоят
 * сразу, меняются редактором баланса, когда он появится (WP17), или решением
 * команды. Награды — только мягкая валюта: приведённые друзья не должны
 * усиливать персонажа (docs/23-referral-and-partner-program.md §2.1).
 */
export const REFERRAL_RULES = {
  /** привязать можно аккаунт не старше стольких суток — рабочее (гипотеза §2.4) */
  bindWindowDays: 3,
  /** сколько записанных забегов — активация: игрок реально начал играть — рабочее */
  activationRuns: 3,
  /** монет приглашённому сразу при привязке — рабочее */
  welcomeCoins: 100,
  /** монет пригласившему за каждого активированного — рабочее */
  referrerCoins: 300,
  /** сколько активаций в игровые сутки засчитывается одному пригласившему — рабочее */
  maxActivationsPerDay: 10,
  /** сколько последних сессий пригласившего смотрим, сверяя подсеть */
  networkLookback: 20,
} as const;

export const REFERRAL_LIMITS = {
  read: { scope: "referrals:read", limit: 600, windowSec: 3600 },
} as const satisfies Record<string, RateLimit>;
