import type { LevelCurveDef, LoadoutLimits, PassiveDef } from "@bh/shared-types";

// Пассивные улучшения, слоты и кривая опыта — данные геймдизайнера.
// Значение в `levels` — итоговое для этого уровня, а не прибавка к
// предыдущему: множители не перемножаются между собой незаметно.
//
// Числа стартовые, до спецификации геймдизайнера (docs/26-stage2-plan.md, WP2).
export const PASSIVES: PassiveDef[] = [
  {
    id: "might",
    nameKey: "passive.might.name",
    descriptionKey: "passive.might.description",
    stat: "damage",
    op: "mul",
    levels: [1.1, 1.2, 1.3, 1.45, 1.6],
  },
  {
    id: "haste",
    nameKey: "passive.haste.name",
    descriptionKey: "passive.haste.description",
    stat: "cooldown",
    op: "mul",
    levels: [0.92, 0.85, 0.79, 0.73, 0.68],
  },
  {
    id: "reach",
    nameKey: "passive.reach.name",
    descriptionKey: "passive.reach.description",
    stat: "area",
    op: "mul",
    levels: [1.1, 1.2, 1.32, 1.45, 1.6],
  },
  {
    id: "volley",
    nameKey: "passive.volley.name",
    descriptionKey: "passive.volley.description",
    stat: "projectiles",
    op: "add",
    levels: [1, 2],
  },
  {
    id: "swiftness",
    nameKey: "passive.swiftness.name",
    descriptionKey: "passive.swiftness.description",
    stat: "moveSpeed",
    op: "mul",
    levels: [1.08, 1.15, 1.22, 1.3],
  },
  {
    id: "vitality",
    nameKey: "passive.vitality.name",
    descriptionKey: "passive.vitality.description",
    stat: "maxHp",
    op: "add",
    levels: [20, 45, 75, 110],
  },
  {
    id: "mending",
    nameKey: "passive.mending.name",
    descriptionKey: "passive.mending.description",
    stat: "regenPerSec",
    op: "add",
    levels: [0.4, 0.9, 1.5, 2.2],
  },
  {
    id: "lodestone",
    nameKey: "passive.lodestone.name",
    descriptionKey: "passive.lodestone.description",
    stat: "pickupRadius",
    op: "mul",
    levels: [1.3, 1.7, 2.2, 2.8],
  },
  {
    id: "ward",
    nameKey: "passive.ward.name",
    descriptionKey: "passive.ward.description",
    stat: "armor",
    op: "add",
    levels: [1, 2, 3],
  },
];

/**
 * Сколько оружий и пассивок игрок держит одновременно (решение Р13,
 * docs/26-stage2-plan.md §2). Шесть и шесть, как в Vampire Survivors, на
 * экране телефона делают и HUD, и выбор нечитаемыми.
 */
export const LOADOUT_LIMITS: LoadoutLimits = { weapons: 4, passives: 4 };

/**
 * Кривая опыта. Темп начала важнее всего: первый уровень должен приходить в
 * первые полминуты, иначе забег начинается с пустой минуты без решений.
 */
export const LEVEL_CURVE: LevelCurveDef = { baseXp: 6, growth: 1.22 };
