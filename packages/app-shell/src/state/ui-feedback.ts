import { haptic } from "./haptics";

/**
 * Отклик интерфейса на действие игрока — одна точка для кнопок, вкладок и
 * переключателей. Сюда же приходит звук интерфейса: компонент не должен
 * решать, вибрировать ему или звучать, он сообщает, что было нажато.
 */
export type UiFeedback = "tap" | "select" | "primary" | "reward";

export function uiFeedback(kind: UiFeedback): void {
  haptic(kind === "reward" ? "primary" : kind);
}
