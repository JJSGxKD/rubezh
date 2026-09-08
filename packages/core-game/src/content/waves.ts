import type { WaveDef } from "@bh/shared-types";

// Черновая кривая сложности для прототипа недели 1 — см. docs/05-game-design.md §4.
// Комбинировать паттерны, а не просто наращивать число врагов одного типа.
export const WAVES: WaveDef[] = [
  { second: 0, spawns: [{ enemy: "swarm_rat", count: 10 }] },
  { second: 60, spawns: [{ enemy: "swarm_rat", count: 15 }, { enemy: "shooter_wisp", count: 3 }] },
  { second: 120, spawns: [{ enemy: "tank_ghoul", count: 2 }, { enemy: "swarm_rat", count: 20 }] },
];
