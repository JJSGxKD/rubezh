import type { EnemyDef } from "@bh/shared-types";

// Правит геймдизайнер напрямую, без знания Phaser — см. docs/01-tech-stack.md §9
// и docs/06-team-and-workflow.md §1 про правки через ИИ-агента по описанию.
//
// Параметры паттерна (`params`) необязательны: незаданное берётся из умолчаний
// паттерна. Какие параметры есть у какого паттерна — подсказывает TypeScript,
// смысл каждого — в EnemyPatternParams (packages/shared-types).
//
// Числа четырёх новых врагов — стартовые, до спецификации геймдизайнера
// (docs/26-stage2-plan.md, WP1).
export const ENEMIES: EnemyDef[] = [
  { id: "swarm_rat", hp: 5, speed: 90, damage: 3, pattern: "swarm" },
  { id: "tank_ghoul", hp: 60, speed: 30, damage: 8, pattern: "chase" },
  { id: "shooter_wisp", hp: 12, speed: 40, damage: 5, pattern: "kite_and_shoot" },
  { id: "dasher_wolf", hp: 14, speed: 60, damage: 7, pattern: "dash" },
  { id: "circler_crow", hp: 8, speed: 110, damage: 4, pattern: "orbit" },
  { id: "bomber_imp", hp: 10, speed: 80, damage: 18, pattern: "exploder" },
  {
    id: "splitter_slime",
    hp: 24,
    speed: 40,
    damage: 5,
    pattern: "splitter",
    params: { childEnemy: "swarm_rat", childCount: 3 },
  },
];
