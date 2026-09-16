import type { WeaponDef } from "@bh/shared-types";

// Оружие правит геймдизайнер: числа уровней и состав пула — данные, само
// поведение атаки — код в packages/core-game/src/game/weapons/.
// Список поведений и их параметров — таблица в CLAUDE.md.
//
// У каждого оружия восемь уровней: вложиться в одно до конца — такой же
// внятный план, как собрать три разных (docs/05-game-design.md §2). Правила
// лесенки, по которым набраны числа ниже:
//
//  * каждый уровень меняет то, что чувствуется: урон и перезарядка — каждый,
//    снаряды, пробивание и радиус — через один. Уровень, где не поменялось
//    ничего заметного, на карточке выбора так и выглядит;
//  * от первого к восьмому урон в секунду растёт примерно в 15 раз — это
//    догоняет рост здоровья врагов по таймлайну, но не обгоняет его;
//  * оружие, которое бьёт по площади или пробивает, на бумаге слабее в уроне:
//    оно попадает по нескольким целям сразу.
//
// Тексты — ключи i18n (docs/01-tech-stack.md §7).
export const WEAPONS: WeaponDef[] = [
  {
    // Ровное оружие без условий: бьёт в ближайшего, промахов не бывает. По
    // нему меряются остальные.
    id: "spark",
    behavior: "projectile_nearest",
    nameKey: "weapon.spark.name",
    descriptionKey: "weapon.spark.description",
    starting: true,
    levels: [
      { damage: 6, cooldownSec: 0.28, projectiles: 1, projectileSpeed: 520, ttlSec: 1.6 },
      { damage: 7, cooldownSec: 0.26, projectiles: 1, projectileSpeed: 540, ttlSec: 1.6 },
      { damage: 8, cooldownSec: 0.24, projectiles: 2, projectileSpeed: 540, ttlSec: 1.6 },
      { damage: 9, cooldownSec: 0.22, projectiles: 2, projectileSpeed: 560, ttlSec: 1.7 },
      { damage: 10, cooldownSec: 0.2, projectiles: 2, pierce: 1, projectileSpeed: 580, ttlSec: 1.7 },
      { damage: 12, cooldownSec: 0.19, projectiles: 3, pierce: 1, projectileSpeed: 600, ttlSec: 1.8 },
      { damage: 14, cooldownSec: 0.17, projectiles: 3, pierce: 1, projectileSpeed: 620, ttlSec: 1.8 },
      { damage: 16, cooldownSec: 0.15, projectiles: 3, pierce: 2, projectileSpeed: 640, ttlSec: 1.9 },
    ],
  },
  {
    // Веер по направлению движения: награда за то, что бежишь в толпу.
    // Пробивание растёт быстрее, чем у «Искры», — он и задуман на плотный строй.
    id: "knife",
    behavior: "projectile_facing",
    nameKey: "weapon.knife.name",
    descriptionKey: "weapon.knife.description",
    starting: true,
    levels: [
      { damage: 6, cooldownSec: 0.4, projectiles: 2, pierce: 1, projectileSpeed: 640, ttlSec: 1.2 },
      { damage: 7, cooldownSec: 0.38, projectiles: 2, pierce: 1, projectileSpeed: 660, ttlSec: 1.2 },
      { damage: 8, cooldownSec: 0.37, projectiles: 3, pierce: 2, projectileSpeed: 680, ttlSec: 1.3 },
      { damage: 9, cooldownSec: 0.34, projectiles: 3, pierce: 2, projectileSpeed: 700, ttlSec: 1.3 },
      { damage: 10, cooldownSec: 0.32, projectiles: 4, pierce: 2, projectileSpeed: 700, ttlSec: 1.4 },
      { damage: 11, cooldownSec: 0.3, projectiles: 4, pierce: 3, projectileSpeed: 720, ttlSec: 1.4 },
      { damage: 13, cooldownSec: 0.27, projectiles: 5, pierce: 3, projectileSpeed: 740, ttlSec: 1.5 },
      { damage: 15, cooldownSec: 0.24, projectiles: 6, pierce: 4, projectileSpeed: 760, ttlSec: 1.5 },
    ],
  },
  {
    // Обереги бьют только то, чего касаются, поэтому кольцо держится близко к
    // игроку: на радиусе в полкорпуса враг, дошедший вплотную, оказывался
    // внутри кольца и не задевался вовсе. Растёт всё сразу — число оберегов,
    // радиус и скорость вращения: именно скорость решает, как часто камень
    // проходит по тому, кто жмёт с одной стороны.
    id: "wardstone",
    behavior: "orbit",
    nameKey: "weapon.wardstone.name",
    descriptionKey: "weapon.wardstone.description",
    starting: true,
    levels: [
      { damage: 8, cooldownSec: 0.45, projectiles: 3, areaRadius: 56, projectileSpeed: 340 },
      { damage: 10, cooldownSec: 0.42, projectiles: 3, areaRadius: 60, projectileSpeed: 350 },
      { damage: 11, cooldownSec: 0.42, projectiles: 4, areaRadius: 64, projectileSpeed: 360 },
      { damage: 13, cooldownSec: 0.38, projectiles: 4, areaRadius: 70, projectileSpeed: 370 },
      { damage: 15, cooldownSec: 0.36, projectiles: 5, areaRadius: 76, projectileSpeed: 380 },
      { damage: 18, cooldownSec: 0.34, projectiles: 5, areaRadius: 84, projectileSpeed: 390 },
      { damage: 21, cooldownSec: 0.32, projectiles: 6, areaRadius: 90, projectileSpeed: 400 },
      { damage: 25, cooldownSec: 0.3, projectiles: 6, areaRadius: 96, projectileSpeed: 420 },
    ],
  },
  {
    // Зона вокруг игрока: урон за тик небольшой, но идёт по всем, кто рядом,
    // и растёт вместе с радиусом.
    id: "hearth",
    behavior: "aura",
    nameKey: "weapon.hearth.name",
    descriptionKey: "weapon.hearth.description",
    levels: [
      { damage: 3, cooldownSec: 0.5, areaRadius: 80 },
      { damage: 4, cooldownSec: 0.5, areaRadius: 88 },
      { damage: 5, cooldownSec: 0.45, areaRadius: 96 },
      { damage: 6, cooldownSec: 0.42, areaRadius: 104 },
      { damage: 7, cooldownSec: 0.38, areaRadius: 112 },
      { damage: 9, cooldownSec: 0.35, areaRadius: 120 },
      { damage: 11, cooldownSec: 0.32, areaRadius: 130 },
      { damage: 13, cooldownSec: 0.28, areaRadius: 140 },
    ],
  },
  {
    // Молния бьёт по площади в случайного врага и достаёт стрелков. На первом
    // уровне это один редкий удар небольшого радиуса: раньше «Гроза» с ходу
    // выкашивала первые волны целиком. Растёт всем сразу — числом ударов,
    // частотой и радиусом, — и к восьмому уровню бьёт четырежды.
    id: "storm",
    behavior: "area_strike",
    nameKey: "weapon.storm.name",
    descriptionKey: "weapon.storm.description",
    levels: [
      { damage: 10, cooldownSec: 2.8, projectiles: 1, areaRadius: 52 },
      { damage: 12, cooldownSec: 2.6, projectiles: 1, areaRadius: 58 },
      { damage: 14, cooldownSec: 2.4, projectiles: 1, areaRadius: 66 },
      { damage: 16, cooldownSec: 2.15, projectiles: 2, areaRadius: 74 },
      { damage: 19, cooldownSec: 1.9, projectiles: 2, areaRadius: 84 },
      { damage: 22, cooldownSec: 1.7, projectiles: 3, areaRadius: 94 },
      { damage: 26, cooldownSec: 1.5, projectiles: 3, areaRadius: 106 },
      { damage: 30, cooldownSec: 1.3, projectiles: 4, areaRadius: 120 },
    ],
  },
];
