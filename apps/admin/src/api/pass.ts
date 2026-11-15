import { z } from "zod";
import { plural } from "../format";
import type { AdminApi, ApiResult } from "./client";

/**
 * Ленты батл-пасса по месяцам (`/admin/pass/seasons`, docs/35-stage4-plan.md
 * Р46, §3.15; tasks/T-0313) — под `pass.edit`. 30 ступеней двух лент: бесплатной
 * и VIP; награда ступени — монеты, самоцветы, осколки по редкостям и буст, без
 * случайного (Р11). Пределы количеств и список бустов приходят с сервера, форма
 * проверяет по ним то, что видно без базы; остальное — правила сервера: прошлый
 * месяц только для чтения, пройденные игроками ступени не правятся.
 */

export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary", "mythic"] as const;
export type Rarity = (typeof RARITIES)[number];

/** Прилагательное редкости: «обычные осколки», «эпические». */
const RARITY_ADJECTIVES: Record<Rarity, string> = { common: "обычные", uncommon: "добротные", rare: "редкие", epic: "эпические", legendary: "легендарные", mythic: "мифические" };
const RARITY_GENITIVES: Record<Rarity, string> = { common: "обычных", uncommon: "добротных", rare: "редких", epic: "эпических", legendary: "легендарных", mythic: "мифических" };

/** Сколько бустов одного вида можно подарить за ступень — предел сервера (`BOOST_GIFT_MAX`). */
export const BOOST_COUNT_MAX = 10;

const rewardSchema = z.object({
  coins: z.number().optional(),
  gems: z.number().optional(),
  shards: z.object({ common: z.number().optional(), uncommon: z.number().optional(), rare: z.number().optional(), epic: z.number().optional(), legendary: z.number().optional(), mythic: z.number().optional() }).optional(),
  boost: z.object({ id: z.string(), count: z.number() }).optional(),
});
export type PassReward = z.infer<typeof rewardSchema>;

const tierSchema = z.object({ tier: z.number(), free: rewardSchema, vip: rewardSchema });
export type PassTier = z.infer<typeof tierSchema>;

export const PHASE_TITLES: Record<string, string> = { past: "прошлый", current: "идёт сейчас", future: "будущий" };

const rowSchema = z.object({ monthKey: z.string(), phase: z.string(), saved: z.boolean(), published: z.boolean() });
export type PassSeasonRow = z.infer<typeof rowSchema>;

const seasonsSchema = z.object({ currentMonth: z.string(), nextMonth: z.string(), months: z.array(rowSchema) });
export type PassSeasons = z.infer<typeof seasonsSchema>;

const seasonSchema = rowSchema.extend({
  publishedAt: z.string().nullable(),
  pointsPerTier: z.number(),
  lockedTiers: z.number(),
  tiers: z.array(tierSchema),
  caps: z.record(z.string(), z.number()),
  boosts: z.array(z.string()),
});
export type PassSeason = z.infer<typeof seasonSchema>;

const BASE = "/pass/seasons";

export function fetchSeasons(api: AdminApi): Promise<ApiResult<PassSeasons>> {
  return api.request(BASE, { schema: seasonsSchema });
}

export function fetchSeason(api: AdminApi, month: string): Promise<ApiResult<PassSeason>> {
  return api.request(`${BASE}/${encodeURIComponent(month)}`, { schema: seasonSchema });
}

/** Завести ленту месяца: `from` — копия того месяца, `null` — лента по умолчанию. */
export function createSeason(api: AdminApi, month: string, from: string | null): Promise<ApiResult<PassSeason>> {
  return api.request(BASE, { method: "POST", body: from === null ? { month } : { month, from }, schema: seasonSchema });
}

export function saveTier(api: AdminApi, month: string, tier: number, edit: { free: PassReward; vip: PassReward }): Promise<ApiResult<PassSeason>> {
  return api.request(`${BASE}/${encodeURIComponent(month)}/tiers/${String(tier)}`, { method: "PUT", body: edit, schema: seasonSchema });
}

export function publishSeason(api: AdminApi, month: string): Promise<ApiResult<PassSeason>> {
  return api.request(`${BASE}/${encodeURIComponent(month)}/publish`, { method: "POST", schema: seasonSchema });
}

const MONTH_NAMES = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

