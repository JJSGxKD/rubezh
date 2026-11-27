/**
 * Каталог обликов героя (docs/35-stage4-plan.md Р150, tasks/T-0237): одиннадцать обликов в
 * шести архетипах и четырёх окрасах Хранителя. Каталог живёт в коде, а не в базе: облик — это
 * ещё и кадры в атласе, без рисунка строка бессмысленна, а рисунок приходит релизом. Id
 * совпадают с именами кадров и портретов: `hero-<id>/…` в `atlas-skin-<id>`, `portrait-hero-<id>.svg`.
 *
 * Числа источников (уровни, место в сезоне) — стартовые, геймдизайнер калибрует; правятся
 * релизом вместе с рисунками (docs/30-configuration-map.md, «Облики: источники и уровни»).
 */

/** Редкость облика — та же шкала, что у предметов и знаков. */
export type AppearanceRarity = "common" | "uncommon" | "rare" | "epic" | "legendary" | "mythic";

export type AppearanceArchetype = "keeper" | "vityaz" | "vedunya" | "ohotnitsa" | "skomoroh" | "knyaz" | "navi";

/** Откуда берётся облик. */
export type AppearanceSource =
  | { kind: "start" }
  | { kind: "level"; level: number }
  | { kind: "weekly_points" }
  | { kind: "achievement"; achievementId: string }
  | { kind: "event" }
  | { kind: "vip" }
  | { kind: "season"; maxPlace: number }
  /** Куплен за звёзды в наборе магазина: выдан строкой `appearance_grant` (tasks/T-0245). */
  | { kind: "purchase"; sku: string };

export interface AppearanceDef {
  id: string;
  archetype: AppearanceArchetype;
  rarity: AppearanceRarity;
  source: AppearanceSource;
}

/** Облик по умолчанию: у всех с начала и для всех, у кого выбранный облик пропал. */
export const DEFAULT_APPEARANCE = "keeper";

/** Достижение «Гроза элит» (T-0126): выполненное даёт Охотницу. */
export const ELITE_ACHIEVEMENT_ID = "ach_elite_50";

/** Топ недельного сезона, дающий Навьего стража: места 1–3 навсегда. */
export const NAVI_MAX_PLACE = 3;

/** Набор магазина, который продаёт окрас «Хранитель · рассвет» (`shop/keeper-set.ts`: `KEEPER_SET_SKU`, равенство держит тест). */
export const KEEPER_SET_APPEARANCE_SKU = "keeper_set";

/** Уровни аккаунта, открывающие облики. */
export const APPEARANCE_LEVELS = { frost: 5, herbalist: 10, gilded: 15, vityaz: 20 } as const;

/**
 * Каталог по порядку показа. Названия для игрока — в словаре клиента (T-0238):
 * Хранитель, Хранитель · иней, Хранитель · травник, Хранитель · золото, Хранитель · рассвет,
 * Витязь, Ведунья, Охотница, Скоморох, Князь, Навий страж.
 */
export const APPEARANCES = [
  { id: "keeper", archetype: "keeper", rarity: "common", source: { kind: "start" } },
  { id: "frost", archetype: "keeper", rarity: "common", source: { kind: "level", level: APPEARANCE_LEVELS.frost } },
  { id: "herbalist", archetype: "keeper", rarity: "uncommon", source: { kind: "level", level: APPEARANCE_LEVELS.herbalist } },
  { id: "gilded", archetype: "keeper", rarity: "uncommon", source: { kind: "level", level: APPEARANCE_LEVELS.gilded } },
  // Окрас из «Набора хранителя»: иначе его не получить (Р155).
  { id: "dawn", archetype: "keeper", rarity: "rare", source: { kind: "purchase", sku: KEEPER_SET_APPEARANCE_SKU } },
  { id: "vityaz", archetype: "vityaz", rarity: "rare", source: { kind: "level", level: APPEARANCE_LEVELS.vityaz } },
  { id: "vedunya", archetype: "vedunya", rarity: "rare", source: { kind: "weekly_points" } },
  { id: "ohotnitsa", archetype: "ohotnitsa", rarity: "epic", source: { kind: "achievement", achievementId: ELITE_ACHIEVEMENT_ID } },
  // Придёт с Ярмаркой (Р154): до неё ни одно состояние аккаунта этот облик не даёт.
  { id: "skomoroh", archetype: "skomoroh", rarity: "epic", source: { kind: "event" } },
  { id: "knyaz", archetype: "knyaz", rarity: "legendary", source: { kind: "vip" } },
  { id: "navi", archetype: "navi", rarity: "mythic", source: { kind: "season", maxPlace: NAVI_MAX_PLACE } },
] as const satisfies readonly AppearanceDef[];

/** Облик по id; `undefined` — в каталоге такого нет. */
export function appearanceById(id: string): AppearanceDef | undefined {
  return APPEARANCES.find((def) => def.id === id);
}
