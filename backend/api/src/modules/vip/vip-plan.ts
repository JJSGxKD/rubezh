import type { Product } from "@bh/fx";
import { isEarnReason, type EarnReason, type GrantReason } from "../wallet/wallet-types.js";

/**
 * VIP в числах (docs/35-stage4-plan.md Р20, Р26, Р44). Меняется здесь, в
 * карте конфигурации — docs/30-configuration-map.md.
 *
 * **Рабочие числа** — цену и самоцветы дня ставит команда (О9, О27). Опора:
 * звезда игроку — 1,72 ₽ (Р37), 60 самоцветов в магазине — 50 ⭐. Самоцветы
 * дня за месяц заходов стоят в магазине больше самой подписки — это причина
 * заходить каждый день, а не скидка на самоцветы: пропущенный день сгорает.
 */

export const VIP_PLAN = {
  /** товар в строке покупки и в отчёте о выручке */
  sku: "vip_month",
  /** в окне оплаты площадки — до 25 знаков, с запасом на пометку тестовой оплаты */
  title: "VIP на 30 дней",
  description: "Самоцветы каждый день и привилегии VIP. Продлевается сам раз в 30 дней, продление можно отменить в любой момент.",
  /** базовая цена в рублях — для отчёта и будущих способов оплаты; ручная цена в звёздах побеждает пересчёт */
  baseRub: "344",
  stars: 200,
  /** период подписки: у Telegram он один — 30 суток */
  periodDays: 30,
} as const;

/** Самоцветы, которые VIP забирает раз в игровые сутки (Р26). */
export const VIP_DAILY_GEMS = 10;

/**
 * Увеличенные награды VIP (Р44, §3.14): множитель начисления по причине
 * кошелька. Опыт не умножается — только то, что ложится на счёт, как у
 * удвоения за рекламу. Суточный потолок причины растёт на тот же множитель.
 * Рабочие числа (О27).
 */
export const VIP_REWARD_MUL: Partial<Record<EarnReason, number>> = {
  daily_reward: 1.5,
  wheel_reward: 1.5,
  run_reward: 1.5,
  task_reward: 1.5,
};

/** Множитель VIP для причины начисления; `undefined` — у причины надбавки нет. */
export function vipRewardMul(reason: GrantReason): number | undefined {
  return isEarnReason(reason) ? VIP_REWARD_MUL[reason] : undefined;
}

/** VIP для слоя цен WP9: базовая цена и ручная — в звёздах. */
export function vipProduct(): Product {
  return { id: VIP_PLAN.sku, base: { currency: "RUB", amount: VIP_PLAN.baseRub }, manual: { telegram_stars: String(VIP_PLAN.stars) } };
}

export const VIP_PERIOD_SEC = VIP_PLAN.periodDays * 24 * 60 * 60;
