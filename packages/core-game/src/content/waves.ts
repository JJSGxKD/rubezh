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
      { enemy: "bone_walker", perSec: 0.5, burst: 4 },
    ],
  },
  {
    fromSec: 90,
    spawns: [
      { enemy: "swarm_rat", perSec: 2.2 },
      { enemy: "circler_crow", perSec: 1.4, burst: 8 },
    ],
    // Первая элита приходит на 90-й секунде, а не на 300-й: первый сундук
    // должен выпасть около 2:00, пока большинство ботов-забегов ещё живо
    // (docs/39-retention-mechanics.md §3).
    events: [{ kind: "ring", enemy: "elite_ghoul", count: 1 }],
  },
  {
    fromSec: 120,
    spawns: [
      { enemy: "swarm_rat", perSec: 2.4 },
      { enemy: "circler_crow", perSec: 0.9 },
      { enemy: "bone_walker", perSec: 0.4 },
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
      { enemy: "bone_walker", perSec: 0.3 },
    ],
  },
  {
    fromSec: 180,
    spawns: [
      { enemy: "swarm_rat", perSec: 2.6 },
      { enemy: "circler_crow", perSec: 1.6 },
      { enemy: "mire_shambler", perSec: 0.22, burst: 2 },
    ],
    events: [
      { kind: "ring", enemy: "circler_crow", count: 16 },
      // Первое кольцо редкое и слабое: 24 стража на 30 секунд, из них около 14
      // строй «держит» — стражам нужно время, чтобы дойти. Дальше кольца
      // крепнут: больше стражей, дольше и быстрее сжимаются.
      { kind: "cordon", enemy: "cordon_guard", count: 24, ring: { radius: 170, minRadius: 90, shrinkPerSec: 3, lifeSec: 30 } },
    ],
  },
  {
    // Нетопыри показываются отдельно: поперёк поля идёт стая, и игрок должен
    // успеть понять, что от неё уходят вбок, а не бегут по прямой.
    fromSec: 210,
    spawns: [
      { enemy: "swarm_rat", perSec: 2.2 },
      { enemy: "circler_crow", perSec: 0.9 },
      { enemy: "rushing_bats", perSec: 2.2, burst: 12 },
      { enemy: "bone_walker", perSec: 0.15 },
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
    // Рыцарь — вторая элита забега: после первой на 90-й секунде и до кольца
    // на 300-й (docs/39-retention-mechanics.md §3).
    events: [{ kind: "flank", enemy: "elite_grave_knight", count: 1 }],
  },
  {
    fromSec: 270,
    spawns: [
      { enemy: "swarm_rat", perSec: 2.8 },
      { enemy: "circler_crow", perSec: 1.1 },
      { enemy: "rushing_bats", perSec: 0.8 },
      { enemy: "mire_shambler", perSec: 0.2 },
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
      { enemy: "bone_walker", perSec: 0.7 },
      { enemy: "dasher_wolf", perSec: 0.4 },
    ],
    // Первая контрольная точка сложности: элита приходит в назначенную минуту,
    // а не выпадает случайно из смеси.
    events: [
      { kind: "ring", enemy: "elite_ghoul", count: 1 },
      { kind: "cordon", enemy: "cordon_guard", count: 32, ring: { radius: 200, minRadius: 90, shrinkPerSec: 4, lifeSec: 35 } },
    ],
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
  threatPerSec: 14.4,
  threatGrowth: 1.22,
  maxAlive: 240,
  hpGrowth: 1.14,
  damageGrowth: 1.08,
  pool: [
    "swarm_rat",
    "circler_crow",
    "rushing_bats",
    "dasher_wolf",
    "bomber_imp",
    "splitter_slime",
    "tank_ghoul",
    "bone_walker",
    "mire_shambler",
  ],
  startTypes: 5,
  typesPerSegment: 1,
  mixSize: 3,
  events: [
    { everySegments: 2, kind: "ring", enemy: "circler_crow", count: 20 },
    { everySegments: 3, kind: "flank", enemy: "swarm_rat", count: 20 },
    { everySegments: 4, kind: "ring", enemy: "elite_ghoul", count: 2 },
    { everySegments: 6, kind: "flank", enemy: "elite_grave_knight", count: 1 },
    { everySegments: 5, kind: "ring", enemy: "boss_matryoshka", count: 1 },
    // После 8-й минуты элиты и Матрёшка приходят каждую-вторую минуту, а не раз
    // в пять; второй босс — отдельная задача, поэтому «больше боссов» здесь
    // значит больше событий той же Матрёшки.
    { everySegments: 7, kind: "ring", enemy: "elite_ghoul", count: 3 },
    { everySegments: 8, kind: "ring", enemy: "boss_matryoshka", count: 1 },
    { everySegments: 9, kind: "flank", enemy: "elite_grave_knight", count: 2 },
    // Кольца на 450, 630, 810 с и дальше: между ними всегда больше lifeSec, а
    // крепнут они здоровьем стража — ступенями и hpGrowth кривой, поэтому
    // параметры кольца с отрезка на отрезок не растут.
    { everySegments: 3, kind: "cordon", enemy: "cordon_guard", count: 40, ring: { radius: 240, minRadius: 100, shrinkPerSec: 5, lifeSec: 45 } },
  ],
};
