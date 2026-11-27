import { formatNumber, hasTranslation, t } from "../../i18n";
import { PASS_TIERS, type PassGain, type PassLane, type PassReward, type PassSnapshot, type PassTarget } from "../../state/pass-api";

/**
 * Правила экрана батл-пасса (docs/35-stage4-plan.md Р46, tasks/T-0314) — чистые
 * функции без разметки и времени: очки до следующей ступени, что доступно к
 * забору, замок VIP, значок награды, срок месяца, адрес экрана. Ступень и право
 * на забор решает сервер; здесь только то, что нужно, чтобы показать их игроку.
 */

type Progress = Pick<PassSnapshot, "points" | "pointsPerTier" | "tier">;

export interface PassProgress {
  tier: number;
  /** тридцатая пройдена — очков больше не нужно */
  atMax: boolean;
  /** сколько очков набрано внутри текущей ступени */
  into: number;
  /** сколько очков на ступень */
  step: number;
  /** сколько не хватает до следующей; у последней — ноль */
  remaining: number;
}

export function pointsToNext(view: Progress): PassProgress {
  const step = Math.max(1, view.pointsPerTier);
  if (view.tier >= PASS_TIERS) return { tier: view.tier, atMax: true, into: step, step, remaining: 0 };
  const into = Math.min(step, Math.max(0, view.points - view.tier * step));
  return { tier: view.tier, atMax: false, into, step, remaining: step - into };
}

/**
 * Что можно забрать прямо сейчас: пройденные ступени, ещё не забранные; VIP —
 * только с VIP (на момент забора, а не покупки: купил посреди месяца — забираешь
 * и пройденное, Р46). Порядок — по ступеням, на одной ступени бесплатная раньше.
 */
export function claimableRewards(view: Pick<PassSnapshot, "tier" | "vip" | "tiers">, lane?: PassLane): PassTarget[] {
  const targets: PassTarget[] = [];
  for (const tier of [...view.tiers].sort((a, b) => a.tier - b.tier)) {
    if (tier.tier > view.tier) break;
    if ((lane === undefined || lane === "free") && !tier.claimed.free) targets.push({ tier: tier.tier, lane: "free" });
    if ((lane === undefined || lane === "vip") && view.vip && !tier.claimed.vip) targets.push({ tier: tier.tier, lane: "vip" });
  }
  return targets;
}

/**
 * Вид ячейки ленты: забрана, готова к забору, пройдена, но ждёт VIP, следующая
 * цель, впереди. Состояние — ещё и текстом и значком, не только цветом.
 */
export type CellState = "claimed" | "ready" | "locked" | "next" | "future";

export function cellState(view: Pick<PassSnapshot, "tier" | "vip" | "tiers">, tier: number, lane: PassLane): CellState {
  if (view.tiers.find((candidate) => candidate.tier === tier)?.claimed[lane] === true) return "claimed";
  if (tier <= view.tier) return lane === "vip" && !view.vip ? "locked" : "ready";
  return tier === view.tier + 1 ? "next" : "future";
}

/** Сколько наград VIP-ленты ещё не забрано: столько откроется с VIP, считая пройденные. */
export function lockedVipCount(view: Pick<PassSnapshot, "tiers">): number {
  return view.tiers.filter((tier) => !tier.claimed.vip).length;
}

/** Ступень, к которой листается лента при открытии: достигнутая, на нулевой — первая. */
export function focusTier(view: Pick<PassSnapshot, "tier">): number {
  return Math.min(PASS_TIERS, Math.max(1, view.tier));
}

const DAY_MS = 86_400_000;

/** Сколько суток до конца месяца, вверх: последний день — «ещё 1 дн.»; месяц кончился — ноль. */
export function daysLeft(endsAt: string, nowMs: number): number {
  const end = Date.parse(endsAt);
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, Math.ceil((end - nowMs) / DAY_MS));
}

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;
/** Месяц в родительном падеже берётся у даты с числом: отдельно названный месяц стоит в именительном. */
const MONTH_FORMAT = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "numeric", month: "long" });

/** «ноября» по ключу `ГГГГ-ММ`; мусор — `null`. */
export function monthGenitive(monthKey: string): string | null {
  const match = MONTH_KEY.exec(monthKey);
  if (match === null) return null;
  return MONTH_FORMAT.formatToParts(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1))).find((part) => part.type === "month")?.value ?? null;
}

