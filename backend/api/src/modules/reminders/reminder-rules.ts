import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import type { Season } from "../seasons/season-rules.js";

/**
 * Правила напоминаний бота (tasks/T-0128, docs/39-retention-mechanics.md П5).
 * Чистые функции без базы, Redis и часов: время приходит параметром, поэтому
 * граница тихих часов и «дня перед закрытием» проверяется тестом без окружения.
 */

/**
 * Виды напоминаний в порядке приоритета: игроку в окно потолка достаётся один
 * вид — первый из подходящих (`chooseKind`).
 */
export const REMINDER_KINDS = ["season_overtaken", "season_closing", "daily_reward_ready"] as const;

export type ReminderKind = (typeof REMINDER_KINDS)[number];

export function isReminderKind(kind: string): kind is ReminderKind {
  return (REMINDER_KINDS as readonly string[]).includes(kind);
}

/** Как часто планировщик просыпается. */
export const SCAN_INTERVAL_MS = 600_000;

/** Сколько кандидатов каждого вида планировщик берёт за один проход. */
export const TICK_LIMIT = 500;

/** Сколько первых мест таблицы недели хранит снимок «кого обогнали». */
export const SNAPSHOT_TOP = 100;

/** Данные кнопки «Не напоминать» (≤ 64 байт у Telegram); нажатие разбирает `platforms/telegram/reminders-off.command.ts`. */
export const REMINDER_OFF_DATA = "rm:off";

/**
 * Ключ окна потолка: общий на три вида, ставит его отправитель (`SET NX EX`),
 * а планировщик только спрашивает, занято ли оно, чтобы не заводить строку
 * ленты там, где бот всё равно промолчит.
 */
export function reminderWindowKey(accountId: string): string {
  return `bot-notify:${accountId}:reminder`;
}

const HOUR_FORMAT = new Intl.DateTimeFormat("en-GB", { timeZone: GAME_DAY_TIME_ZONE, hour: "2-digit", hourCycle: "h23" });

/** Час суток по Москве, 0–23: тот же пояс, что у игровых суток. */
export function moscowHour(at: Date): number {
  return Number(HOUR_FORMAT.format(at));
}

/**
 * Тихий час: бот молчит. Окно `[from, to)` по часам Москвы, может переходить
 * через полночь (21 → 10); равные начало и конец — тихих часов нет.
 */
export function isQuietHour(at: Date, fromHour: number, toHour: number): boolean {
  if (fromHour === toHour) return false;
  const hour = moscowHour(at);
  return fromHour < toHour ? hour >= fromHour && hour < toHour : hour >= fromHour || hour < toHour;
}

const DAY_MS = 86_400_000;

/**
 * Игровые сутки перед закрытием сезона (`YYYY-MM-DD`): сезон кончается в
 * понедельник 00:00 UTC, а это 03:00 по Москве — в сутки закрытия игрок
 * уже опоздал, поэтому зовём накануне.
 */
export function closingDay(season: Pick<Season, "endsAt">): string {
  const endDay = new Intl.DateTimeFormat("en-CA", { timeZone: GAME_DAY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(season.endsAt);
  // Дата без времени в UTC: вычитание суток не зависит от пояса процесса.
  return new Date(Date.parse(`${endDay}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

/** Строка снимка таблицы недели: место и лучшее время игрока в прошлый проход. */
export interface SnapshotEntry {
  accountId: string;
  rank: number;
  score: number;
}

/** Где игрок сейчас: место и лучшее время. */
export interface CurrentPlace {
  rank: number;
  score: number;
}

export interface OvertakenPlayer {
  accountId: string;
  /** новое место, с единицы */
  place: number;
}

/**
 * Кого обогнали с прошлого прохода: лучшее время то же, а место хуже. Игрок,
 * чей результат вырос, не «обогнан» — он сам сдвинул таблицу; игрока, которого
 * в таблице больше нет (снят модератором), не трогаем. Вышедший за сотню мест
 * в снимке остаётся: его место читается из таблицы целиком, а не из сотни.
 * Без прежнего снимка (первый проход сезона) сравнивать не с чем.
 */
export function overtaken(before: readonly SnapshotEntry[] | null, now: ReadonlyMap<string, CurrentPlace>): OvertakenPlayer[] {
  if (before === null) return [];
  const result: OvertakenPlayer[] = [];
  for (const entry of before) {
    const current = now.get(entry.accountId);
    if (current !== undefined && current.score === entry.score && current.rank > entry.rank) result.push({ accountId: entry.accountId, place: current.rank });
  }
  return result;
}

/** Всё, что решает судьбу напоминания игроку, — собранное из базы, Redis и настроек. */
export interface ReminderCandidate {
  /** виды, по которым игрок сейчас подходит */
  kinds: readonly ReminderKind[];
  /** разрешил боту писать и не заблокировал его */
  canMessage: boolean;
  /** выключил напоминания в настройках или кнопкой под сообщением */
  optedOut: boolean;
  /** в окне потолка уже есть напоминание */
  windowBusy: boolean;
}

/** Какой вид напомнить игроку; `null` — никакой. Один вид на окно потолка, по приоритету `REMINDER_KINDS`. */
export function chooseKind(candidate: ReminderCandidate): ReminderKind | null {
  if (!candidate.canMessage || candidate.optedOut || candidate.windowBusy) return null;
  return REMINDER_KINDS.find((kind) => candidate.kinds.includes(kind)) ?? null;
}

/** Ключи событий ленты: повтор прохода второй строки не заводит. */
export const reminderDedupeKey = {
  seasonOvertaken: (seasonKey: string, gameDay: string): string => `season_overtaken:${seasonKey}:${gameDay}`,
  seasonClosing: (seasonKey: string): string => `season_closing:${seasonKey}`,
  dailyRewardReady: (gameDay: string): string => `daily_reward_ready:${gameDay}`,
} as const;
