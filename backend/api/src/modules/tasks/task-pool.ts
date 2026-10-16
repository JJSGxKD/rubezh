import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import { POOL_TIERS, type PoolTier, type TaskDef } from "./task-rules.js";

/**
 * Ротация заданий (docs/39-retention-mechanics.md П1, решение Р102): из пула
 * строк ступени `tier` игрок каждый день видит дневной набор, каждую неделю —
 * недельный. Набор считает чистая функция от срока и пула: он одинаков у всех
 * игроков и на всех репликах, и его не нужно ни хранить, ни выбирать кроном.
 * Детерминизм — на целочисленной арифметике (`Math.imul`), без `Math.random()`.
 */

/** Сколько заданий каждой ступени в наборе (старт, калибрует геймдизайнер). */
export const POOL_QUOTA = {
  daily: { easy: 2, medium: 2, hard: 1 },
  weekly: { easy: 2, medium: 3, hard: 1 },
} as const satisfies Record<"daily" | "weekly", Record<PoolTier, number>>;

type PoolPeriod = keyof typeof POOL_QUOTA;

const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: GAME_DAY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const WEEKDAY_FORMAT = new Intl.DateTimeFormat("en-US", { timeZone: GAME_DAY_TIME_ZONE, weekday: "short" });
const WEEKDAYS_FROM_MONDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_MS = 86_400_000;

/** Игровые сутки момента — `YYYY-MM-DD` по Москве; та же граница, что у `periodStartSql`. */
export function gameDayOf(at: Date): string {
  return DAY_FORMAT.format(at);
}

/** Понедельник игровой недели момента — `YYYY-MM-DD`. */
export function gameWeekStartOf(at: Date): string {
  const day = gameDayOf(at);
  const offset = WEEKDAYS_FROM_MONDAY.indexOf(WEEKDAY_FORMAT.format(at));
  // Дата без времени в UTC: вычитание суток не зависит от пояса процесса.
  const monday = new Date(Date.parse(`${day}T00:00:00Z`) - Math.max(offset, 0) * DAY_MS);
  return monday.toISOString().slice(0, 10);
}

/** FNV-1a, 32 бита: зерно перемешивания из строки. */
function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: маленький генератор с зерном — в `[0, 1)`. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Перемешивание Фишера — Йейтса; вход не меняется. */
function shuffled<T>(items: readonly T[], seed: string): T[] {
  const next = generator(hashOf(seed));
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(next() * (index + 1));
    const held = result[index] as T;
    result[index] = result[other] as T;
    result[other] = held;
  }
  return result;
}

/**
 * Набор срока: по каждой ступени строки в порядке id перемешиваются на зерне
 * «срок:начало:ступень», берутся первые по квоте. Не хватило строк ступени
 * (выключены в панели) — добор из остатка пула тем же приёмом. Строки без
 * ступени и выключенные в набор не входят; порядок входного массива на
 * результат не влияет.
 */
export function pickPool(defs: readonly TaskDef[], period: PoolPeriod, periodStart: string): ReadonlySet<string> {
  const candidates = defs.filter((def) => def.active && def.period === period && def.tier !== null).sort((left, right) => (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0));
  const picked = new Set<string>();
  let missing = 0;
  for (const tier of POOL_TIERS) {
    const rows = candidates.filter((def) => def.tier === tier);
    const chosen = shuffled(rows, `${period}:${periodStart}:${tier}`).slice(0, POOL_QUOTA[period][tier]);
    for (const def of chosen) picked.add(def.taskId);
    missing += POOL_QUOTA[period][tier] - chosen.length;
  }
  if (missing > 0) {
    const rest = candidates.filter((def) => !picked.has(def.taskId));
    for (const def of shuffled(rest, `${period}:${periodStart}:fill`).slice(0, missing)) picked.add(def.taskId);
  }
  return picked;
}

/** Набор дня и недели на момент `at` — для панели. */
export function rotationAt(defs: readonly TaskDef[], at: Date): { daily: string[]; weekly: string[] } {
  return {
    daily: [...pickPool(defs, "daily", gameDayOf(at))].sort(),
    weekly: [...pickPool(defs, "weekly", gameWeekStartOf(at))].sort(),
  };
}

/**
 * Строки, которые в игре на момент `at`: всё без ступени (партнёрские цели,
 * достижения, добавленное руками) плюс выбранное из пула. Достижения и
 * партнёрские ступени не имеют по схеме; строка с `tier` вне дневных и
 * недельных (грязные данные) тоже остаётся в игре.
 */
export function inPlay(defs: readonly TaskDef[], at: Date): TaskDef[] {
  const daily = pickPool(defs, "daily", gameDayOf(at));
  const weekly = pickPool(defs, "weekly", gameWeekStartOf(at));
  return defs.filter((def) => {
    if (def.tier === null) return true;
    if (def.period === "daily") return daily.has(def.taskId);
    if (def.period === "weekly") return weekly.has(def.taskId);
    return true;
  });
}
