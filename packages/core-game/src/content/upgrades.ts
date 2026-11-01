import type { LevelCurveDef, LoadoutLimits, PassiveDef } from "@bh/shared-types";

// Пассивные улучшения, слоты и кривая опыта — данные геймдизайнера.
// Значение в `levels` — итоговое для этого уровня, а не прибавка к
// предыдущему: множители не перемножаются между собой незаметно.
//
// Числа стартовые, до спецификации геймдизайнера (docs/26-stage2-plan.md, WP2).
//
// У навыков 6–7 уровней, кроме «Залпа» (снаряды целые: каждый уровень — снаряд).
// Набор в забеге растянут до 15-й минуты (Р127, T-0193): шаг мельче прежнего, а
// итог последнего уровня не сильнее прежнего больше чем на треть — по прибавке,
// а не по множителю (у «Мощи» потолок ×1,65, у «Притяжения» ×2,95). Тест
// контента держит и шаг, и потолок «на треть».
export const PASSIVES: PassiveDef[] = [
  {
    id: "might",
    nameKey: "passive.might.name",
    descriptionKey: "passive.might.description",
    category: "attack",
    stat: "damage",
    op: "mul",
    levels: [1.07, 1.14, 1.22, 1.31, 1.41, 1.52, 1.65],
  },
  {
    id: "haste",
    nameKey: "passive.haste.name",
    descriptionKey: "passive.haste.description",
    category: "attack",
    stat: "cooldown",
    op: "mul",
    levels: [0.94, 0.89, 0.84, 0.79, 0.75, 0.71, 0.67],
  },
  {
    id: "reach",
    nameKey: "passive.reach.name",
    descriptionKey: "passive.reach.description",
    category: "attack",
    stat: "area",
    op: "mul",
    levels: [1.07, 1.14, 1.22, 1.31, 1.41, 1.52, 1.64],
  },
  {
    id: "volley",
    nameKey: "passive.volley.name",
    descriptionKey: "passive.volley.description",
    category: "attack",
    stat: "projectiles",
    op: "add",
    levels: [1, 2],
  },
  {
    id: "swiftness",
    nameKey: "passive.swiftness.name",
    descriptionKey: "passive.swiftness.description",
    category: "mobility",
    stat: "moveSpeed",
    op: "mul",
    levels: [1.05, 1.1, 1.16, 1.22, 1.28, 1.34],
  },
  {
    id: "vitality",
    nameKey: "passive.vitality.name",
    descriptionKey: "passive.vitality.description",
    category: "defense",
    stat: "maxHp",
    op: "add",
    levels: [15, 32, 52, 75, 100, 130],
  },
  {
    id: "mending",
    nameKey: "passive.mending.name",
    descriptionKey: "passive.mending.description",
    category: "defense",
    stat: "regenPerSec",
    op: "add",
    levels: [0.3, 0.65, 1.05, 1.5, 2.0, 2.6],
  },
  {
    id: "lodestone",
    nameKey: "passive.lodestone.name",
    descriptionKey: "passive.lodestone.description",
    category: "mobility",
    stat: "pickupRadius",
    op: "mul",
    levels: [1.2, 1.45, 1.75, 2.1, 2.5, 2.95],
  },
  {
    id: "ward",
    nameKey: "passive.ward.name",
    descriptionKey: "passive.ward.description",
    category: "defense",
    stat: "armor",
    op: "add",
    levels: [0.7, 1.4, 2.1, 2.8, 3.4, 4.0],
  },
  {
    // Сопротивление всем стихиям: гасит урон и укорачивает горение, холод,
    // шок и яд. Встаёт в тот же слот защиты, что «Броня» и «Живучесть», —
    // против стихийных врагов это выбор, а не бесплатная прибавка. Потолок
    // игрока 75% (`sim/player-status.ts`) не достаётся и на шестом уровне (60%).
    id: "tempering",
    nameKey: "passive.tempering.name",
    descriptionKey: "passive.tempering.description",
    category: "defense",
    stat: "resist",
    op: "add",
    levels: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
  },
];

/**
 * Слоты набора (решение Р13, docs/26-stage2-plan.md §2). Пассивки делятся на
 * категории, и у каждой свои слоты: четыре слота «на что угодно» к десятой
 * минуте забивались всем подряд, и выбирать становилось нечего. Теперь
 * взятая «Живучесть» — это отказ от «Брони» и «Заживления».
 *
 * Четыре оружия и по три-два слота навыков вместе с мелкими шагами уровней
 * растягивают сборку набора до 15-й минуты (Р127, T-0193). Подвижность
 * остаётся одним слотом: навыков подвижности два, а правило контента требует,
 * чтобы навыков в категории было больше, чем слотов.
 */
export const LOADOUT_LIMITS: LoadoutLimits = {
  weapons: 4,
  passives: { attack: 3, defense: 2, mobility: 1 },
};

/**
 * Кривая опыта. Темп начала важнее всего: первый уровень должен приходить в
 * первые полминуты, иначе забег начинается с пустой минуты без решений.
 *
 * Основной участок (`baseXp`, `growth`) не меняется. Хвост с 25-го уровня
 * подбирается под цель Р127 «набор собирается к 15-й минуте» и положе
 * основного: с четырьмя оружиями и лишними слотами набору нужно около семидесяти
 * выборов, а прежние ×1,22 за уровень дальше 44-го уровня не пускали вовсе.
 */
export const LEVEL_CURVE: LevelCurveDef = { baseXp: 6, growth: 1.22, late: { fromLevel: 25, growth: 1.07 } };
