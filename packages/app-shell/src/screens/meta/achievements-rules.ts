import { isOpenAchievement, type AchievementItem, type OpenAchievement } from "../../state/achievements-api";

/**
 * Правила витрины достижений (tasks/T-0107): чистые функции без React, чтобы
 * порядок категорий, склейка лестниц, ступени редкости и любимые проверялись
 * тестами, а не глазами.
 */

/** Порядок секций витрины. */
export const CATEGORY_ORDER = ["combat", "collection", "mastery", "friends"] as const;

/** Любимых не больше стольких: по числу слотов в профиле (серверный `FAVORITES_MAX`). */
export const FAVORITES_MAX = 3;

/**
 * Границы ступеней редкости, % игроков с достижением: от 40 — обычное, от 15 —
 * необычное, от 5 — редкое, ниже — очень редкое. Стартовые числа, их
 * калибрует геймдизайнер вместе с балансом.
 */
export const RARITY_BOUNDS = { common: 40, uncommon: 15, rare: 5 } as const;

export type RarityTier = "common" | "uncommon" | "rare" | "epic";

export interface CategoryGroup {
  category: string;
  items: AchievementItem[];
}

/**
 * Секции по категориям в порядке `CATEGORY_ORDER`, пустые опущены, порядок
 * внутри — как отдал сервер. Категория, которой клиент не знает (сервер
 * новее), идёт после известных, а не пропадает: награду за неё всё равно ждут.
 */
export function groupByCategory(items: readonly AchievementItem[]): CategoryGroup[] {
  const known: readonly string[] = CATEGORY_ORDER;
  const order = [...CATEGORY_ORDER.map(String), ...new Set(items.map((item) => item.category).filter((category) => !known.includes(category)))];
  return order.flatMap((category) => {
    const inCategory = items.filter((item) => item.category === category);
    return inCategory.length === 0 ? [] : [{ category, items: inCategory }];
  });
}

export type AchievementCard =
  | { kind: "single"; item: AchievementItem }
  | { kind: "ladder"; ladder: string; rungs: OpenAchievement[]; current: OpenAchievement };

/**
 * Карточки витрины: строки одной лестницы склеены в одну, на месте её первой
 * строки; одиночные и закрытые скрытые — отдельными. Ступени внутри лестницы —
 * по номеру.
 */
export function cards(items: readonly AchievementItem[]): AchievementCard[] {
  const ladders = new Map<string, OpenAchievement[]>();
  for (const item of items) {
    if (isOpenAchievement(item) && item.ladder !== undefined && item.ladder !== null) ladders.set(item.ladder, [...(ladders.get(item.ladder) ?? []), item]);
  }
  const placed = new Set<string>();
  return items.flatMap((item): AchievementCard[] => {
    if (!isOpenAchievement(item) || item.ladder === undefined || item.ladder === null) return [{ kind: "single", item }];
    if (placed.has(item.ladder)) return [];
    placed.add(item.ladder);
    const rungs = [...(ladders.get(item.ladder) ?? [])].sort((a, b) => (a.rung ?? 0) - (b.rung ?? 0));
    return [{ kind: "ladder", ladder: item.ladder, rungs, current: currentRung(rungs) }];
  });
}

/**
 * Ступень, которую показывает карточка: первая готовая к забору, иначе первая
 * невыполненная, иначе последняя. Ступени — по возрастанию номера.
 */
export function currentRung(rungs: readonly OpenAchievement[]): OpenAchievement {
  const found = rungs.find((rung) => rung.done && !rung.claimed) ?? rungs.find((rung) => !rung.done) ?? rungs[rungs.length - 1];
  if (found === undefined) throw new Error("у лестницы нет ступеней");
  return found;
}

/** Ступень редкости по проценту игроков; процента нет — ступени нет. */
export function rarityTier(percent: number | null | undefined): RarityTier | null {
  if (percent === null || percent === undefined) return null;
  if (percent >= RARITY_BOUNDS.common) return "common";
  if (percent >= RARITY_BOUNDS.uncommon) return "uncommon";
  if (percent >= RARITY_BOUNDS.rare) return "rare";
  return "epic";
}

const PERCENT = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

/** Процент с запятой и без хвостового нуля: 12,3 · 7 · 100. */
export function percentText(percent: number): string {
  return PERCENT.format(percent);
}

export type FavoritesChange = { ok: true; ids: string[] } | { ok: false; reason: "full" | "locked" };

/**
 * Любимые после нажатия на звёздочку: уже любимое снимается (всегда можно,
 * даже если достижение вдруг закрылось), открытое встаёт в следующий слот.
 * `unlocked` — открыто ли это достижение.
 */
export function nextFavorites(current: readonly string[], id: string, unlocked: boolean): FavoritesChange {
  if (current.includes(id)) return { ok: true, ids: current.filter((candidate) => candidate !== id) };
  if (!unlocked) return { ok: false, reason: "locked" };
  if (current.length >= FAVORITES_MAX) return { ok: false, reason: "full" };
  return { ok: true, ids: [...current, id] };
}

/** Сколько достижений открыто; закрытое скрытое открытым не считается. */
export function openedCount(items: readonly AchievementItem[]): number {
  return items.filter((item) => item.done).length;
}
