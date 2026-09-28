import type { BoostDef } from "@bh/shared-types";

/**
 * Бусты — разовые усиления на один забег (docs/35-stage4-plan.md §3.5, Р39).
 * Числа рабочие (Р31): их пересматривает геймдизайнер по симуляции. Цена и
 * списание — на сервере (`backend/api/src/modules/boosts`), здесь — только
 * что буст делает в бою.
 *
 * Прибавки к параметрам — та же шкала, что у снаряжения: доля — к множителю
 * (0.15 — +15%), здоровье — числом. Сумма со снаряжением упирается в
 * пределы движка (`LOADOUT_BOUNDS`), поэтому буст не пробьёт страховку от
 * битых данных.
 */
export const BOOSTS: readonly BoostDef[] = [
  { id: "fury", nameKey: "boost.fury.name", descriptionKey: "boost.fury.description", modifiers: { damage: 0.15 } },
  { id: "bulwark", nameKey: "boost.bulwark.name", descriptionKey: "boost.bulwark.description", modifiers: { maxHp: 30 } },
  { id: "lure", nameKey: "boost.lure.name", descriptionKey: "boost.lure.description", modifiers: { pickupRadius: 0.6 } },
  // Щит гасит попадание целиком, а не долю: игрок должен понять, что его спасло.
  { id: "aegis", nameKey: "boost.aegis.name", descriptionKey: "boost.aegis.description", shieldHits: 1 },
  { id: "head_start", nameKey: "boost.head_start.name", descriptionKey: "boost.head_start.description", startLevels: 2 },
  { id: "insight", nameKey: "boost.insight.name", descriptionKey: "boost.insight.description", extraOffers: 1 },
];

/** Сколько бустов берётся на один забег; каждый — не больше одного раза. */
export const MAX_BOOSTS_PER_RUN = 3;
