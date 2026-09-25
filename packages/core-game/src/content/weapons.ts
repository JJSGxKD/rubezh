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
    // Один камень на старте, шесть к восьмому уровню — так это оружие и
    // читается в жанре: «ещё один оберег» на карточке выбора видно сразу.
    // Растёт всё сразу — число камней, радиус кольца и скорость вращения:
    // скорость решает, как часто камень проходит по тому, кто жмёт с одной
    // стороны, и потому прокачивается наравне с остальным.
    //
    // Кольцо держится близко к игроку: на радиусе в полкорпуса враг, дошедший
    // вплотную, оказывался внутри кольца и не задевался вовсе.
    id: "wardstone",
    behavior: "orbit",
    nameKey: "weapon.wardstone.name",
    descriptionKey: "weapon.wardstone.description",
    // Холод: камни замедляют тех, кто подошёл вплотную, — оберег и держит толпу.
    element: "cold",
    starting: true,
    levels: [
      { damage: 11, cooldownSec: 0.4, projectiles: 1, areaRadius: 60, projectileSpeed: 380, statusChance: 0.2 },
      { damage: 12, cooldownSec: 0.38, projectiles: 2, areaRadius: 64, projectileSpeed: 395, statusChance: 0.22 },
      { damage: 14, cooldownSec: 0.36, projectiles: 2, areaRadius: 68, projectileSpeed: 410, statusChance: 0.24 },
      { damage: 16, cooldownSec: 0.34, projectiles: 3, areaRadius: 74, projectileSpeed: 425, statusChance: 0.26 },
      { damage: 18, cooldownSec: 0.32, projectiles: 4, areaRadius: 80, projectileSpeed: 440, statusChance: 0.28 },
      { damage: 20, cooldownSec: 0.31, projectiles: 4, areaRadius: 86, projectileSpeed: 455, statusChance: 0.3 },
      { damage: 22, cooldownSec: 0.3, projectiles: 5, areaRadius: 92, projectileSpeed: 470, statusChance: 0.32 },
      { damage: 24, cooldownSec: 0.28, projectiles: 6, areaRadius: 98, projectileSpeed: 490, statusChance: 0.35 },
    ],
  },
  {
    // Зона вокруг игрока: урон за тик небольшой, но идёт по всем, кто рядом,
    // и растёт вместе с радиусом.
    id: "hearth",
    behavior: "aura",
    nameKey: "weapon.hearth.name",
    descriptionKey: "weapon.hearth.description",
    // Огонь: очаг поджигает тех, кто задержался рядом, — горит и после ухода из зоны.
    element: "fire",
    levels: [
      { damage: 3, cooldownSec: 0.5, areaRadius: 80, statusChance: 0.15 },
      { damage: 4, cooldownSec: 0.5, areaRadius: 88, statusChance: 0.17 },
      { damage: 5, cooldownSec: 0.45, areaRadius: 96, statusChance: 0.19 },
      { damage: 6, cooldownSec: 0.42, areaRadius: 104, statusChance: 0.21 },
      { damage: 7, cooldownSec: 0.38, areaRadius: 112, statusChance: 0.23 },
      { damage: 9, cooldownSec: 0.35, areaRadius: 120, statusChance: 0.25 },
      { damage: 11, cooldownSec: 0.32, areaRadius: 130, statusChance: 0.27 },
      { damage: 13, cooldownSec: 0.28, areaRadius: 140, statusChance: 0.3 },
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
    // Молния: удар шокирует, а следующий удар по шокированному перескакивает на соседей.
    element: "lightning",
    levels: [
      { damage: 10, cooldownSec: 2.8, projectiles: 1, areaRadius: 52, statusChance: 0.35 },
      { damage: 12, cooldownSec: 2.6, projectiles: 1, areaRadius: 58, statusChance: 0.38 },
      { damage: 14, cooldownSec: 2.4, projectiles: 1, areaRadius: 66, statusChance: 0.41 },
      { damage: 16, cooldownSec: 2.15, projectiles: 2, areaRadius: 74, statusChance: 0.44 },
      { damage: 19, cooldownSec: 1.9, projectiles: 2, areaRadius: 84, statusChance: 0.48 },
      { damage: 22, cooldownSec: 1.7, projectiles: 3, areaRadius: 94, statusChance: 0.52 },
      { damage: 26, cooldownSec: 1.5, projectiles: 3, areaRadius: 106, statusChance: 0.56 },
      { damage: 30, cooldownSec: 1.3, projectiles: 4, areaRadius: 120, statusChance: 0.6 },
    ],
  },
];
