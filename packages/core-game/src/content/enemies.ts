import type { EnemyDef } from "@bh/shared-types";

// Правит геймдизайнер напрямую, без знания Phaser — см. docs/01-tech-stack.md §9
// и docs/06-team-and-workflow.md §1 про правки через ИИ-агента по описанию.
//
// Параметры паттерна (`params`) необязательны: незаданное берётся из умолчаний
// паттерна. Какие параметры есть у какого паттерна — подсказывает TypeScript,
// смысл каждого — в EnemyPatternParams (packages/shared-types).
//
// `xp` — ценность кристалла опыта, который остаётся после смерти врага:
// дорогой враг должен и качать быстрее, иначе его незачем убивать.
//
// `threat` — стоимость врага в бюджете отрезка таймлайна: директор спавна
// выпускает столько врагов, сколько влезает в бюджет (docs/26-stage2-plan.md,
// WP4.4). Числа проставлены руками, а не формулой: формула честно считает, во
// что враг обходится игроку по здоровью и урону, но не знает, что рой обязан
// приходить десятками, а танк — поодиночке.
//
// Числа — стартовые, до спецификации геймдизайнера (docs/26-stage2-plan.md, WP1).
export const ENEMIES: EnemyDef[] = [
  { id: "swarm_rat", hp: 5, speed: 90, damage: 3, xp: 1, threat: 1, pattern: "swarm" },
  { id: "tank_ghoul", hp: 60, speed: 30, damage: 8, xp: 6, threat: 8, pattern: "chase" },
  { id: "shooter_wisp", hp: 12, speed: 40, damage: 5, xp: 3, threat: 3, pattern: "kite_and_shoot" },
  { id: "dasher_wolf", hp: 14, speed: 60, damage: 7, xp: 3, threat: 3, pattern: "dash" },
  // Вороны берут числом и теснотой кольца: приходят стаей, заходят широко и
  // сжимаются вдвое быстрее прежнего. Они единственные быстрее игрока —
  // от кольца не убежать, его придётся разрывать. Здоровья вдвое больше
  // прежнего: ворон, гибнущий с одного касания оружия, кольца не держит.
  {
    id: "circler_crow",
    hp: 14,
    speed: 200,
    damage: 4,
    xp: 2,
    threat: 3,
    pattern: "orbit",
    params: { orbitRadius: 220, shrinkPerSec: 34, minRadius: 0 },
  },
  { id: "bomber_imp", hp: 10, speed: 80, damage: 18, xp: 4, threat: 4, pattern: "exploder" },
  // Нетопыри не преследуют вовсе: берут упреждение, проносятся мимо насквозь
  // и через пару секунд заходят снова. Давление от них не в погоне, а в том,
  // что поперёк пути отхода внезапно идёт стена тел — поэтому они и быстрые,
  // и дешёвые, и приходят десятками.
  {
    id: "rushing_bats",
    hp: 6,
    speed: 300,
    damage: 6,
    xp: 1,
    threat: 2,
    pattern: "rush",
    params: { leadSec: 0.55, runSec: 2.6 },
  },
  {
    id: "splitter_slime",
    hp: 24,
    speed: 40,
    damage: 5,
    xp: 4,
    threat: 5,
    pattern: "splitter",
    params: { childEnemy: "swarm_rat", childCount: 3 },
  },

  // Элиты и мини-боссы приходят только событиями таймлайна, в заданные минуты
  // (docs/26-stage2-plan.md, WP4.4), и в обычную смесь отрезка не попадают:
  // контрольная точка сложности внутри забега обязана быть событием, а не
  // случайностью (docs/05-game-design.md §4).
  {
    id: "elite_ghoul",
    hp: 260,
    speed: 38,
    damage: 14,
    xp: 25,
    threat: 30,
    rank: "elite",
    pattern: "chase",
    params: { steeringPerSec: 2.4 },
  },
  {
    id: "miniboss_maw",
    hp: 700,
    speed: 46,
    damage: 20,
    xp: 60,
    threat: 200,
    rank: "boss",
    pattern: "splitter",
    params: { childEnemy: "dasher_wolf", childCount: 6 },
  },
];
