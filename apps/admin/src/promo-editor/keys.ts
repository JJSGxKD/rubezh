/**
 * Клавиши редактора промо (tasks/T-0274): событие клавиатуры → команда.
 * Чистая функция: решать, обрабатывать ли клавишу в поле ввода, — дело
 * компонента, а какая комбинация что значит — здесь, и это проверяет тест.
 */

export type EditorCommand = { type: "delete" } | { type: "undo" } | { type: "redo" } | { type: "duplicate" } | { type: "nudge"; dx: number; dy: number };

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Шаг стрелки и шаг с Shift, точек холста. */
export const NUDGE_STEP = 1;
export const NUDGE_STEP_SHIFT = 10;

/**
 * Буква — по физической клавише (`code`), а не по символу: на русской
 * раскладке Ctrl+Я стоит там же, где Ctrl+Z, и привычка не должна ломаться.
 */
function isLetter(event: KeyLike, letter: "z" | "y" | "d"): boolean {
  return event.code === `Key${letter.toUpperCase()}` || event.key.toLowerCase() === letter;
}

export function commandForKey(event: KeyLike): EditorCommand | null {
  const mod = event.ctrlKey || event.metaKey;

  if (mod && !event.altKey) {
    if (isLetter(event, "z")) return event.shiftKey ? { type: "redo" } : { type: "undo" };
    if (isLetter(event, "y")) return { type: "redo" };
    if (isLetter(event, "d")) return { type: "duplicate" };
    return null;
  }
  if (mod || event.altKey) return null;

  if (event.key === "Delete" || event.key === "Backspace") return { type: "delete" };
  const step = event.shiftKey ? NUDGE_STEP_SHIFT : NUDGE_STEP;
  if (event.key === "ArrowLeft") return { type: "nudge", dx: -step, dy: 0 };
  if (event.key === "ArrowRight") return { type: "nudge", dx: step, dy: 0 };
  if (event.key === "ArrowUp") return { type: "nudge", dx: 0, dy: -step };
  if (event.key === "ArrowDown") return { type: "nudge", dx: 0, dy: step };
  return null;
}
