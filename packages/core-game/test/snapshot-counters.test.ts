import { describe, expect, it } from "vitest";
import { CHESTS } from "../src/content/chests";
import { DROPS } from "../src/content/drops";
import { ENEMIES } from "../src/content/enemies";
import { MAPS } from "../src/content/maps";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { ENDLESS_CURVE, TIMELINE } from "../src/content/waves";
import { WEAPONS } from "../src/content/weapons";
import { captureWorld } from "../src/game/run/snapshot";
import { createTimelineDirector } from "../src/game/sim/director";
import { createWorld } from "../src/game/sim/world";
import { readSnapshotCounters } from "../src/snapshot-counters";

// Счётчики забега из тела снимка (tasks/T-0163): сохранение прошлой сборки
// счётчиков в `summary` не несёт, и оболочка читает убийства прямо из мира,
// не восстанавливая его. Читалка не бросает ни на каком теле.

function worldBody(enemiesKilled: number, xpCollected: number): unknown {
  const world = createWorld({
    seed: 3,
    enemies: ENEMIES,
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    drops: DROPS,
    chests: CHESTS,
    map: MAPS[0],
  });
  world.stats.enemiesKilled = enemiesKilled;
  world.stats.xpCollected = xpCollected;
  // Снимок идёт через JSON, как в хранилище устройства.
  return JSON.parse(JSON.stringify(captureWorld(world, createTimelineDirector(TIMELINE, ENDLESS_CURVE))));
}

describe("счётчики из тела снимка", () => {
  it("читает убийства и опыт из тела, снятого captureWorld", () => {
    expect(readSnapshotCounters(worldBody(37, 120))).toEqual({ enemiesKilled: 37, xpCollected: 120 });
  });

  it("читает тело формата 7: там тоже только stats.scalars", () => {
    const body = { version: 7, stats: { scalars: { enemiesKilled: 41, xpCollected: 9.5 }, arrays: {} } };
    expect(readSnapshotCounters(body)).toEqual({ enemiesKilled: 41, xpCollected: 9.5 });
  });

  it("на любом непригодном теле даёт нули и не бросает", () => {
    for (const body of [undefined, null, "строка", 42, {}, { stats: null }, { stats: {} }, { stats: { scalars: null } }, { stats: { scalars: {} } }]) {
      expect(readSnapshotCounters(body)).toEqual({ enemiesKilled: 0, xpCollected: 0 });
    }
  });

  it("отрицательное, NaN и нечисло — ноль, дробные убийства — целая часть", () => {
    const body = (enemiesKilled: unknown, xpCollected: unknown): unknown => ({ stats: { scalars: { enemiesKilled, xpCollected } } });

    expect(readSnapshotCounters(body(-5, -1))).toEqual({ enemiesKilled: 0, xpCollected: 0 });
    expect(readSnapshotCounters(body(Number.NaN, Number.POSITIVE_INFINITY))).toEqual({ enemiesKilled: 0, xpCollected: 0 });
    expect(readSnapshotCounters(body("12", "7"))).toEqual({ enemiesKilled: 0, xpCollected: 0 });
    expect(readSnapshotCounters(body(7.9, 3))).toEqual({ enemiesKilled: 7, xpCollected: 3 });
  });
});
