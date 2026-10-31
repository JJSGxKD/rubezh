import type { EnemyDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { CHESTS } from "../src/content/chests";
import { findDifficulty } from "../src/content/difficulty";
import { DROPS } from "../src/content/drops";
import { ENEMIES } from "../src/content/enemies";
import { MAPS } from "../src/content/maps";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { ENDLESS_CURVE, TIMELINE } from "../src/content/waves";
import { WEAPONS } from "../src/content/weapons";
import { createBot } from "../src/game/balance";
import { addXp, chooseUpgrade, isAwaitingChoice } from "../src/game/progression/levels";
import { buildRunResult } from "../src/game/run/run-result";
import { openChest } from "../src/game/sim/chests";
import { killEnemy } from "../src/game/sim/combat";
import { createTimelineDirector } from "../src/game/sim/director";
import { spawnGem, updateGems } from "../src/game/sim/gems";
import { IDLE_INPUT, stepWorld } from "../src/game/sim/step";
import { createWorld, spawnEnemy, TICK_SEC, type World } from "../src/game/sim/world";

// Счётчики итога забега: убитые боссы и элиты, подобранные кристаллы
// (tasks/T-0125). Они только считают: ни world.rng, ни порядок событий не
// трогают, поэтому эталоны баланса не двигаются.

const GRUNT: EnemyDef = { id: "grunt", hp: 10, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };
const ELITE: EnemyDef = { id: "elite", hp: 100, speed: 0.001, damage: 0, xp: 1, pattern: "swarm", rank: "elite" };
const BOSS: EnemyDef = { id: "boss", hp: 100, speed: 0.001, damage: 0, xp: 1, pattern: "swarm", rank: "boss" };
/** Босс-матрёшка: его потомки рядовые и в счёт боссов не идут. */
const SPLIT_BOSS: EnemyDef = {
  id: "split_boss",
  hp: 100,
  speed: 0.001,
  damage: 0,
  xp: 1,
  pattern: "splitter",
  rank: "boss",
  params: { children: [{ enemy: "grunt", count: 3 }] },
};
const FIXTURE = [GRUNT, ELITE, BOSS, SPLIT_BOSS];
const [GRUNT_TYPE, ELITE_TYPE, BOSS_TYPE, SPLIT_BOSS_TYPE] = [0, 1, 2, 3];

function fixtureWorld(seed = 1): World {
  return createWorld({
    seed,
    enemies: FIXTURE,
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    chests: CHESTS,
  });
}

function kill(world: World, type: number): void {
  killEnemy(world, spawnEnemy(world, type, 100, 0));
}

describe("убийства по рангам", () => {
  it("рядовой: считается в общем числе, но не среди боссов и элит", () => {
    const world = fixtureWorld();
    kill(world, GRUNT_TYPE);

    expect(world.stats.enemiesKilled).toBe(1);
    expect(world.stats.bossKills).toBe(0);
    expect(world.stats.eliteKills).toBe(0);
  });

  it("элита: eliteKills растёт, bossKills нет", () => {
    const world = fixtureWorld();
    kill(world, ELITE_TYPE);

    expect(world.stats.enemiesKilled).toBe(1);
    expect(world.stats.eliteKills).toBe(1);
    expect(world.stats.bossKills).toBe(0);
  });

  it("босс: bossKills растёт, eliteKills нет", () => {
    const world = fixtureWorld();
    kill(world, BOSS_TYPE);

    expect(world.stats.enemiesKilled).toBe(1);
    expect(world.stats.bossKills).toBe(1);
    expect(world.stats.eliteKills).toBe(0);
  });

  it("потомки делящегося босса рядовые: в боссы не идут, в общее число — да", () => {
    const world = fixtureWorld();
    kill(world, SPLIT_BOSS_TYPE);
    expect(world.enemies.aliveCount).toBe(3);

    for (let i = 0; i < world.enemies.count; i++) {
      if (world.enemies.alive[i] === 1) killEnemy(world, i);
    }

    expect(world.stats.enemiesKilled).toBe(4);
    expect(world.stats.bossKills).toBe(1);
    expect(world.stats.eliteKills).toBe(0);
  });

  it("сумма боссов и элит никогда не больше общего числа убитых", () => {
    const world = fixtureWorld();
    for (const type of [GRUNT_TYPE, ELITE_TYPE, BOSS_TYPE, GRUNT_TYPE, ELITE_TYPE, ELITE_TYPE]) kill(world, type);

    expect(world.stats.enemiesKilled).toBe(6);
    expect(world.stats.eliteKills).toBe(3);
    expect(world.stats.bossKills).toBe(1);
    expect(world.stats.bossKills + world.stats.eliteKills).toBeLessThanOrEqual(world.stats.enemiesKilled);
  });
});

describe("подобранные кристаллы", () => {
  /** Игрок стоит в нуле: кристалл в той же точке подбирается сразу после посадки. */
  function gemWorld(): World {
    const world = fixtureWorld();
    world.player.x = 0;
    world.player.y = 0;
    return world;
  }

  it("подобранный кристалл — плюс один", () => {
    const world = gemWorld();
    spawnGem(world, 0, 0, 5);
    updateGems(world, TICK_SEC);

    expect(world.stats.crystalsCollected).toBe(1);
    expect(world.stats.xpCollected).toBe(5);
  });

  it("слитый с соседним кристалл — один подбор, а не два", () => {
    const world = gemWorld();
    const capacity = world.gems.alive.length;
    // Пул заполняется целиком, ещё один кристалл сливается с уже лежащим.
    for (let i = 0; i < capacity + 1; i++) spawnGem(world, 0, 0, 1);
    expect(world.gems.aliveCount).toBe(capacity);

    updateGems(world, TICK_SEC);

    expect(world.stats.crystalsCollected).toBe(capacity);
    expect(world.stats.xpCollected).toBe(capacity + 1);
  });

  it("улетевший за радиус удержания не считается", () => {
    const world = gemWorld();
    spawnGem(world, world.config.view.retentionRadius * 2, 0, 5);
    updateGems(world, TICK_SEC);

    expect(world.gems.aliveCount).toBe(0);
    expect(world.stats.crystalsCollected).toBe(0);
  });

  it("летящий кристалл ещё не подобран", () => {
    const world = gemWorld();
    spawnGem(world, 0, 0, 5, 0, 0, true);
    updateGems(world, TICK_SEC);

    expect(world.stats.crystalsCollected).toBe(0);
  });

  it("запасной опыт сундука и addXp без счёта кристаллом не считаются", () => {
    const world = gemWorld();
    addXp(world, 7, false);
    expect(world.stats.crystalsCollected).toBe(0);

    openChest(world, 1);
    expect(world.stats.chestsOpened).toBe(1);
    expect(world.stats.crystalsCollected).toBe(0);
  });
});

describe("итог забега", () => {
  it("buildRunResult несёт счётчики мира", () => {
    const world = fixtureWorld();
    kill(world, BOSS_TYPE);
    kill(world, ELITE_TYPE);
    world.stats.crystalsCollected = 12;
    world.stats.chestsOpened = 2;

    const result = buildRunResult(world, {
      runId: "r",
      seed: 1,
      outcome: "died",
      startingWeaponId: "spark",
      contentHash: "h",
    });

    expect(result.bossKills).toBe(1);
    expect(result.eliteKills).toBe(1);
    expect(result.chestsOpened).toBe(2);
    expect(result.crystalsCollected).toBe(12);
  });
});

interface Counters {
  boss: number;
  elite: number;
  crystals: number;
  chests: number;
  killed: number;
}

function countersOf(world: World): Counters {
  const stats = world.stats;
  return {
    boss: stats.bossKills,
    elite: stats.eliteKills,
    crystals: stats.crystalsCollected,
    chests: stats.chestsOpened,
    killed: stats.enemiesKilled,
  };
}

/** Забег бота на боевом контенте «Лёгкой»; `onTick` видит мир после каждого шага. */
function botRun(seed: number, maxSec: number, onTick: (world: World) => void): World {
  const difficulty = findDifficulty("easy");
  const world = createWorld({
    seed,
    enemies: ENEMIES,
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    drops: DROPS,
    chests: CHESTS,
    map: MAPS[0],
    ...(difficulty === undefined ? {} : { difficulty }),
  });
  const director = createTimelineDirector(TIMELINE, ENDLESS_CURVE);
  const bot = createBot("dodging");
  const maxTicks = Math.round(maxSec / TICK_SEC);

  for (let tick = 0; tick < maxTicks && world.player.alive; ) {
    if (isAwaitingChoice(world)) {
      chooseUpgrade(world, bot.choose(world.progression.offers));
      continue;
    }
    director.update(world, TICK_SEC);
    stepWorld(world, bot.input(world));
    onTick(world);
    tick++;
  }
  return world;
}

describe("счётчики на прогоне бота", () => {
  it("соотношения держатся, а счётчики не убывают между тиками", { timeout: 90_000 }, () => {
    for (const seed of [1, 2, 3]) {
      let previous: Counters = { boss: 0, elite: 0, crystals: 0, chests: 0, killed: 0 };
      const world = botRun(seed, 300, (current) => {
        const now = countersOf(current);
        // Одна проверка на тик вместо пяти expect: прогон длинный.
        const shrunk =
          now.boss < previous.boss ||
          now.elite < previous.elite ||
          now.crystals < previous.crystals ||
          now.chests < previous.chests ||
          now.killed < previous.killed;
        if (shrunk) expect(now, `seed ${seed}, тик ${current.stats.tick}`).toEqual(previous);
        previous = now;
      });
      const end = countersOf(world);

      expect(end.boss + end.elite, `seed ${seed}`).toBeLessThanOrEqual(end.killed);
      expect(end.chests, `seed ${seed}`).toBeLessThanOrEqual(end.boss + end.elite);
      expect(end.crystals, `seed ${seed}`).toBeGreaterThan(0);
    }
  });
});

describe("счётчики не трогают симуляцию", () => {
  function script(world: World, resetCounters: boolean): void {
    for (let i = 0; i < 40; i++) {
      kill(world, i % 3 === 0 ? ELITE_TYPE : GRUNT_TYPE);
      if (resetCounters) {
        // Контроль: без счётчиков мир идёт так же.
        world.stats.bossKills = 0;
        world.stats.eliteKills = 0;
        world.stats.crystalsCollected = 0;
      }
      stepWorld(world, IDLE_INPUT);
    }
  }

  it("два мира с одним seed дают равные счётчики", () => {
    const first = fixtureWorld(9);
    const second = fixtureWorld(9);
    script(first, false);
    script(second, false);

    expect(countersOf(second)).toEqual(countersOf(first));
    expect(first.stats.eliteKills).toBeGreaterThan(0);
  });

  it("обнуление счётчиков не меняет ни генератор, ни убийства, ни подборы", () => {
    const counted = fixtureWorld(9);
    const reset = fixtureWorld(9);
    script(counted, false);
    script(reset, true);

    expect(reset.rng.getState()).toBe(counted.rng.getState());
    expect(reset.stats.enemiesKilled).toBe(counted.stats.enemiesKilled);
    expect(reset.stats.xpCollected).toBe(counted.stats.xpCollected);
    expect(reset.chests.dropped).toBe(counted.chests.dropped);
  });
});
