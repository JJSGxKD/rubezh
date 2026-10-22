import type { ChestReward, UpgradeChange } from "@bh/shared-types";
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

/**
 * Ярус сундука для сцены открытия. Размер — сколько наград внутри, ярус —
 * насколько громко сундук о себе заявляет: игрок должен понять, что выпал
 * большой, ещё до того, как увидит награды.
 */
export type ChestTier = "small" | "medium" | "grand";

export function chestTier(size: number): ChestTier {
  return size === 1 ? "small" : size === 5 ? "grand" : "medium";
}

export interface ChestLook {
  /** сколько искр вылетает при вскрытии */
  sparks: number;
  /** тон оковки, лучей и искр — токен палитры */
  tone: string;
  /**
   * Тряска до вскрытия, мс. Малый сундук падает с каждой элиты — его тряска
   * короткая, чтобы не мешать бою; большой редок, и предвкушение длиннее.
   */
  shakeMs: number;
}

/**
 * Малый — жар очага, средний — бирюза оберегов, большой — золото элиты: тон
 * растёт от обычного действия к редкой добыче, как у кристаллов опыта.
 */
export const CHEST_LOOKS: Record<ChestTier, ChestLook> = {
  small: { sparks: 10, tone: "var(--color-accent)", shakeMs: 450 },
  medium: { sparks: 16, tone: "var(--color-secondary)", shakeMs: 650 },
  grand: { sparks: 26, tone: "var(--color-elite)", shakeMs: 900 },
};

/**
 * Расписание сцены после вскрытия, мс. Тряска до него — у яруса
 * (`CHEST_LOOKS`); касание сундука вскрывает сразу.
 */
export const CHEST_TIMING = {
  /** от вскрытия до старта первой ленты: искры успевают разлететься */
  firstRevealMs: 200,
  /** лента «барабана» до остановки на награде */
  reelMs: 650,
  /** шаг между наградами: каждая встаёт своим звоном */
  revealGapMs: 320,
} as const;

/**
 * Когда встаёт каждая награда — от вскрытия. По этим же числам звучат звоны,
 * поэтому без движения всё встаёт сразу: звук не догоняет пустую картинку.
 */
export function revealTimes(count: number, reducedMotion: boolean): number[] {
  return Array.from({ length: count }, (_, index) =>
    reducedMotion ? 0 : CHEST_TIMING.firstRevealMs + CHEST_TIMING.reelMs + index * CHEST_TIMING.revealGapMs,
  );
}

export interface SparkVector {
  /** куда долетает искра, px от центра сундука */
  x: number;
  y: number;
  /** задержка вылета, мс: искры одной пачкой читаются кольцом, а не фонтаном */
  delayMs: number;
}

/**
 * Разлёт искр веером по золотому углу: равномерно во все стороны и без
 * случайности — одна и та же сцена при каждом показе и в снимках. Вверх
 * летят дальше: свет «выплёскивается» из-под крышки.
 */
export function sparkVectors(count: number): SparkVector[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: count }, (_, index) => {
    const angle = index * golden;
    const reach = 70 + ((index * 37) % 60);
    const x = Math.cos(angle) * reach;
    const y = Math.sin(angle) * reach;
    return { x: Math.round(x), y: Math.round(y < 0 ? y * 1.4 : y * 0.6), delayMs: (index % 4) * 30 };
  });
}

/**
 * Главная выгода награды одной строкой: «урон 7 → 9». Берётся первое
 * изменение — движок кладёт главное первым, как на карточке выбора. У опыта
 * и лечения своих чисел нет: опыт показывает сумму отдельно.
 */
export function headlineChange(reward: ChestReward): UpgradeChange | null {
  if (reward.kind === "xp" || reward.kind === "heal") return null;
  return reward.changes[0] ?? null;
}
