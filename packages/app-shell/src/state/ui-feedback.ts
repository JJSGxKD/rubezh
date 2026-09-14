import { audio, type UiSound } from "../audio";
import { haptic, type HapticEvent } from "./haptics";

/**
 * Отклик интерфейса на действие игрока — одна точка для кнопок, вкладок,
 * переключателей и листов. Компонент сообщает, что было нажато, а звучать и
 * вибрировать решает эта таблица (docs/31-audio-and-haptics.md §4).
 *
 * Звук интерфейса — только на значимые касания: щелчок на каждую строку
 * списка через минуту начинает раздражать сильнее, чем помогает.
 */
export type UiFeedback = "tap" | "select" | "primary" | "back" | "toggleOn" | "toggleOff" | "sheetOpen" | "sheetClose" | "reward" | "error";

const FEEDBACK: Record<UiFeedback, { sound: UiSound | null; haptic: HapticEvent | null }> = {
  tap: { sound: "tap", haptic: "tap" },
  select: { sound: "select", haptic: "select" },
  primary: { sound: "primary", haptic: "primary" },
  back: { sound: "back", haptic: "tap" },
  toggleOn: { sound: "toggleOn", haptic: "select" },
  toggleOff: { sound: "toggleOff", haptic: "select" },
  sheetOpen: { sound: "sheetOpen", haptic: null },
  sheetClose: { sound: "sheetClose", haptic: null },
  reward: { sound: "reward", haptic: "primary" },
  error: { sound: "error", haptic: null },
};

export function uiFeedback(kind: UiFeedback): void {
  const entry = FEEDBACK[kind];
  if (entry.haptic !== null) haptic(entry.haptic);
  if (entry.sound !== null) audio.ui(entry.sound);
}
