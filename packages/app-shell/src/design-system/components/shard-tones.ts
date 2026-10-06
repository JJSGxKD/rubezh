/**
 * Тона осколка по редкости (docs/27-design-system-and-app-shell.md §4.4) —
 * те же, что у редкости предмета в арсенале: осколок и предмет, на который он
 * идёт, читаются одним цветом. Отдельно от значка — чтобы проверять тестом
 * без React.
 */

/** Цвет редкости — токеном палитры: смена визуального направления перекрашивает и осколки. */
const RARITY_COLOR: Readonly<Record<string, string>> = {
  common: "var(--color-text-muted)",
  uncommon: "var(--color-success)",
  rare: "var(--color-info)",
  epic: "var(--color-passive)",
  legendary: "var(--color-elite)",
  mythic: "var(--color-danger)",
};

/** Тот же цвет классом текста — для обводок и подписей рядом со значком (дуга колеса). */
const RARITY_TEXT: Readonly<Record<string, string>> = {
  common: "text-text-muted",
  uncommon: "text-success",
  rare: "text-info",
  epic: "text-passive",
  legendary: "text-elite",
  mythic: "text-danger",
};

export function shardTone(rarity: string): string {
  return RARITY_TEXT[rarity] ?? "text-text-muted";
}

/** Редкость осколка по ресурсу кошелька: `shard_rare` → `rare`; не осколок — `null`. */
export function shardRarity(resource: string): string | null {
  return resource.startsWith("shard_") ? resource.slice("shard_".length) : null;
}

/** Цвет значка; незнакомая редкость — нейтральным тоном, а не пустым местом. */
export function shardColor(rarity: string): string {
  return RARITY_COLOR[rarity] ?? "var(--color-text-muted)";
}
