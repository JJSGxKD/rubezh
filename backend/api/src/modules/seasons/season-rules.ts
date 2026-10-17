import { DIFFICULTY_REWARD_MUL } from "../progress/progress-rules.js";
import type { Difficulty } from "../runs/run-rules.js";

/**
 * Правила недельного сезона рейтинга (docs/39-retention-mechanics.md, Р1;
 * tasks/T-0110). Чистые функции без базы и часов: время приходит параметром.
 *
 * **Неделя — календарная, UTC:** понедельник 00:00 включительно, следующий
 * понедельник 00:00 исключительно. Ключ сезона — дата понедельника
 * (`2026-11-02`), а не номер недели ISO: у номеров свои края на стыке годов.
 * Часовой пояс сервера на границу не влияет — всё считается по UTC.
 *
 * **Числа наград — стартовые**, их калибрует геймдизайнер правкой этого
 * файла; в панель они не вынесены, пока нет замеров. Награды не дают боевой
 * силы: монеты и престиж.
 */

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export interface Season {
  /** дата понедельника: `2026-11-02` */
  key: string;
  startsAt: Date;
  endsAt: Date;
}

function seasonFrom(startMs: number): Season {
  const startsAt = new Date(startMs);
  return { key: startsAt.toISOString().slice(0, 10), startsAt, endsAt: new Date(startMs + WEEK_MS) };
}

/** Начало суток понедельника, в чью неделю попадает момент. `getUTCDay`: 0 — воскресенье. */
function mondayOf(at: Date): number {
  const dayStart = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  return dayStart - ((at.getUTCDay() + 6) % 7) * DAY_MS;
}

/** Сезон, в который попадает момент. */
export function seasonOf(at: Date): Season {
  return seasonFrom(mondayOf(at));
}

const KEY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

/** Сезон по ключу; `null` — это не дата или не понедельник. */
export function seasonByKey(key: string): Season | null {
  if (!KEY_FORMAT.test(key)) return null;
  const startMs = Date.parse(`${key}T00:00:00Z`);
  if (Number.isNaN(startMs)) return null;
  const season = seasonFrom(startMs);
  // `2026-02-30` разбирается как март: сверка с обратным преобразованием отсекает такие даты.
  return season.key === key && season.startsAt.getUTCDay() === 1 ? season : null;
}

/**
 * Сколько недель назад может кончиться сезон, чтобы его ещё закрыли. Старше —
 * пропускаем: награда за давнюю неделю, розданная пачкой задним числом (дата
 * старта в прошлом, долгий простой сервера), хуже пропущенной награды.
 */
export const MAX_CATCH_UP_WEEKS = 2;

export interface DueSeasons {
  due: Season[];
  /** сколько закончившихся сезонов отброшено потолком догона */
  skipped: number;
}

/**
 * Закончившиеся к `now` сезоны с первого, по порядку, но не старше потолка
 * догона `MAX_CATCH_UP_WEEKS`. Закрытые среди них отсеивает вызывающий:
 * сервер лежал две недели — обе просрочены, и закрыть надо обе.
 */
export function dueSeasons(start: Date, now: Date): DueSeasons {
  const oldestEnd = now.getTime() - MAX_CATCH_UP_WEEKS * WEEK_MS;
  const due: Season[] = [];
  let skipped = 0;
  for (let startMs = mondayOf(start); startMs + WEEK_MS <= now.getTime(); startMs += WEEK_MS) {
    if (startMs + WEEK_MS < oldestEnd) skipped++;
    else due.push(seasonFrom(startMs));
  }
  return { due, skipped };
}

/** Самое раннее и самое позднее значение настройки: 8 цифр ГГГГММДД. */
const START_DATE_MIN = 10_000_101;
const START_DATE_MAX = 99_991_231;

/**
 * Значение настройки `seasons.start-date` (ГГГГММДД, например `20261102`) в
 * дату понедельника UTC. `0`, не дата и не понедельник — `null`: сезонов нет.
 */
export function parseStartDate(value: number): Date | null {
  if (!Number.isInteger(value) || value < START_DATE_MIN || value > START_DATE_MAX) return null;
  const year = Math.floor(value / 10_000);
  const month = Math.floor(value / 100) % 100;
  const day = value % 100;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.getUTCDay() === 1 ? date : null;
}

