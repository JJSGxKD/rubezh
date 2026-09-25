/**
 * Что лежит в кошельке и откуда оно берётся (docs/35-stage4-plan.md, §3.2).
 *
 * Валют две — монеты и самоцветы, без обмена друг на друга (Р2). Осколки —
 * материал по редкостям, но лежат тем же журналом (Р34): у них те же
 * свойства — нельзя начислить дважды, нельзя уйти в минус.
 */

export const WALLET_RESOURCES = [
  "coins",
  "gems",
  "shard_common",
  "shard_uncommon",
  "shard_rare",
  "shard_epic",
  "shard_legendary",
  "shard_mythic",
] as const;

export type WalletResource = (typeof WALLET_RESOURCES)[number];

/**
 * Источники, из которых ценность появляется «из ничего». У каждого —
 * суточный потолок (`wallet-limits.ts`): ошибка в числах или накрутка
 * упрётся в него раньше, чем инфляция станет заметна.
 */
export const EARN_REASONS = [
  "run_reward",
  "level_reward",
  "daily_reward",
  "task_reward",
  "achievement_reward",
  "wheel_reward",
  "friend_gift",
  "referral_reward",
  "ad_reward",
  "subscription_daily",
  "season_reward",
] as const;

/**
 * Начисления, у которых ценность пришла извне или из уже полученного:
 * покупка оплачена, осколки — разобранный предмет. Потолок им не нужен — их
 * ограничивает то, что было у игрока.
 */
export const EXCHANGE_REASONS = ["purchase", "salvage"] as const;

/** На что тратят. */
export const SPEND_REASONS = ["unlock", "meta_upgrade", "item_upgrade", "item_reroll", "item_merge", "boost", "shop"] as const;

/** Ручная операция из панели: под правом, с причиной и записью в аудит. */
export const ADMIN_REASON = "admin_adjust";

export type EarnReason = (typeof EARN_REASONS)[number];
export type ExchangeReason = (typeof EXCHANGE_REASONS)[number];
export type SpendReason = (typeof SPEND_REASONS)[number];
export type GrantReason = EarnReason | ExchangeReason | typeof ADMIN_REASON;
export type WalletReason = GrantReason | SpendReason;

export type Balances = Record<WalletResource, number>;

export function isEarnReason(reason: WalletReason): reason is EarnReason {
  return (EARN_REASONS as readonly string[]).includes(reason);
}

export function emptyBalances(): Balances {
  return Object.fromEntries(WALLET_RESOURCES.map((resource) => [resource, 0])) as Balances;
}
