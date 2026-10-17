import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";

/** `en-CA` печатает дату как `2026-10-16` — готовый ключ без ручной сборки. */
const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: GAME_DAY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * Игровые сутки момента времени как ключ: тот же московский день, по которому
 * идут задания и награда дня. Считается в коде, а не базой: счётчику онлайна
 * база не нужна, а границу задаёт одна и та же зона.
 */
export function gameDayKey(at: Date): string {
  return formatter.format(at);
}
