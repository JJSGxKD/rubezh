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

/** Названия событий для панели и аудита; порядок ключей — канонический. */
export const EVENT_TITLES: Record<PostbackEvent, string> = {
  registration: "Регистрация",
  purchase_first: "Первая покупка",
  purchase_repeat: "Повторная покупка",
  d1_return: "Возврат на следующий день",
};

/** События назначения, пока их не выбрали: одна регистрация. Совпадает с умолчанием колонок `postback_events`. */
export const DEFAULT_EVENTS: readonly PostbackEvent[] = ["registration"];

export function isPostbackEvent(value: unknown): value is PostbackEvent {
  return typeof value === "string" && (POSTBACK_EVENTS as readonly string[]).includes(value);
}

/** Имя события для текста проблемы: чужой ввод короткой строкой, а не простынёй. */
function shown(value: unknown): string {
  return String(value).slice(0, 40);
}

/**
 * Что не так со списком событий, выбранных у назначения; пусто — годится. Порядок и повторы не ошибка —
 * их приводит `normalizeEvents`. Тексты видит человек в панели.
 */
export function eventsProblems(events: unknown): string[] {
  if (!Array.isArray(events)) return ["События должны быть списком"];
  if (events.length === 0) return ["Выберите хотя бы одно событие"];
  const unknown = new Set<string>();
  for (const event of events as unknown[]) {
    if (!isPostbackEvent(event)) unknown.add(shown(event));
  }
  return [...unknown].map((name) => `Неизвестное событие: ${name}`);
}

/** Список в каноническом порядке и без повторов: так он лежит в базе и так его видят в панели. */
export function normalizeEvents(events: readonly PostbackEvent[]): PostbackEvent[] {
  return POSTBACK_EVENTS.filter((event) => events.includes(event));
}