/** Сколько игроков должно быть на сложности, чтобы места в её таблице награждались. */
export const MIN_BOARD = 10;

/** Порог времени, секунды: дотянул хоть на одной сложности — награда всем. */
export const THRESHOLD_SEC: Record<Difficulty, number> = { easy: 180, normal: 150, hard: 90 };

export const THRESHOLD_REWARD = { coins: 150, prestige: 5 } as const;

export interface LadderStep {
  fromPlace: number;
  toPlace: number;
  coins: number;
  prestige: number;
}

/** Награда за место на лёгкой; на остальных умножается на множитель сложности. */
export const PLACE_LADDER: readonly LadderStep[] = [
  { fromPlace: 1, toPlace: 1, coins: 1_000, prestige: 100 },
  { fromPlace: 2, toPlace: 3, coins: 600, prestige: 50 },
  { fromPlace: 4, toPlace: 10, coins: 400, prestige: 25 },
  { fromPlace: 11, toPlace: 50, coins: 250, prestige: 10 },
];

/** Тот же множитель, что у награды за забег: сложнее — щедрее. */
export const DIFFICULTY_MUL: Record<Difficulty, number> = DIFFICULTY_REWARD_MUL;

/** Сколько строк живой таблицы отдаёт ручка — как у вечного рейтинга. */
export const BOARD_LIMIT = 50;

/** Сколько закрытых сезонов видно в истории. */
export const HISTORY_LIMIT = 8;

/** Сколько живёт ключ живой таблицы после конца сезона. */
export const BOARD_TTL_AFTER_END_MS = 21 * DAY_MS;

export interface Reward {
  coins: number;
  prestige: number;
}

export function thresholdReached(difficulty: Difficulty, bestSec: number): boolean {
  return bestSec >= THRESHOLD_SEC[difficulty];
}

/** Награда за место; `null` — места не награждаются: вне лестницы или таблица меньше `MIN_BOARD`. */
export function placeReward(place: number, boardSize: number, difficulty: Difficulty): Reward | null {
  if (!Number.isInteger(place) || place < 1 || boardSize < MIN_BOARD) return null;
  const step = PLACE_LADDER.find((candidate) => place >= candidate.fromPlace && place <= candidate.toPlace);
  if (step === undefined) return null;
  const mul = DIFFICULTY_MUL[difficulty];
  return { coins: Math.round(step.coins * mul), prestige: Math.round(step.prestige * mul) };
}

/** Итог аккаунта на одной сложности после закрытия сезона. */
export interface SeasonResultLine {
  difficulty: Difficulty;
  bestSec: number;
  place: number;
  boardSize: number;
}

export interface SeasonPrize extends Reward {
  kind: "place" | "threshold";
  /** сложность награды за место; у награды за порог её нет */
  difficulty: Difficulty | null;
  place: number | null;
}

/**
 * Единственная награда аккаунта за сезон. Награда за место заменяет награду
 * за порог и берётся с той сложности, где она больше, — не суммой по трём.
 * Ограничение рейтинга проверяет вызывающий: правила его не знают.
 */
export function rewardFor(results: readonly SeasonResultLine[]): SeasonPrize | null {
  let best: SeasonPrize | null = null;
  for (const line of results) {
    const reward = placeReward(line.place, line.boardSize, line.difficulty);
    if (reward === null) continue;
    const candidate: SeasonPrize = { kind: "place", difficulty: line.difficulty, place: line.place, ...reward };
    if (best === null || isBigger(candidate, best)) best = candidate;
  }
  if (best !== null) return best;
  if (results.some((line) => thresholdReached(line.difficulty, line.bestSec))) return { kind: "threshold", difficulty: null, place: null, ...THRESHOLD_REWARD };
  return null;
}

/** Больше — по монетам, при равенстве по престижу, при равенстве выше место. */
function isBigger(candidate: SeasonPrize, current: SeasonPrize): boolean {
  if (candidate.coins !== current.coins) return candidate.coins > current.coins;
  if (candidate.prestige !== current.prestige) return candidate.prestige > current.prestige;
  return (candidate.place ?? Infinity) < (current.place ?? Infinity);
}
