import type { PassReward, PassTierDef } from "./pass-rules.js";
import { PASS_TIERS } from "./pass-rules.js";

/**
 * Лента пасса по умолчанию (docs/35-stage4-plan.md Р46, tasks/T-0311): работает,
 * пока на месяц не заведена своя (`pass_season`). Облики не входят — их добавляет
 * T-0315. **Стартовые числа**: калибрует геймдизайнер, а суточный потолок кошелька
 * `pass_reward` (`wallet/wallet-limits.ts`) равен удвоенной сумме этой ленты и
 * меняется вместе с ней — это проверяет тест.
 *
 * Бесплатная лента — монеты лесенкой от 100 до 600 на каждой ступени, обычные
 * осколки через две ступени, добротные на каждой десятой, бусты за монеты на
 * 5-й, 15-й и 25-й. VIP — самоцветы от 10 до 40 на каждой третьей ступени, на
 * остальных редкие осколки, эпические на 10-й, 20-й и 30-й.
 */

/** Бусты бесплатной ленты по ступеням: параметры и щит, которые покупаются за монеты. */
const FREE_BOOSTS: Readonly<Record<number, string>> = { 5: "fury", 15: "aegis", 25: "bulwark" };
/** Добротные осколки бесплатной ленты. */
const FREE_UNCOMMON: Readonly<Record<number, number>> = { 10: 3, 20: 5, 30: 8 };
/** Эпические осколки VIP-ленты. */
const VIP_EPIC: Readonly<Record<number, number>> = { 10: 1, 20: 1, 30: 2 };

function freeReward(tier: number): PassReward {
  const reward: PassReward = { coins: 100 + Math.round(((tier - 1) * 500) / 29 / 10) * 10 };
  const shards: NonNullable<PassReward["shards"]> = {};
  if (tier % 3 === 0) shards.common = 5 * (1 + Math.floor((tier / 3 - 1) / 3));
  const uncommon = FREE_UNCOMMON[tier];
  if (uncommon !== undefined) shards.uncommon = uncommon;
  if (Object.keys(shards).length > 0) reward.shards = shards;
  const boost = FREE_BOOSTS[tier];
  if (boost !== undefined) reward.boost = { id: boost, count: 1 };
  return reward;
}

function vipReward(tier: number): PassReward {
  const reward: PassReward = {};
  const shards: NonNullable<PassReward["shards"]> = {};
  if (tier % 3 === 0) reward.gems = 10 + Math.round(((tier / 3 - 1) * 30) / 9);
  else shards.rare = 2 + Math.floor(tier / 10);
  const epic = VIP_EPIC[tier];
  if (epic !== undefined) shards.epic = epic;
  if (Object.keys(shards).length > 0) reward.shards = shards;
  return reward;
}

export const DEFAULT_RIBBON: readonly PassTierDef[] = Array.from({ length: PASS_TIERS }, (_, index) => {
  const tier = index + 1;
  return { tier, free: freeReward(tier), vip: vipReward(tier) };
});
