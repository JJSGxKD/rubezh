import type { ChestsDef, EnemyDef } from "@bh/shared-types";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHESTS } from "../src/content/chests";
import { CONTENT_HASH } from "../src/content/hash";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
import { buildRunResult } from "../src/game/run/run-result";
import { openChest } from "../src/game/sim/chests";
import { createWorld, type World } from "../src/game/sim/world";

// Редкие сундуки: открытые сундуки самого крупного размера из таблицы весов
// (tasks/T-0175). Счётчик только считает: ни world.rng, ни поток сундуков,
// ни порядок событий он не трогает, поэтому эталоны баланса не двигаются.

const GRUNT: EnemyDef = { id: "grunt", hp: 10, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };

function setup(chests: ChestsDef = CHESTS, seed = 1): World {
  return createWorld({
    seed,
    enemies: [GRUNT],
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    chests: { ...chests, maxOnField: 8 },
  });
}

describe("редкий сундук — самый крупный размер из таблицы", () => {
  it("сундуки размера 1 и 3 редкими не считаются", () => {
    const world = setup();
    openChest(world, 1);
    openChest(world, 3);

    expect(world.stats.chestsOpened).toBe(2);
    expect(world.stats.rareChestsOpened).toBe(0);
  });

  it("сундук размера 5 — редкий, и он же входит в общее число", () => {
    const world = setup();
    openChest(world, 5);

    expect(world.stats.chestsOpened).toBe(1);
    expect(world.stats.rareChestsOpened).toBe(1);
  });

  it("считает каждый открытый сундук наибольшего размера", () => {
    const world = setup();
    openChest(world, 5);
    openChest(world, 1);
    openChest(world, 5);

    expect(world.stats.chestsOpened).toBe(3);
    expect(world.stats.rareChestsOpened).toBe(2);
  });

  it("таблица без пятёрки: редким считается наибольший размер таблицы, а не пять", () => {
    const small: ChestsDef = {
      ...CHESTS,
      opening: [],
      sizes: [
        { size: 1, weight: 9 },
        { size: 3, weight: 1 },
      ],
      bossMinSize: 3,
      late: undefined,
    };
    const world = setup(small);
    openChest(world, 1);
    expect(world.stats.rareChestsOpened).toBe(0);
    openChest(world, 3);
    expect(world.stats.rareChestsOpened).toBe(1);
    openChest(world, 5);
    expect(world.stats.rareChestsOpened).toBe(1);
  });

  it("в таблице из одного размера этот размер и есть редкий", () => {
    const single: ChestsDef = { ...CHESTS, opening: [], sizes: [{ size: 1, weight: 1 }], bossMinSize: 1, late: undefined };
    const world = setup(single);
    openChest(world, 1);

    expect(world.stats.rareChestsOpened).toBe(1);
  });

  it("поздняя таблица на понятие «редкий» не влияет: считается основная", () => {
    const withLate: ChestsDef = { ...CHESTS, late: { afterSec: 1, sizes: [{ size: 1, weight: 1 }], bossMinSize: 1 } };
    const world = setup(withLate);
    world.stats.elapsedSec = 900;
    openChest(world, 5);

    expect(world.stats.rareChestsOpened).toBe(1);
  });
});

describe("счётчик не трогает симуляцию", () => {
  it("открытие сундуков не сдвигает world.rng и даёт одни и те же награды при том же seed", () => {
    const first = setup(CHESTS, 7);
    const second = setup(CHESTS, 7);
    const rngBefore = first.rng.getState();
    for (const size of [5, 1, 5, 3] as const) {
      openChest(first, size);
      openChest(second, size);
    }

    expect(first.rng.getState()).toBe(rngBefore);
    expect(first.chests.rng.getState()).toBe(second.chests.rng.getState());
    expect(first.chests.openings.map((opening) => opening.rewards.map((reward) => reward.id))).toEqual(
      second.chests.openings.map((opening) => opening.rewards.map((reward) => reward.id)),
    );
  });

  it("данные сундуков и хэш контента прежние", () => {
    expect(CONTENT_HASH).toMatch(/^[0-9a-f]{8}$/);
    expect(CHESTS.sizes).toEqual([
      { size: 1, weight: 87 },
      { size: 3, weight: 10 },
      { size: 5, weight: 3 },
    ]);
  });

  it("в game/sim/chests.ts по-прежнему нет обращений к world.rng", () => {
    // Комментарии файла называют `world.rng` прямо, поэтому смотрим на код без них.
    const source = readFileSync(new URL("../src/game/sim/chests.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/world\.rng/);
  });
});

describe("итог забега", () => {
  it("buildRunResult несёт число редких сундуков из мира", () => {
    const world = setup();
    openChest(world, 5);
    openChest(world, 5);
    openChest(world, 1);

    const result = buildRunResult(world, {
      runId: "r",
      seed: 1,
      outcome: "died",
      startingWeaponId: "spark",
      contentHash: "h",
    });

    expect(result.chestsOpened).toBe(3);
    expect(result.rareChestsOpened).toBe(2);
  });
});
