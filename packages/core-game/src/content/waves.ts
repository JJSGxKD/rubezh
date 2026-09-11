import type { WaveDef } from "@bh/shared-types";

// Черновая кривая сложности — см. docs/05-game-design.md §4. Комбинировать
// паттерны, а не просто наращивать число врагов одного типа.
//
// Каждый новый тип появляется сначала один, в своей волне, и только потом в
// смеси: игрок должен успеть понять поведение до того, как оно спрячется в
// толпе. Волны заменит таймлайн спавна бесконечного режима
// (docs/26-stage2-plan.md, WP4.4).
export const WAVES: WaveDef[] = [
  { second: 0, spawns: [{ enemy: "swarm_rat", count: 10 }] },
  { second: 30, spawns: [{ enemy: "dasher_wolf", count: 3 }] },
  { second: 60, spawns: [{ enemy: "swarm_rat", count: 15 }, { enemy: "shooter_wisp", count: 3 }] },
  { second: 90, spawns: [{ enemy: "circler_crow", count: 6 }] },
  { second: 120, spawns: [{ enemy: "tank_ghoul", count: 2 }, { enemy: "swarm_rat", count: 20 }] },
  { second: 150, spawns: [{ enemy: "bomber_imp", count: 4 }, { enemy: "swarm_rat", count: 10 }] },
  { second: 180, spawns: [{ enemy: "splitter_slime", count: 3 }, { enemy: "dasher_wolf", count: 3 }] },
  {
    second: 240,
    spawns: [
      { enemy: "circler_crow", count: 8 },
      { enemy: "bomber_imp", count: 4 },
      { enemy: "shooter_wisp", count: 4 },
    ],
  },
];
