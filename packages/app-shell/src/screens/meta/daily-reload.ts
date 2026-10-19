import { msUntilReset } from "./schedule";

/**
 * Когда перечитать награду дня после смены суток по Москве
 * (tasks/T-0075). Запас — как на главной (`home-widgets.tsx`,
 * `MIDNIGHT_SLACK_MS`): часы телефона могут обгонять сервер, и ответ в
 * первую секунду полуночи ещё вчерашний.
 */
export const DAILY_RELOAD_SLACK_MS = 5_000;

/**
 * Через сколько миллисекунд перечитать награду, полученную в `loadedAtMs`.
 * Считается от момента получения, а не от `nowMs`: смена суток, которая
 * успела наступить между ответом и запуском таймера, не теряется — тогда
 * ответ 0, то есть сразу.
 */
export function dailyReloadDelayMs(loadedAtMs: number, nowMs: number): number {
  const target = loadedAtMs + msUntilReset(loadedAtMs, "daily") + DAILY_RELOAD_SLACK_MS;
  return Math.max(0, target - nowMs);
}
