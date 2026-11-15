import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";

/**
 * Правила времени для сообщений бота (docs/35-stage4-plan.md Р199, WP52,
 * правило 6): чистые функции без Redis, настроек и часов — время приходит
 * параметром, поэтому граница тихих часов и игровых суток проверяется тестом
 * без окружения.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Москва — UTC+3 круглый год (переходов на летнее время нет с 2014 года), так
 * что границу суток и час можно считать сдвигом, без таблицы поясов.
 */
const MOSCOW_OFFSET_MS = 3 * HOUR_MS;

const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: GAME_DAY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * Ближайший после `now` момент, когда по Москве наступает `toHour:00`, — конец
 * тихих часов. Равные начало и конец — тихих часов нет, ждать нечего: ответ —
 * сам `now`.
 */
export function quietEndsAt(now: Date, fromHour: number, toHour: number): Date {
  if (fromHour === toHour) return now;
  const local = now.getTime() + MOSCOW_OFFSET_MS;
  let end = Math.floor(local / DAY_MS) * DAY_MS + toHour * HOUR_MS;
  if (end <= local) end += DAY_MS;
  return new Date(end - MOSCOW_OFFSET_MS);
}

/** Игровые сутки `YYYY-MM-DD` по Москве — те же, что у заданий и награды дня. */
export function gameDayOf(now: Date): string {
  return DAY_FORMAT.format(now);
}

/** Ключ счётчика сообщений со звуком: аккаунт и игровые сутки. */
export function loudKey(accountId: string, gameDay: string): string {
  return `bot-loud:${accountId}:${gameDay}`;
}