/** Заголовок шапки: «Пасс ноября · ещё 12 дн.»; месяц кончился или ключ битый — без срока. */
export function passTitle(view: Pick<PassSnapshot, "monthKey" | "endsAt">, nowMs: number): string {
  const month = monthGenitive(view.monthKey);
  if (month === null) return t("pass.tab");
  const days = daysLeft(view.endsAt, nowMs);
  return days === 0 ? t("pass.titleEnded", { month }) : t("pass.title", { month, days });
}

const RARITY_ORDER = ["common", "uncommon", "rare", "epic", "legendary", "mythic"] as const;

/**
 * Главное в награде для значка в ячейке: самое ценное — самоцветы, монеты,
 * буст, осколки; `more` — в награде есть ещё что-то, ячейка ставит «+».
 */
export type RewardGlyph =
  | { kind: "gems" | "coins"; amount: number; more: boolean }
  | { kind: "boost"; id: string; amount: number; more: boolean }
  | { kind: "shard"; rarity: string; amount: number; more: boolean };

export function rewardGlyph(reward: PassReward): RewardGlyph | null {
  const shards = Object.entries(reward.shards ?? {}).filter(([, amount]) => amount > 0);
  const parts = [(reward.gems ?? 0) > 0, (reward.coins ?? 0) > 0, reward.boost !== undefined && reward.boost.count > 0, shards.length > 0].filter(Boolean).length;
  const more = parts > 1;
  if ((reward.gems ?? 0) > 0) return { kind: "gems", amount: reward.gems ?? 0, more };
  if ((reward.coins ?? 0) > 0) return { kind: "coins", amount: reward.coins ?? 0, more };
  if (reward.boost !== undefined && reward.boost.count > 0) return { kind: "boost", id: reward.boost.id, amount: reward.boost.count, more };
  // Среди осколков — самая редкая редкость; незнакомая от сервера новее клиента встаёт выше известных.
  const top = [...shards].sort(([a], [b]) => rarityRank(b) - rarityRank(a))[0];
  return top === undefined ? null : { kind: "shard", rarity: top[0], amount: top[1], more };
}

function rarityRank(rarity: string): number {
  const index = (RARITY_ORDER as readonly string[]).indexOf(rarity);
  return index < 0 ? RARITY_ORDER.length : index;
}

/** Награда словами — для диктора и подсказки: «120 монет, 5 осколков и Ярость ×1». */
export function rewardText(reward: PassReward): string {
  const gems = reward.gems ?? 0;
  const coins = reward.coins ?? 0;
  const shards = Object.values(reward.shards ?? {}).reduce((sum, amount) => sum + amount, 0);
  const parts = [
    coins > 0 ? t("task.reward.coins", { amount: formatNumber(coins), n: coins }) : null,
    gems > 0 ? t("task.reward.gems", { amount: formatNumber(gems), n: gems }) : null,
    shards > 0 ? t("task.reward.shards", { amount: formatNumber(shards), n: shards }) : null,
    reward.boost === undefined ? null : t("pass.reward.boost", { name: boostName(reward.boost.id), n: reward.boost.count }),
  ].filter((part): part is string => part !== null);
  return parts.join(t("tasks.and"));
}

/** Название буста из его словаря; буст, которого клиент не знает, — просто «буст». */
export function boostName(id: string): string {
  const key = `boost.${id}.name`;
  return hasTranslation(key) ? t(key) : t("pass.reward.boostUnknown");
}

/** Итог «Забрать всё» словами: что легло на счёт. Пусто — пустая строка. */
export function gainText(gain: PassGain): string {
  const parts = [
    gain.coins > 0 ? t("task.reward.coins", { amount: formatNumber(gain.coins), n: gain.coins }) : null,
    gain.gems > 0 ? t("task.reward.gems", { amount: formatNumber(gain.gems), n: gain.gems }) : null,
    gain.shards > 0 ? t("task.reward.shards", { amount: formatNumber(gain.shards), n: gain.shards }) : null,
    gain.boosts > 0 ? t("pass.gain.boosts", { n: gain.boosts }) : null,
  ].filter((part): part is string => part !== null);
  return parts.join(t("tasks.and"));
}

/** Подпись ячейки для диктора: ступень, лента, награда, состояние. */
export function cellLabel(tier: number, lane: PassLane, reward: PassReward, state: CellState): string {
  return t("pass.cell.label", { tier, lane: t(`pass.lane.${lane}`), reward: rewardText(reward), state: t(`pass.state.${state}`) });
}
