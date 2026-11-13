import { describe, expect, it } from "vitest";
import { CHESTS } from "../src/content/chests";
import { DROPS } from "../src/content/drops";
import { ENEMIES } from "../src/content/enemies";
import { MAPS } from "../src/content/maps";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { ENDLESS_CURVE, TIMELINE } from "../src/content/waves";
import { WEAPONS } from "../src/content/weapons";
import { chooseUpgrade, isAwaitingChoice } from "../src/game/progression/levels";
import { buildRunResult } from "../src/game/run/run-result";
import { captureWorld, restoreWorld } from "../src/game/run/snapshot";
import { killEnemy } from "../src/game/sim/combat";
import { createTimelineDirector } from "../src/game/sim/director";
import { stepWorld, IDLE_INPUT } from "../src/game/sim/step";
import { createWorld, spawnEnemy, type World } from "../src/game/sim/world";

// Итог забега несёт типы врагов, вышедших в мир (tasks/T-0479): по ним сервер открывает
// записи кодекса, а убитыми они быть не обязаны — босс и элита в «топе убийств» почти не бывают.

function newWorld(seed = 7): World {
  return createWorld({
    seed,
    enemies: ENEMIES,
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    drops: DROPS,
    chests: CHESTS,
    map: MAPS[0],
  });
}

function typeIndexOf(world: World, id: string): number {
  const index = world.enemyTypes.findIndex((type) => type.id === id);
  if (index < 0) throw new Error(`в контенте нет врага ${id}`);
  return index;
}

function seenOf(world: World): string[] | undefined {
  return buildRunResult(world, {
    runId: "seen-run",
    seed: 7,
    outcome: "abandoned",
    startingWeaponId: "spark",
    contentHash: "test-hash",
  }).enemiesSeen;
}

describe("итог забега: enemiesSeen", () => {
  it("в новом мире список пуст, но поле есть", () => {
    expect(seenOf(newWorld())).toEqual([]);
  });

  it("рядовой, элита и неубитый босс — по одному разу, в порядке появления", () => {
    const world = newWorld();
    spawnEnemy(world, typeIndexOf(world, "swarm_rat"), 400, 0);
    spawnEnemy(world, typeIndexOf(world, "elite_ghoul"), 0, 400);
    spawnEnemy(world, typeIndexOf(world, "swarm_rat"), -400, 0);
    spawnEnemy(world, typeIndexOf(world, "boss_ram"), 0, -400);
    spawnEnemy(world, typeIndexOf(world, "elite_ghoul"), 300, 300);

    expect(seenOf(world)).toEqual(["swarm_rat", "elite_ghoul", "boss_ram"]);
  });

  it("потомки делящегося попадают в список, когда он распался", () => {
    const world = newWorld();
    const slime = spawnEnemy(world, typeIndexOf(world, "splitter_slime"), 200, 0);
    expect(seenOf(world)).toEqual(["splitter_slime"]);

    killEnemy(world, slime);

    expect(seenOf(world)).toEqual(["splitter_slime", "swarm_rat"]);
  });

  it("босс-матрёшка приводит за собой всю смесь своих потомков", () => {
    const world = newWorld();
    const boss = spawnEnemy(world, typeIndexOf(world, "boss_matryoshka"), 200, 0);
    killEnemy(world, boss);

    const seen = seenOf(world) ?? [];
    expect(seen[0]).toBe("boss_matryoshka");
    expect(new Set(seen)).toEqual(new Set(["boss_matryoshka", "splitter_slime", "dasher_wolf", "bomber_imp"]));
    expect(seen).toHaveLength(4);
  });

  it("не вышедший в мир тип не попадает в список: пул исчерпан — слот не занят", () => {
    const world = newWorld();
    const rat = typeIndexOf(world, "swarm_rat");
    for (let i = 0; i < world.config.maxEnemies; i++) spawnEnemy(world, rat, i, 0);

    expect(spawnEnemy(world, typeIndexOf(world, "boss_ram"), 0, 0)).toBe(-1);
    expect(seenOf(world)).toEqual(["swarm_rat"]);
  });

  it("список не длиннее числа типов в контенте", () => {
    const world = newWorld();
    for (let index = 0; index < world.enemyTypes.length; index++) spawnEnemy(world, index, index * 10, 0);
    for (let index = 0; index < world.enemyTypes.length; index++) spawnEnemy(world, index, index * 10, 50);

    const seen = seenOf(world) ?? [];
    expect(seen).toHaveLength(world.enemyTypes.length);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("забег по таймлайну доходит до первого босса (11-я минута): элита и босс в списке", { timeout: 30_000 }, () => {
    const world = newWorld(4242);
    const director = createTimelineDirector(TIMELINE, ENDLESS_CURVE);
    const ticks = 12 * 60 * 60;
    for (let done = 0; done < ticks; ) {
      // Игрок бессмертен: проверяется появление врагов таймлайна, а не выживание.
      world.player.hp = world.player.maxHp;
      if (isAwaitingChoice(world)) {
        chooseUpgrade(world, world.progression.offers[0].id);
        continue;
      }
      director.update(world, 1 / 60);
      stepWorld(world, IDLE_INPUT);
      done++;
    }

    const seen = seenOf(world) ?? [];
    const ranks = seen.map((id) => ENEMIES.find((enemy) => enemy.id === id)?.rank);
    expect(ranks).toContain("elite");
    expect(ranks).toContain("boss");
    // Порядок — первого появления: рядовой поток открывается раньше любой элиты.
    expect(ENEMIES.find((enemy) => enemy.id === seen[0])?.rank).toBeUndefined();
    expect(new Set(seen).size).toBe(seen.length);
    // Все id — из контента.
    for (const id of seen) expect(ENEMIES.some((enemy) => enemy.id === id)).toBe(true);
  });

  it("сбор не трогает мир: генератор и позиции те же, что без итога", () => {
    const a = newWorld(11);
    const b = newWorld(11);
    for (const world of [a, b]) {
      spawnEnemy(world, typeIndexOf(world, "dasher_wolf"), 300, 0);
      stepWorld(world, IDLE_INPUT);
    }
    seenOf(a);

    expect(a.rng.getState()).toBe(b.rng.getState());
    expect(a.enemies.x[0]).toBe(b.enemies.x[0]);
  });

  it("после продолжения из снимка в списке — убитые и живые типы, забег дописывает дальше", () => {
    const original = newWorld(31);
    const director = createTimelineDirector(TIMELINE, ENDLESS_CURVE);
    spawnEnemy(original, typeIndexOf(original, "swarm_rat"), 300, 0);
    const wolf = spawnEnemy(original, typeIndexOf(original, "dasher_wolf"), 0, 300);
    killEnemy(original, wolf);
    spawnEnemy(original, typeIndexOf(original, "boss_ram"), -300, 0);
    const saved = JSON.parse(JSON.stringify(captureWorld(original, director))) as unknown;

    const resumed = newWorld(31);
    restoreWorld(resumed, createTimelineDirector(TIMELINE, ENDLESS_CURVE), saved);
    spawnEnemy(resumed, typeIndexOf(resumed, "elite_ghoul"), 0, -300);

    const seen = seenOf(resumed) ?? [];
    expect(new Set(seen)).toEqual(new Set(["swarm_rat", "dasher_wolf", "boss_ram", "elite_ghoul"]));
    expect(seen).toHaveLength(4);
  });
});
