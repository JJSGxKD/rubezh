import type { EndlessCurveDef, TimelineSegmentDef } from "@bh/shared-types";

// Таймлайн спавна бесконечного режима (docs/26-stage2-plan.md, WP4.4).
//
// Не «волны с паузами», а непрерывный поток: отрезок задаёт состав врагов и
// темп спавна в врагах в секунду. `burst` — разовый выброс в начале отрезка,
// `events` — окружение кольцом и рой с одной стороны.
//
// Первые пять минут расписаны руками: это та часть забега, которую видит
// каждый игрок, и угадывать её формулой нельзя. Дальше таймлайн генерируется
// по ENDLESS_CURVE — забег не кончается, а расписать бесконечность руками
// нельзя.
//
// Каждый новый тип появляется сначала один, в своём отрезке, и только потом в
// смеси: игрок должен успеть понять поведение до того, как оно спрячется в
// толпе. Сложность растёт комбинациями паттернов, а не числом врагов одного
// типа (docs/05-game-design.md §4).
//
// Имя отрезка в аналитике — «волна» (`wave_reached`): термин остался, смысл
// уточнён (docs/22-analytics-and-metrics.md §5.3).
export const TIMELINE: TimelineSegmentDef[] = [
  { fromSec: 0, spawns: [{ enemy: "swarm_rat", perSec: 1.8, burst: 10 }] },
  {
    fromSec: 30,
    spawns: [
      { enemy: "swarm_rat", perSec: 2 },
      { enemy: "dasher_wolf", perSec: 0.25, burst: 2 },
    ],
  },
  {
    fromSec: 60,
    spawns: [
      { enemy: "swarm_rat", perSec: 2.2 },
      { enemy: "shooter_wisp", perSec: 0.3, burst: 2 },
    ],
  },
  {
    fromSec: 90,
    spawns: [
      { enemy: "swarm_rat", perSec: 2.2 },
      { enemy: "circler_crow", perSec: 1.4, burst: 8 },
    ],
  },
  {
    fromSec: 120,
    spawns: [
      { enemy: "swarm_rat", perSec: 2.4 },
      { enemy: "circler_crow", perSec: 0.9 },
      { enemy: "shooter_wisp", perSec: 0.25 },
      { enemy: "tank_ghoul", perSec: 0.12, burst: 1 },
    ],
  },
  {
    fromSec: 150,
    spawns: [
      { enemy: "swarm_rat", perSec: 2.2 },
      { enemy: "circler_crow", perSec: 0.85 },
      { enemy: "dasher_wolf", perSec: 0.3 },
      { enemy: "bomber_imp", perSec: 0.35, burst: 2 },
    ],
  },
  {
    fromSec: 180,
    spawns: [
      { enemy: "swarm_rat", perSec: 2.6 },
      { enemy: "circler_crow", perSec: 1.6 },
      { enemy: "shooter_wisp", perSec: 0.35 },
    ],
    events: [{ kind: "ring", enemy: "circler_crow", count: 16 }],
  },
  {
    // Нетопыри показываются отдельно: поперёк поля идёт стая, и игрок должен
    // успеть понять, что от неё уходят вбок, а не бегут по прямой.
    fromSec: 210,
    spawns: [
      { enemy: "swarm_rat", perSec: 2.2 },
      { enemy: "circler_crow", perSec: 0.9 },
      { enemy: "rushing_bats", perSec: 2.2, burst: 12 },
    ],
  },
  {
    fromSec: 240,
    spawns: [
      { enemy: "swarm_rat", perSec: 2.8 },
      { enemy: "circler_crow", perSec: 1.1 },
      { enemy: "dasher_wolf", perSec: 0.4 },
      { enemy: "rushing_bats", perSec: 1.2 },
      { enemy: "splitter_slime", perSec: 0.3, burst: 2 },
    ],
  },
  {
    fromSec: 270,
    spawns: [
      { enemy: "swarm_rat", perSec: 2.8 },
      { enemy: "circler_crow", perSec: 1.1 },
      { enemy: "rushing_bats", perSec: 0.8 },
      { enemy: "shooter_wisp", perSec: 0.3 },
      { enemy: "bomber_imp", perSec: 0.45 },
      { enemy: "tank_ghoul", perSec: 0.2 },
    ],
    events: [{ kind: "flank", enemy: "swarm_rat", count: 18 }],
  },
  {
    fromSec: 300,
    spawns: [
      { enemy: "swarm_rat", perSec: 3 },
      { enemy: "circler_crow", perSec: 1.8 },
      { enemy: "rushing_bats", perSec: 1 },
      { enemy: "shooter_wisp", perSec: 0.45 },
      { enemy: "dasher_wolf", perSec: 0.4 },
    ],
    // Первая контрольная точка сложности: элита приходит в назначенную минуту,
    // а не выпадает случайно из смеси.
    events: [{ kind: "ring", enemy: "elite_ghoul", count: 1 }],
  },
];

/**
 * Чем таймлайн продолжается после расписанных руками пяти минут.
 *
 * Бюджет угрозы растёт каждый отрезок; когда число живых упирается в потолок,
 * сложность продолжает расти здоровьем и уроном — врагов на экране ограничивает
 * производительность устройства, а не желание геймдизайнера
 * (docs/25-week1-fps-trials.md §6.5).
 *
 * В `pool` только обычные враги: элиты и мини-боссы приходят событиями.
 */
export const ENDLESS_CURVE: EndlessCurveDef = {
  fromSec: 330,
  segmentSec: 60,
  threatPerSec: 13,
  threatGrowth: 1.18,
  maxAlive: 240,
  hpGrowth: 1.12,
  damageGrowth: 1.06,
  pool: [
    "swarm_rat",
    "circler_crow",
    "rushing_bats",
    "dasher_wolf",
    "shooter_wisp",
    "bomber_imp",
    "splitter_slime",
    "tank_ghoul",
  ],
  startTypes: 5,
  typesPerSegment: 1,
  mixSize: 3,
  events: [
    { everySegments: 2, kind: "ring", enemy: "circler_crow", count: 20 },
    { everySegments: 3, kind: "flank", enemy: "swarm_rat", count: 20 },
    { everySegments: 4, kind: "ring", enemy: "elite_ghoul", count: 2 },
    { everySegments: 5, kind: "ring", enemy: "boss_matryoshka", count: 1 },
  ],
};
