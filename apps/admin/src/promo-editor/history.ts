/**
 * Стопка отмены редактора промо (tasks/T-0274): снимки целиком, а не
 * команды — документ мал (до 40 слоёв), а снимок не нужно уметь «откатывать».
 * Неизменяемая: React кладёт её в состояние как есть.
 */

/** Сколько правок можно отменить подряд. */
export const HISTORY_LIMIT = 50;

export interface History<T> {
  past: readonly T[];
  present: T;
  future: readonly T[];
  limit: number;
  /** ключ последней правки: следующая с тем же ключом заменяет её, а не добавляет шаг */
  key: string | null;
}

export function createHistory<T>(present: T, limit: number = HISTORY_LIMIT): History<T> {
  return { past: [], present, future: [], limit, key: null };
}

/**
 * Новая правка. Тот же `key`, что у предыдущей, склеивает их в один шаг:
 * набор текста по букве или движок цвета не должны давать сотню отмен. Любая
 * правка обрывает «повтор»: вперёд из ветки, которую отменили, не вернуться.
 */
export function pushHistory<T>(history: History<T>, value: T, key: string | null = null): History<T> {
  if (key !== null && key === history.key) return { ...history, present: value, future: [] };
  const past = [...history.past, history.present];
  // Вытесняется самый старый шаг, а не отказ в новой правке.
  while (past.length > history.limit) past.shift();
  return { past, present: value, future: [], limit: history.limit, key };
}

export function undo<T>(history: History<T>): History<T> {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1] as T;
  return { ...history, past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future], key: null };
}

export function redo<T>(history: History<T>): History<T> {
  if (history.future.length === 0) return history;
  const next = history.future[0] as T;
  return { ...history, past: [...history.past, history.present], present: next, future: history.future.slice(1), key: null };
}

export const canUndo = (history: History<unknown>): boolean => history.past.length > 0;
export const canRedo = (history: History<unknown>): boolean => history.future.length > 0;
