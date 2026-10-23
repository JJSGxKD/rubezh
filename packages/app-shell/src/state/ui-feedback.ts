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
export type UiFeedback =
  | "tap"
  | "select"
  | "primary"
  | "back"
  | "toggleOn"
  | "toggleOff"
  | "sheetOpen"
  | "sheetClose"
  | "reward"
  | "wheelTick"
  | "wheelTickSlow"
  | "purchase"
  | "error";

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
  // Колесо: на быстром начале щелчки идут десятками в секунду — вибрация на
  // каждый слилась бы в дребезг, поэтому она только на медленном конце.
  wheelTick: { sound: "wheelTick", haptic: null },
  wheelTickSlow: { sound: "wheelTick", haptic: "select" },
  // Покупка — главное действие игрока в магазине, оно и отзывается крупно.
  purchase: { sound: "purchase", haptic: "primary" },
  error: { sound: "error", haptic: null },
};

export function uiFeedback(kind: UiFeedback): void {
  const entry = FEEDBACK[kind];
  if (entry.haptic !== null) haptic(entry.haptic);
  if (entry.sound !== null) audio.ui(entry.sound);
}

/** Что начислено — от этого зависит звук начисления поверх звона награды. */
export type RewardResource = "coins" | "gems" | "shards";

const ACCRUAL_SOUND: Record<RewardResource, UiSound> = { coins: "coins", gems: "gems", shards: "shards" };

/**
 * Забрана награда (design/art/direction-v2.md §7.6): общий звон, вибрация и
 * звук начисления той валюты, что пришла, — на слух понятно, что начислено,
 * ещё до цифры. Звук начисления звучит и без движения системы: это не
 * анимация.
 */
export function rewardFeedback(resource: RewardResource | null): void {
  uiFeedback("reward");
  if (resource !== null) audio.ui(ACCRUAL_SOUND[resource]);
}

/**
 * Валюта, которой звучит награда из нескольких: самоцвет слышнее монет,
 * монеты — осколков. Пустая награда — `null`: звучит только общий звон.
 */
export function mainAccrual(reward: { coins: number; gems: number; shards: number }): RewardResource | null {
  if (reward.gems > 0) return "gems";
  if (reward.coins > 0) return "coins";
  return reward.shards > 0 ? "shards" : null;
}

/**
 * Щелчок счёта баланса в шапке. Без вибрации: щелчков до восьми за
 * секунду, и вибрация на каждый слилась бы в дребезг, а награду уже
 * отметила вибрация забора.
 */
export function tallyTick(rate: number): void {
  audio.ui("tally", rate);
}
