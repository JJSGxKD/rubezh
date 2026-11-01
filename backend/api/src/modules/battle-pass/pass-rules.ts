import { z } from "zod";
import { BOOST_IDS } from "../boosts/boost-catalog.js";
import { ITEM_RARITIES, type ItemRarity } from "../items/item-catalog.js";
import { WALLET_DAILY_CAPS } from "../wallet/wallet-limits.js";
import type { WalletResource } from "../wallet/wallet-types.js";

/**
 * Правила батл-пасса (docs/35-stage4-plan.md Р46, §3.15; tasks/T-0311) —
 * чистые функции без базы и времени: месяц по Москве, ступень по очкам, схема
 * награды и ленты, право на забор и ответ игроку.
 *
 * Награда ступени — монеты, самоцветы, осколки по редкостям и буст. Случайного
 * содержимого нет (Р11), поля облика появятся вместе с T-0315.
 */

export const PASS_TIERS = 30;
export const PASS_LANES = ["free", "vip"] as const;
export type PassLane = (typeof PASS_LANES)[number];

/** Москва — UTC+3 круглый год, перехода на летнее время нет. */
const MOSCOW_OFFSET_MS = 3 * 3_600_000;
const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;
/** Сколько бустов одного вида пасс дарит за ступень: больше — опечатка в панели. */
const BOOST_GIFT_MAX = 10;

