import type { EnemyDef } from "@bh/shared-types";

// Правит геймдизайнер напрямую, без знания Phaser — см. docs/01-tech-stack.md §9
// и docs/06-team-and-workflow.md §1 про правки через ИИ-агента по описанию.
export const ENEMIES: EnemyDef[] = [
  { id: "swarm_rat", hp: 5, speed: 90, damage: 3, pattern: "swarm" },
  { id: "tank_ghoul", hp: 60, speed: 30, damage: 8, pattern: "chase" },
  { id: "shooter_wisp", hp: 12, speed: 40, damage: 5, pattern: "kite_and_shoot" },
];
