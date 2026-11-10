/**
 * Правила окна перепроверки подписки после награды (docs/35-stage4-plan.md
 * Р115, tasks/T-0178). Чистые функции от времени: их гоняет проход по
 * расписанию, а тесты подставляют любое «сейчас».
 *
 * Константы живут здесь, а не в каталоге настроек. Срок окна и срок закрытия
 * записаны решением Р115 и меняются решением. Остальное предложил
 * `claude-lead2-1`, принял `claude-lead-1` (19.10.2026): правка этих значений
 * не меняет смысл правила, но не делается «на лету» из панели — от темпа
 * проверки зависит нагрузка на бота площадки.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Сколько после забора награды сервер проверяет, что игрок остался в канале (Р115). */
export const WATCH_MS = 7 * DAY_MS;
/** На сколько повторная отписка закрывает партнёрские задания (Р115). */
export const CLOSE_MS = 30 * DAY_MS;
/** Как часто окно спрашивает площадку: за неделю — 28 вопросов на награду. */
export const RECHECK_EVERY_MS = 6 * HOUR_MS;
/**
 * Через сколько после конца окна от него отказываются, так и не получив
 * ответа площадки: окно, которое не удалось проверить, штрафа не даёт.
 */
export const GIVE_UP_AFTER_MS = DAY_MS;
/** Как часто просыпается проход: окна к проверке берутся пачкой, а не по таймеру на каждое. */
export const TICK_MS = 5 * 60_000;
/** Сколько окон берёт один проход: остальные дождутся следующего, 5 минут спустя. */
export const BATCH = 200;
/** Сколько ждать ответа площадки на один вопрос. */
export const ASK_TIMEOUT_MS = 5_000;

/** Конец окна: неделя с момента забора награды. */
export function watchUntil(startedAt: Date): Date {
  return new Date(startedAt.getTime() + WATCH_MS);
}

/**
 * Когда спросить в следующий раз: через `RECHECK_EVERY_MS`, но не позже конца
 * окна — последняя проверка стоит ровно на исходе. Окно, уже закончившееся, а
 * ответа не получившее, спрашивают снова на ближайшем проходе, не в прошлом.
 */
export function nextCheckAfter(now: Date, until: Date): Date {
  const next = Math.min(now.getTime() + RECHECK_EVERY_MS, until.getTime());
  return new Date(Math.max(now.getTime(), next));
}

/** Проверка на исходе окна и позже: «состоит» после неё закрывает окно как сохранённое. */
export function isFinalCheck(now: Date, until: Date): boolean {
  return now.getTime() >= until.getTime();
}

/** Пора отказаться от окна, на которое площадка так и не ответила. */
export function shouldGiveUp(now: Date, until: Date): boolean {
  return now.getTime() >= until.getTime() + GIVE_UP_AFTER_MS;
}

/**
 * Закрывают ли партнёрские задания: со второго события отписки в том же
 * задании. Первое событие — предупреждение, списанная награда.
 */
export function closesPartnerTasks(eventNo: number): boolean {
  return eventNo >= 2;
}
