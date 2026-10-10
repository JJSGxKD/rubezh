/**
 * Правила экрана смерти в два шага (design/screens/death.html) — чистые
 * функции без React: какой шаг показать, как заполнена полоса уровня и какое
 * оружие лучшее.
 */

/**
 * Какой шаг показать: второй шанс — только пока забег ждёт решения и есть
 * хоть один способ продолжить. Забег закрыт или продолжить нечем — итоги.
 */
export function deathStep(input: { phase: "downed" | "finished"; hasWays: boolean }): "chance" | "results" {
  return input.phase === "downed" && input.hasWays ? "chance" : "results";
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Полоса уровня после забега: доли 0..1 — что было до забега и что стало;
 * `null` у `toNext` — наивысший уровень, полоса полная.
 */
export function levelBar(reward: {
  xp: number;
  levelBefore: number;
  levelAfter: number;
  progress: { level: number; xpIntoLevel: number; xpForNext: number | null };
}): { level: number; before: number; after: number; toNext: number | null } {
  const { progress } = reward;
  if (progress.xpForNext === null) return { level: progress.level, before: 1, after: 1, toNext: null };
  const after = clamp01(progress.xpIntoLevel / progress.xpForNext);
  // Уровень вырос — забег начал полосу нового уровня с нуля, сплошной части нет.
  const before = reward.levelAfter > reward.levelBefore ? 0 : clamp01(Math.max(0, progress.xpIntoLevel - reward.xp) / progress.xpForNext);
  return { level: progress.level, before, after, toNext: progress.xpForNext - progress.xpIntoLevel };
}

/** Оружие с наибольшим уроном; при равенстве — первое по порядку, пусто — `null`. */
export function bestWeapon(weapons: readonly { id: string; damage: number }[]): string | null {
  let best: { id: string; damage: number } | null = null;
  for (const weapon of weapons) {
    if (best === null || weapon.damage > best.damage) best = weapon;
  }
  return best?.id ?? null;
}
