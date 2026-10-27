/**
 * События постбэков (tasks/T-0069, docs/35-stage4-plan.md Р86, Р96): что игра
 * сообщает назначениям. Код события лежит в колонке `ad_conversion.goal`:
 * 1–3 совпадают с `goaltype` AdsGram, 4 — возврат на следующий день. Колонку
 * не переименовывали, чтобы откат релиза не ломал схему.
 */

export const POSTBACK_EVENTS = ["registration", "purchase_first", "purchase_repeat", "d1_return"] as const;
export type PostbackEvent = (typeof POSTBACK_EVENTS)[number];

export const EVENT_GOAL = { registration: 1, purchase_first: 2, purchase_repeat: 3, d1_return: 4 } as const satisfies Record<PostbackEvent, number>;

/** Событие по коду из базы; неизвестный код — ошибка, а не «регистрация». */
export function eventOfGoal(goal: number): PostbackEvent {
  for (const event of POSTBACK_EVENTS) {
    if (EVENT_GOAL[event] === goal) return event;
  }
  throw new Error(`Неизвестный код события постбэка: ${String(goal)}`);
}

/** Коды, которые код этого релиза умеет читать: всё остальное в базе он не трогает. */
export const KNOWN_GOALS: readonly number[] = POSTBACK_EVENTS.map((event) => EVENT_GOAL[event]);