/** «2026-11» → «Ноябрь 2026». */
export function monthTitle(monthKey: string): string {
  const [year, month] = monthKey.split("-");
  const name = MONTH_NAMES[Number(month) - 1];
  if (name === undefined || year === undefined) return monthKey;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${year}`;
}

/** Суммы наград: монеты, самоцветы, осколки по редкостям и бусты по видам. */
export interface RewardTotals {
  coins: number;
  gems: number;
  shards: Partial<Record<Rarity, number>>;
  boosts: Record<string, number>;
}

export interface RibbonTotals {
  free: RewardTotals;
  vip: RewardTotals;
  total: RewardTotals;
}

function emptyTotals(): RewardTotals {
  return { coins: 0, gems: 0, shards: {}, boosts: {} };
}

function addReward(into: RewardTotals, reward: PassReward): void {
  into.coins += reward.coins ?? 0;
  into.gems += reward.gems ?? 0;
  for (const rarity of RARITIES) {
    const amount = reward.shards?.[rarity];
    if (amount !== undefined) into.shards[rarity] = (into.shards[rarity] ?? 0) + amount;
  }
  if (reward.boost !== undefined) into.boosts[reward.boost.id] = (into.boosts[reward.boost.id] ?? 0) + reward.boost.count;
}

/** Сколько уходит в экономику за месяц, если игрок заберёт всё: по лентам и вместе. */
export function ribbonTotals(tiers: readonly PassTier[]): RibbonTotals {
  const totals: RibbonTotals = { free: emptyTotals(), vip: emptyTotals(), total: emptyTotals() };
  for (const tier of tiers) {
    addReward(totals.free, tier.free);
    addReward(totals.vip, tier.vip);
    addReward(totals.total, tier.free);
    addReward(totals.total, tier.vip);
  }
  return totals;
}

export interface TotalsLine {
  key: string;
  title: string;
  amount: number;
}

/** Строки таблицы сумм: только то, что в ленте есть. Порядок: монеты, самоцветы, осколки от обычных к мифическим, бусты. */
export function totalsLines(totals: RewardTotals): TotalsLine[] {
  const lines: TotalsLine[] = [];
  if (totals.coins > 0) lines.push({ key: "coins", title: "Монеты", amount: totals.coins });
  if (totals.gems > 0) lines.push({ key: "gems", title: "Самоцветы", amount: totals.gems });
  for (const rarity of RARITIES) {
    const amount = totals.shards[rarity];
    if (amount !== undefined && amount > 0) lines.push({ key: `shard_${rarity}`, title: `${capitalize(RARITY_ADJECTIVES[rarity])} осколки`, amount });
  }
  for (const [id, amount] of Object.entries(totals.boosts).sort(([a], [b]) => a.localeCompare(b))) lines.push({ key: `boost_${id}`, title: `Буст «${id}»`, amount });
  return lines;
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** Подпись ячейки: все виды награды через точку; пустая — тире. */
export function describeReward(reward: PassReward): string {
  const parts: string[] = [];
  if (reward.coins !== undefined) parts.push(`${String(reward.coins)} ${plural(reward.coins, ["монета", "монеты", "монет"])}`);
  if (reward.gems !== undefined) parts.push(`${String(reward.gems)} ${plural(reward.gems, ["самоцвет", "самоцвета", "самоцветов"])}`);
  const shards = RARITIES.flatMap((rarity) => {
    const amount = reward.shards?.[rarity];
    return amount === undefined ? [] : [`${RARITY_ADJECTIVES[rarity]} ${String(amount)}`];
  });
  if (shards.length > 0) parts.push(`осколки: ${shards.join(", ")}`);
  if (reward.boost !== undefined) parts.push(`буст «${reward.boost.id}» ×${String(reward.boost.count)}`);
  return parts.length === 0 ? "—" : parts.join(" · ");
}

/** Поля формы награды — строками: пустое и ноль значат «нет». */
export interface RewardDraft {
  coins: string;
  gems: string;
  common: string;
  uncommon: string;
  rare: string;
  epic: string;
  legendary: string;
  mythic: string;
  boostId: string;
  boostCount: string;
}

export function rewardDraft(reward: PassReward): RewardDraft {
  const text = (value: number | undefined): string => (value === undefined ? "" : String(value));
  return {
    coins: text(reward.coins),
    gems: text(reward.gems),
    common: text(reward.shards?.common),
    uncommon: text(reward.shards?.uncommon),
    rare: text(reward.shards?.rare),
    epic: text(reward.shards?.epic),
    legendary: text(reward.shards?.legendary),
    mythic: text(reward.shards?.mythic),
    boostId: reward.boost?.id ?? "",
    boostCount: text(reward.boost?.count),
  };
}

/** Целое от единицы; всё остальное, в том числе пустое и ноль, — «нет». */
function amountOf(text: string): number | undefined {
  const value = Number(text.trim());
  return /^\d+$/.test(text.trim()) && value > 0 ? value : undefined;
}

/** Награда из формы — после `draftProblem`: нулевое и пустое в неё не попадает. */
export function draftReward(draft: RewardDraft): PassReward {
  const reward: PassReward = {};
  const coins = amountOf(draft.coins);
  if (coins !== undefined) reward.coins = coins;
  const gems = amountOf(draft.gems);
  if (gems !== undefined) reward.gems = gems;
  const shards: NonNullable<PassReward["shards"]> = {};
  for (const rarity of RARITIES) {
    const amount = amountOf(draft[rarity]);
    if (amount !== undefined) shards[rarity] = amount;
  }
  if (Object.keys(shards).length > 0) reward.shards = shards;
  const count = amountOf(draft.boostCount);
  if (draft.boostId !== "" && count !== undefined) reward.boost = { id: draft.boostId, count };
  return reward;
}

/** Что не так с формой награды по пределам сервера; `null` — можно отправлять. */
export function draftProblem(draft: RewardDraft, caps: Readonly<Record<string, number>>, boostIds: readonly string[]): string | null {
  const checks: { text: string; title: string; cap: number | undefined }[] = [
    { text: draft.coins, title: "Монеты", cap: caps.coins },
    { text: draft.gems, title: "Самоцветы", cap: caps.gems },
    ...RARITIES.map((rarity) => ({ text: draft[rarity], title: `Осколки ${RARITY_GENITIVES[rarity]}`, cap: caps[`shard_${rarity}`] })),
  ];
  for (const { text, title, cap } of checks) {
    const trimmed = text.trim();
    if (trimmed === "") continue;
    if (!/^\d+$/.test(trimmed)) return `${title} — целое число, не меньше нуля`;
    if (cap !== undefined && Number(trimmed) > cap) return `${title} — не больше ${String(cap)}`;
  }
  if (draft.boostId !== "" || draft.boostCount.trim() !== "") {
    const count = Number(draft.boostCount.trim());
    if (!boostIds.includes(draft.boostId)) return "Буст — выберите из списка";
    if (!/^\d+$/.test(draft.boostCount.trim()) || count < 1 || count > BOOST_COUNT_MAX) return `Буст — число от 1 до ${String(BOOST_COUNT_MAX)}`;
  }
  return Object.keys(draftReward(draft)).length === 0 ? "В награде ничего нет" : null;
}
