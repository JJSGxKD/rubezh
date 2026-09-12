import type { WeaponDef } from "@bh/shared-types";

// Оружие правит геймдизайнер: числа уровней и состав пула — данные, само
// поведение атаки — код в packages/core-game/src/game/weapons/.
// Список поведений и их параметров — таблица в CLAUDE.md.
//
// Числа стартовые, до спецификации геймдизайнера (docs/26-stage2-plan.md, WP2).
// Тексты — ключи i18n (docs/01-tech-stack.md §7), словарь появится с
// оболочкой приложения (WP5).
export const WEAPONS: WeaponDef[] = [
  {
    id: "spark",
    behavior: "projectile_nearest",
    nameKey: "weapon.spark.name",
    descriptionKey: "weapon.spark.description",
    starting: true,
    levels: [
      { damage: 6, cooldownSec: 0.28, projectiles: 1, projectileSpeed: 520, ttlSec: 1.6 },
      { damage: 7, cooldownSec: 0.26, projectiles: 1, projectileSpeed: 520, ttlSec: 1.6 },
      { damage: 8, cooldownSec: 0.24, projectiles: 2, projectileSpeed: 540, ttlSec: 1.6 },
      { damage: 10, cooldownSec: 0.22, projectiles: 2, projectileSpeed: 560, ttlSec: 1.7 },
      { damage: 12, cooldownSec: 0.2, projectiles: 3, projectileSpeed: 580, ttlSec: 1.8 },
    ],
  },
  {
    id: "knife",
    behavior: "projectile_facing",
    nameKey: "weapon.knife.name",
    descriptionKey: "weapon.knife.description",
    starting: true,
    levels: [
      { damage: 5, cooldownSec: 0.5, projectiles: 2, pierce: 1, projectileSpeed: 640, ttlSec: 1.2 },
      { damage: 6, cooldownSec: 0.45, projectiles: 2, pierce: 1, projectileSpeed: 660, ttlSec: 1.2 },
      { damage: 7, cooldownSec: 0.4, projectiles: 3, pierce: 2, projectileSpeed: 680, ttlSec: 1.3 },
      { damage: 8, cooldownSec: 0.36, projectiles: 4, pierce: 2, projectileSpeed: 700, ttlSec: 1.3 },
      { damage: 10, cooldownSec: 0.32, projectiles: 5, pierce: 3, projectileSpeed: 720, ttlSec: 1.4 },
    ],
  },
  {
    id: "wardstone",
    behavior: "orbit",
    nameKey: "weapon.wardstone.name",
    descriptionKey: "weapon.wardstone.description",
    starting: true,
    levels: [
      { damage: 7, cooldownSec: 0.6, projectiles: 1, areaRadius: 70, projectileSpeed: 140 },
      { damage: 8, cooldownSec: 0.6, projectiles: 2, areaRadius: 74, projectileSpeed: 150 },
      { damage: 10, cooldownSec: 0.55, projectiles: 2, areaRadius: 78, projectileSpeed: 160 },
      { damage: 12, cooldownSec: 0.5, projectiles: 3, areaRadius: 82, projectileSpeed: 170 },
      { damage: 14, cooldownSec: 0.45, projectiles: 4, areaRadius: 86, projectileSpeed: 180 },
    ],
  },
  {
    id: "hearth",
    behavior: "aura",
    nameKey: "weapon.hearth.name",
    descriptionKey: "weapon.hearth.description",
    levels: [
      { damage: 3, cooldownSec: 0.5, areaRadius: 80 },
      { damage: 4, cooldownSec: 0.5, areaRadius: 90 },
      { damage: 5, cooldownSec: 0.45, areaRadius: 100 },
      { damage: 6, cooldownSec: 0.4, areaRadius: 112 },
      { damage: 8, cooldownSec: 0.35, areaRadius: 124 },
    ],
  },
  {
    id: "storm",
    behavior: "area_strike",
    nameKey: "weapon.storm.name",
    descriptionKey: "weapon.storm.description",
    levels: [
      { damage: 14, cooldownSec: 2.2, projectiles: 1, areaRadius: 70 },
      { damage: 16, cooldownSec: 2, projectiles: 1, areaRadius: 76 },
      { damage: 18, cooldownSec: 1.8, projectiles: 2, areaRadius: 82 },
      { damage: 21, cooldownSec: 1.6, projectiles: 2, areaRadius: 88 },
      { damage: 25, cooldownSec: 1.4, projectiles: 3, areaRadius: 96 },
    ],
  },
];