/** Ключ месяца пасса `ГГГГ-ММ` — по московскому времени момента. */
export function monthKeyOf(at: Date): string {
  const moscow = new Date(at.getTime() + MOSCOW_OFFSET_MS);
  return `${String(moscow.getUTCFullYear()).padStart(4, "0")}-${String(moscow.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Границы месяца в UTC: с первого числа 00:00 по Москве до первого числа следующего месяца. */
export function monthBounds(monthKey: string): { startsAt: Date; endsAt: Date } {
  const parsed = MONTH_KEY.exec(monthKey);
  if (parsed === null) throw new Error(`ключ месяца пасса «${monthKey}» — не ГГГГ-ММ`);
  const year = Number(parsed[1]);
  const month = Number(parsed[2]);
  return { startsAt: new Date(Date.UTC(year, month - 1, 1) - MOSCOW_OFFSET_MS), endsAt: new Date(Date.UTC(year, month, 1) - MOSCOW_OFFSET_MS) };
}

/** Ступень по очкам: целое число шагов, не больше 30. Очки сверх тридцатой ступеней не дают. */
export function tierOf(points: number, pointsPerTier: number): number {
  if (!Number.isInteger(pointsPerTier) || pointsPerTier <= 0) throw new Error(`шаг ступени пасса ${String(pointsPerTier)} — ожидается целое больше нуля`);
  return Math.min(PASS_TIERS, Math.floor(Math.max(0, points) / pointsPerTier));
}

/** Сколько можно выдать ресурсу за раз: суточный потолок причины `pass_reward`, ноль — ресурс пассу не разрешён. */
function capOf(resource: WalletResource): number {
  return WALLET_DAILY_CAPS.pass_reward[resource] ?? 0;
}

/** Количество в награде: целое от единицы до потолка кошелька; ресурс без потолка не принимается вовсе. */
function amountOf(resource: WalletResource): z.ZodType<number> {
  const cap = capOf(resource);
  return cap > 0 ? z.number().int().min(1).max(cap) : z.number().refine(() => false, { message: "пасс не выдаёт этот ресурс" });
}

const shardsSchema = z
  .object({
    common: amountOf("shard_common").optional(),
    uncommon: amountOf("shard_uncommon").optional(),
    rare: amountOf("shard_rare").optional(),
    epic: amountOf("shard_epic").optional(),
    legendary: amountOf("shard_legendary").optional(),
    mythic: amountOf("shard_mythic").optional(),
  })
  .strict();

const boostSchema = z
  .object({
    id: z.string().refine((id) => BOOST_IDS.includes(id), { message: "неизвестный буст" }),
    count: z.number().int().min(1).max(BOOST_GIFT_MAX),
  })
  .strict();

/** Награда одной ступени одной ленты. Пустая награда — ошибка: ступень без награды игроку не нужна. */
export const passRewardSchema = z
  .object({
    coins: amountOf("coins").optional(),
    gems: amountOf("gems").optional(),
    shards: shardsSchema.optional(),
    boost: boostSchema.optional(),
  })
  .strict()
  .refine((reward) => rewardIsNotEmpty(reward), { message: "в награде ничего нет" });

export type PassReward = z.infer<typeof passRewardSchema>;

function rewardIsNotEmpty(reward: { coins?: number | undefined; gems?: number | undefined; shards?: Partial<Record<ItemRarity, number | undefined>> | undefined; boost?: unknown }): boolean {
  return reward.coins !== undefined || reward.gems !== undefined || reward.boost !== undefined || Object.values(reward.shards ?? {}).some((amount) => amount !== undefined);
}

const tierSchema = z.object({ tier: z.number().int(), free: passRewardSchema, vip: passRewardSchema }).strict();

export type PassTierDef = z.infer<typeof tierSchema>;

/**
 * Лента месяца: ровно 30 ступеней подряд с единицы и сумма по каждому ресурсу
 * обеих лент не больше суточного потолка кошелька — иначе закрытие месяца,
 * выдающее всё незабранное разом, молча урезалось бы потолком (T-0312).
 */
export const passRibbonSchema = z
  .array(tierSchema)
  .length(PASS_TIERS)
  .superRefine((tiers, context) => {
    tiers.forEach((tier, index) => {
      if (tier.tier !== index + 1) context.addIssue({ code: "custom", message: `ступень ${String(index + 1)} названа ${String(tier.tier)}: номера идут подряд с единицы`, path: [index, "tier"] });
    });
    const sums = new Map<WalletResource, number>();
    for (const tier of tiers) {
      for (const lane of PASS_LANES) {
        for (const line of rewardLines(tier[lane])) sums.set(line.resource, (sums.get(line.resource) ?? 0) + line.amount);
      }
    }
    for (const [resource, sum] of sums) {
      if (sum > capOf(resource)) context.addIssue({ code: "custom", message: `${resource}: в обеих лентах ${String(sum)}, а суточный потолок кошелька — ${String(capOf(resource))}` });
    }
  });

/** Строки начисления кошельком: только ненулевое, осколки — ресурсами `shard_<редкость>`. Буст кошельку не нужен. */
export function rewardLines(reward: PassReward): { resource: WalletResource; amount: number }[] {
  const lines: { resource: WalletResource; amount: number }[] = [];
  if (reward.coins !== undefined) lines.push({ resource: "coins", amount: reward.coins });
  if (reward.gems !== undefined) lines.push({ resource: "gems", amount: reward.gems });
  for (const rarity of ITEM_RARITIES) {
    const amount = reward.shards?.[rarity];
    if (amount !== undefined) lines.push({ resource: `shard_${rarity}`, amount });
  }
  return lines;
}

/** Ключ журнала в наборе забранного: ступень и лента. */
export function claimKey(tier: number, lane: PassLane): string {
  return `${String(tier)}:${lane}`;
}

/**
 * Ключ начисления кошельком. Ресурс — часть ключа: у ступени их несколько, а
 * строка журнала кошелька одна на ресурс. Месяц и лента не дают ключу одной
 * ступени разных месяцев совпасть.
 */
export function passGrantKey(monthKey: string, tier: number, lane: PassLane, accountId: string, resource: WalletResource): string {
  return `pass:${monthKey}:${String(tier)}:${lane}:${accountId}:${resource}`;
}

export type ClaimBlock = "tier_not_reached" | "already_claimed" | "vip_required";

/**
 * Можно ли забрать награду. Порядок отказов — от самого точного для игрока:
 * ступень не достигнута важнее «уже забрана», а та — важнее «нужен VIP» (забранное
 * остаётся забранным, даже когда VIP кончился). VIP — на момент забора, а не на
 * момент ступени: купил посреди месяца — забираешь и пройденное.
 */
export function claimBlock(input: { tier: number; lane: PassLane; points: number; pointsPerTier: number; vipNow: boolean; claimed: ReadonlySet<string> }): ClaimBlock | null {
  if (!Number.isInteger(input.tier) || input.tier < 1 || input.tier > PASS_TIERS) return "tier_not_reached";
  if (tierOf(input.points, input.pointsPerTier) < input.tier) return "tier_not_reached";
  if (input.claimed.has(claimKey(input.tier, input.lane))) return "already_claimed";
  if (input.lane === "vip" && !input.vipNow) return "vip_required";
  return null;
}

export interface PassViewTier {
  tier: number;
  free: PassReward;
  vip: PassReward;
  claimed: Record<PassLane, boolean>;
}

/** Ответ `GET /api/v1/pass`. */
export interface PassView {
  monthKey: string;
  /** конец месяца: граница следующего по Москве, в UTC */
  endsAt: string;
  points: number;
  tier: number;
  pointsPerTier: number;
  vip: boolean;
  tiers: PassViewTier[];
}

export function passViewOf(input: { monthKey: string; points: number; pointsPerTier: number; vip: boolean; ribbon: readonly PassTierDef[]; claimed: ReadonlySet<string> }): PassView {
  return {
    monthKey: input.monthKey,
    endsAt: monthBounds(input.monthKey).endsAt.toISOString(),
    points: input.points,
    tier: tierOf(input.points, input.pointsPerTier),
    pointsPerTier: input.pointsPerTier,
    vip: input.vip,
    tiers: input.ribbon.map((tier) => ({
      tier: tier.tier,
      free: tier.free,
      vip: tier.vip,
      claimed: { free: input.claimed.has(claimKey(tier.tier, "free")), vip: input.claimed.has(claimKey(tier.tier, "vip")) },
    })),
  };
}
