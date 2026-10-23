import type { ChestReward } from "@bh/shared-types";
import type { TranslationParams } from "../../i18n";

/**
 * Окно сундука забега (tasks/T-0100): награды уже выдал движок, окно только
 * показывает их. Правила — чистые функции без случайности: компоненты в тестах
 * приложения не рисуются, а одни и те же награды обязаны выглядеть одинаково
 * при каждом показе.
 */

/** Сколько плиток в ленте «барабана»: пять отвлекающих и итоговая. */
export const REEL_LENGTH = 6;

/** Заголовок окна по размеру сундука; неизвестный размер читается как обычный. */
export function chestTitleKey(size: number): string {
  return size === 1 || size === 5 ? `run.chest.title.${String(size)}` : "run.chest.title.3";
}

export type RewardIcon = "weapon" | "passive" | "heal" | "xp";
export type RewardTag = { kind: "new" } | { kind: "level"; level: number } | null;

export interface RewardView {
  icon: RewardIcon;
  refId: string;
  tag: RewardTag;
}

/** Что рисовать у награды: значок, id предмета и метку «новое» / «уровень N». */
export function rewardView(reward: ChestReward): RewardView {
  switch (reward.kind) {
    case "weapon_new":
      return { icon: "weapon", refId: reward.refId, tag: { kind: "new" } };
    case "passive_new":
      return { icon: "passive", refId: reward.refId, tag: { kind: "new" } };
    case "weapon_level":
      return { icon: "weapon", refId: reward.refId, tag: { kind: "level", level: reward.level } };
    // Эволюция — новое оружие в слоте базового; своя метка и подсказка — в T-0103.
    case "weapon_evolve":
      return { icon: "weapon", refId: reward.refId, tag: { kind: "new" } };
    case "passive_level":
      return { icon: "passive", refId: reward.refId, tag: { kind: "level", level: reward.level } };
    case "heal":
      return { icon: "heal", refId: "", tag: null };
    case "xp":
      return { icon: "xp", refId: "", tag: null };
  }
}

/** Метка запасных наград на ленте: у них нет id предмета. */
const FALLBACK_TILE = "xp";

/**
 * Шесть id плиток ленты: пять отвлекающих и итоговая — награда. Отвлекающие
 * берутся из `pool` по кругу со сдвигом на номер награды, чтобы у соседних
 * строк ленты были разными; итоговую среди них пропускаем. Случайности нет:
 * одни аргументы дают одну ленту.
 */
export function reelStrip(rewardIndex: number, reward: ChestReward, pool: readonly string[]): string[] {
  const last = reward.refId === "" ? reward.kind : reward.refId;
  const candidates = pool.filter((id) => id !== last);
  const strip: string[] = [];
  for (let i = 0; i < REEL_LENGTH - 1; i++) {
    strip.push(candidates.length === 0 ? FALLBACK_TILE : (candidates[(rewardIndex + i) % candidates.length] ?? FALLBACK_TILE));
  }
  strip.push(last);
  return strip;
}

/** Строка для скринридера: окно показывает награды, но читает их не только глазами. */
export function announceText(names: readonly string[], t: (key: string, vars?: TranslationParams) => string): string {
  return t("run.chest.announce", { names: names.join(", ") });
}
