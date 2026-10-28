import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHESTS } from "../src/content/chests";
import { findDifficulty } from "../src/content/difficulty";
import { DROPS } from "../src/content/drops";
import { ENEMIES } from "../src/content/enemies";
import { MAPS } from "../src/content/maps";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { ENDLESS_CURVE, TIMELINE } from "../src/content/waves";
import { WEAPONS } from "../src/content/weapons";
import { applyCardTool, BANISH_PREFIX, REROLL_COMMAND } from "../src/game/progression/card-tools";
import { chooseUpgrade, isAwaitingChoice } from "../src/game/progression/levels";
import { captureWorld, restoreWorld, SnapshotError, WORLD_SNAPSHOT_VERSION } from "../src/game/run/snapshot";
import { RUN_SNAPSHOT_FORMAT } from "../src/run-api";
import { readSnapshotCounters } from "../src/snapshot-counters";
import { dropChest, openChest } from "../src/game/sim/chests";
import { createTimelineDirector } from "../src/game/sim/director";
import type { Spawner } from "../src/game/sim/spawner";
import { stepWorld, type SimInput } from "../src/game/sim/step";
import { createWorld, TICK_SEC, type CreateWorldOptions, type World } from "../src/game/sim/world";
import { takeCordonEvents } from "../src/game/sim/cordon";
import { damageEnemy } from "../src/game/sim/combat";
import { advanceRun, aliveGuards, checksumWorld, createCordonRun } from "./helpers/scripted-run";

// Продолжение прерванного забега (game/run/snapshot.ts): снимок, записанный в
// строку и прочитанный обратно, обязан дать ровно тот же забег, что шёл бы без
// перерыва. Иначе «продолжить» — это другой забег с тем же номером.

interface Run {
  world: World;
  director: Spawner;
}

function newRun(seed: number, patch: Partial<CreateWorldOptions> = {}): Run {
  return {
    world: createWorld({
      ...patch,
      seed,
      enemies: ENEMIES,
      weapons: WEAPONS,
      passives: PASSIVES,
      levelCurve: LEVEL_CURVE,
      loadoutLimits: LOADOUT_LIMITS,
      drops: DROPS,
      chests: CHESTS,
      map: MAPS[0],
    }),
    director: createTimelineDirector(TIMELINE, ENDLESS_CURVE),
  };
}

/**
 * Ввод, зависящий только от тика. Бот калибровки не годится: он смотрит в
 * сетку коллизий и помнит прошлое направление, а это состояние теста, а не
 * мира, — расхождение померило бы бота, а не снимок.
 */
const DIRECTIONS: readonly SimInput[] = [
  { moveX: 1, moveY: 0 },
  { moveX: 1, moveY: 1 },
  { moveX: 0, moveY: 1 },
  { moveX: -1, moveY: 1 },
  { moveX: -1, moveY: 0 },
  { moveX: -1, moveY: -1 },
  { moveX: 0, moveY: -1 },
  { moveX: 1, moveY: -1 },
];

function advance(run: Run, ticks: number): void {
  for (let done = 0; done < ticks && run.world.player.alive; ) {
    if (isAwaitingChoice(run.world)) {
      // Второй вариант, а не первый: так в набор попадают и пассивки.
      const offers = run.world.progression.offers;
      chooseUpgrade(run.world, (offers[1] ?? offers[0]).id);
      continue;
    }
    run.director.update(run.world, TICK_SEC);
    stepWorld(run.world, DIRECTIONS[Math.floor(run.world.stats.tick / 90) % DIRECTIONS.length]);
    done++;
  }
}

function roundTrip(run: Run): unknown {
  return JSON.parse(JSON.stringify(captureWorld(run.world, run.director)));
}

describe("снимок забега", () => {
  // Гоняет мир минутами: в полном прогоне монорепо пяти секунд Vitest не хватает.
  it("продолженный забег идёт ровно так же, как непрерванный", { timeout: 30_000 }, () => {
    const original = newRun(4242);
    advance(original, 60 * 60);
    const saved = roundTrip(original);

    const resumed = newRun(4242);
    restoreWorld(resumed.world, resumed.director, saved);
    expect(checksumWorld(resumed.world)).toBe(checksumWorld(original.world));

    advance(original, 90 * 60);
    advance(resumed, 90 * 60);

    // Прогон должен дойти до прокачки и бесконечного таймлайна, иначе
    // проверка обходит самые хрупкие части состояния.
    expect(original.world.loadout.passives.length).toBeGreaterThan(0);
    expect(original.world.stats.enemiesKilled).toBeGreaterThan(100);
    expect(checksumWorld(resumed.world)).toBe(checksumWorld(original.world));
    expect(resumed.world.stats).toEqual(original.world.stats);
    expect(resumed.world.rng.getState()).toBe(original.world.rng.getState());
  });

  it("продолжает на той же сложности: мир из снимка создаётся с её поправками", () => {
    const hard = findDifficulty("hard");
    if (hard === undefined) throw new Error("нет сложности hard");
    const make = (): Run => {
      const run = newRun(12);
      run.world = createWorld({
        seed: 12,
        enemies: ENEMIES,
        weapons: WEAPONS,
        passives: PASSIVES,
        levelCurve: LEVEL_CURVE,
        loadoutLimits: LOADOUT_LIMITS,
        drops: DROPS,
        chests: CHESTS,
        map: MAPS[0],
        difficulty: hard,
      });
      return run;
    };

    const original = make();
    advance(original, 70 * 60);
    const resumed = make();
    restoreWorld(resumed.world, resumed.director, roundTrip(original));
    advance(original, 30 * 60);
    advance(resumed, 30 * 60);

    expect(checksumWorld(resumed.world)).toBe(checksumWorld(original.world));
    expect(resumed.world.difficulty.hpMul).toBeGreaterThan(1);
  });

  it("сохраняет забег, остановленный на выборе улучшения, вместе с вариантами", () => {
    const original = newRun(77);
    while (!isAwaitingChoice(original.world)) {
      original.director.update(original.world, TICK_SEC);
      stepWorld(original.world, DIRECTIONS[0]);
    }

    const resumed = newRun(77);
    restoreWorld(resumed.world, resumed.director, roundTrip(original));
    expect(isAwaitingChoice(resumed.world)).toBe(true);
    expect(resumed.world.progression.offers).toEqual(original.world.progression.offers);
  });

  it("сохраняет поток сундуков: следующий сундук такой же, как без перерыва", () => {
    const original = newRun(31);
    advance(original, 20 * 60);
    dropChest(original.world, 300, 0, "elite");
    openChest(original.world, 3);
    const saved = roundTrip(original);

    const resumed = newRun(31);
    restoreWorld(resumed.world, resumed.director, saved);
    expect(resumed.world.chests.dropped).toBe(original.world.chests.dropped);
    expect(resumed.world.chests.opened).toBe(original.world.chests.opened);
    expect(resumed.world.chests.rng.getState()).toBe(original.world.chests.rng.getState());
    expect(resumed.world.stats.chestsFound).toBe(original.world.stats.chestsFound);

    dropChest(original.world, -300, 0, "boss");
    dropChest(resumed.world, -300, 0, "boss");
    openChest(original.world, 5);
    openChest(resumed.world, 5);
    const last = <T>(list: T[]): T => list[list.length - 1];
    expect(last(resumed.world.chests.founds)).toEqual(last(original.world.chests.founds));
    expect(last(resumed.world.chests.openings).rewards.map((reward) => reward.id)).toEqual(
      last(original.world.chests.openings).rewards.map((reward) => reward.id),
    );
    expect(resumed.world.chests.rng.getState()).toBe(original.world.chests.rng.getState());
  });

  it("сохраняет заряды карточек, изгнанное и поток: следующие карточки такие же", () => {
    const patch = { cardTools: { reroll: 3, skip: 1, banish: 2 } };
    const original = newRun(77, patch);
    while (!isAwaitingChoice(original.world)) {
      original.director.update(original.world, TICK_SEC);
      stepWorld(original.world, DIRECTIONS[0]);
    }
    expect(applyCardTool(original.world, REROLL_COMMAND)).not.toBeNull();
    expect(applyCardTool(original.world, `${BANISH_PREFIX}${original.world.progression.offers[0].id}`)).not.toBeNull();
    const saved = roundTrip(original);

    const resumed = newRun(77, patch);
    restoreWorld(resumed.world, resumed.director, saved);
    const { tools, toolsTotal, banished } = original.world.progression;
    expect(resumed.world.progression.tools).toEqual(tools);
    expect(resumed.world.progression.toolsTotal).toEqual(toolsTotal);
    expect(resumed.world.progression.banished).toEqual(banished);
    expect(banished).toHaveLength(1);
    expect(resumed.world.cardRng.getState()).toBe(original.world.cardRng.getState());
    expect(resumed.world.progression.offers).toEqual(original.world.progression.offers);

    applyCardTool(original.world, REROLL_COMMAND);
    applyCardTool(resumed.world, REROLL_COMMAND);
    expect(resumed.world.progression.offers.map((offer) => offer.id)).toEqual(original.world.progression.offers.map((offer) => offer.id));
    expect(resumed.world.cardRng.getState()).toBe(original.world.cardRng.getState());
  });

  it("битые заряды и изгнанное в снимке — SnapshotError, а не мир с NaN", () => {
    const saved = roundTrip(newRun(1, { cardTools: { reroll: 1, skip: 0, banish: 0 } })) as { progression: Record<string, unknown> };
    for (const broken of [
      { tools: null },
      { tools: { reroll: "много", skip: 0, banish: 0 } },
      { toolsTotal: [] },
      { banished: "weapon:spark" },
      { banished: [1] },
    ]) {
      const input = { ...saved, progression: { ...saved.progression, ...broken } };
      expect(() => restoreWorld(newRun(1).world, newRun(1).director, input), JSON.stringify(broken)).toThrow(SnapshotError);
    }
    expect(() => restoreWorld(newRun(1).world, newRun(1).director, { ...saved, cardRng: undefined })).toThrow(SnapshotError);
  });

  it("не тащит в снимок события для сцены: после восстановления они пусты", () => {
    const original = newRun(32);
    dropChest(original.world, 300, 0, "elite");
    const saved = roundTrip(original) as { chest?: Record<string, unknown> };
    expect(Object.keys(saved.chest ?? {}).sort()).toEqual(["dropped", "opened", "rng"]);

    const resumed = newRun(32);
    restoreWorld(resumed.world, resumed.director, saved);
    expect(resumed.world.chests.founds).toEqual([]);
    expect(resumed.world.chests.openings).toEqual([]);
  });

  it("не меняет мир, с которого снят", () => {
    const run = newRun(9);
    advance(run, 20 * 60);
    const before = checksumWorld(run.world);
    const snapshot = captureWorld(run.world, run.director);

    advance(run, 60);
    expect(snapshot.progression.level).toBeLessThanOrEqual(run.world.progression.level);
    expect(before).not.toBe(checksumWorld(run.world));
  });

  it("отказывается читать снимок другой версии формата", () => {
    const run = newRun(1);
    const saved = roundTrip(run) as Record<string, unknown>;
    expect(() => restoreWorld(newRun(1).world, newRun(1).director, { ...saved, version: 999 })).toThrow(
      SnapshotError,
    );
  });

  it("отказывается читать снимок прежней версии: в нём нет счётчиков итога", () => {
    const run = newRun(1);
    const saved = roundTrip(run) as Record<string, unknown>;
    expect(saved.version).toBe(WORLD_SNAPSHOT_VERSION);
    expect(() =>
      restoreWorld(newRun(1).world, newRun(1).director, { ...saved, version: WORLD_SNAPSHOT_VERSION - 1 }),
    ).toThrow(SnapshotError);
  });

  it("снимок без полей счётчиков в stats — SnapshotError, а не нули", () => {
    const run = newRun(1);
    const saved = structuredClone(roundTrip(run)) as { stats: { scalars: Record<string, number> } };
    delete saved.stats.scalars.bossKills;
    expect(() => restoreWorld(newRun(1).world, newRun(1).director, saved)).toThrow(SnapshotError);
  });

  it("восстанавливает счётчики боссов, элит и кристаллов", () => {
    const run = newRun(1);
    run.world.stats.bossKills = 2;
    run.world.stats.eliteKills = 5;
    run.world.stats.crystalsCollected = 77;
    const saved = roundTrip(run);

    const resumed = newRun(1);
    restoreWorld(resumed.world, resumed.director, saved);

    expect(resumed.world.stats.bossKills).toBe(2);
    expect(resumed.world.stats.eliteKills).toBe(5);
    expect(resumed.world.stats.crystalsCollected).toBe(77);
  });

  it("отказывается читать испорченный снимок, а не рождает мир с NaN", () => {
    const run = newRun(1);
    advance(run, 5 * 60);
    const saved = roundTrip(run) as { player: Record<string, unknown>; enemies: { arrays: Record<string, { data: string }> } };

    const brokenPlayer = { ...saved, player: { ...saved.player, x: null } };
    expect(() => restoreWorld(newRun(1).world, newRun(1).director, brokenPlayer)).toThrow(SnapshotError);

    const brokenArray = structuredClone(saved);
    brokenArray.enemies.arrays.x.data = "не base64 вовсе";
    expect(() => restoreWorld(newRun(1).world, newRun(1).director, brokenArray)).toThrow(SnapshotError);

    expect(() => restoreWorld(newRun(1).world, newRun(1).director, "мусор")).toThrow(SnapshotError);
  });
});

describe("счётчики в сводке снимка (tasks/T-0163)", () => {
  it("тело снимка читается теми же счётчиками, что у мира", () => {
    const run = newRun(5);
    advance(run, 20 * 60);
    expect(run.world.stats.enemiesKilled).toBeGreaterThan(0);

    expect(readSnapshotCounters(roundTrip(run))).toEqual({
      enemiesKilled: run.world.stats.enemiesKilled,
      xpCollected: run.world.stats.xpCollected,
    });
  });

  it("captureSnapshot кладёт в summary убийства и опыт мира", () => {
    // Сцена Phaser в тесте не поднимается: сводку собирает одно выражение в
    // `MainScene.captureSnapshot`, и проверяется оно по исходнику.
    const source = readFileSync(new URL("../src/game/MainScene.ts", import.meta.url), "utf8");
    const summary = /summary:\s*\{[^}]*\}/.exec(source)?.[0] ?? "";

    expect(summary).toContain("enemiesKilled: world.stats.enemiesKilled");
    expect(summary).toContain("xpCollected: world.stats.xpCollected");
  });

  it("поле необязательное, поэтому формат снимка прежний", () => {
    expect(RUN_SNAPSHOT_FORMAT).toBe(7);
  });
});

describe("снимок посреди кольца стражей", () => {
  /** Снимок после `before` секунд, восстановленный в свежий мир и прокрученный ещё на 10 секунд, против непрерывного мира. */
  function resumeAfter(before: number): void {
    const original = createCordonRun({ seed: 21 });
    advanceRun(original, before);
    const saved = JSON.parse(JSON.stringify(captureWorld(original.world, original.director))) as unknown;

    const resumed = createCordonRun({ seed: 21 });
    restoreWorld(resumed.world, resumed.director, saved);
    expect(checksumWorld(resumed.world)).toBe(checksumWorld(original.world));
    expect(resumed.world.cordon).toEqual(original.world.cordon);

    advanceRun(original, 10);
    advanceRun(resumed, 10);

    expect(checksumWorld(resumed.world)).toBe(checksumWorld(original.world));
    expect(resumed.world.cordon).toEqual(original.world.cordon);
    expect(resumed.world.cordon.active).toBe(true);
  }

  it("посреди прихода стражей: продолженный мир идёт ровно так же", { timeout: 30_000 }, () => {
    resumeAfter(4);
  });

  it("посреди удержания: радиус, оставшееся время и центр совпадают", { timeout: 30_000 }, () => {
    resumeAfter(14);
  });

  it("снимок прежнего формата без поля cordon читается: кольца нет", () => {
    const original = createCordonRun({ seed: 3, timeline: [{ fromSec: 0, spawns: [], events: [] }] });
    advanceRun(original, 2);
    const saved = JSON.parse(JSON.stringify(captureWorld(original.world, original.director))) as Record<string, unknown>;
    delete saved.cordon;

    const resumed = createCordonRun({ seed: 3, timeline: [{ fromSec: 0, spawns: [], events: [] }] });
    expect(() => restoreWorld(resumed.world, resumed.director, saved)).not.toThrow();
    expect(resumed.world.cordon.active).toBe(false);
  });

  it("кольцо, закончившееся после восстановления, несёт верные index, guards и lifeSec", () => {
    const original = createCordonRun({ seed: 21 });
    advanceRun(original, 6);
    const saved = JSON.parse(JSON.stringify(captureWorld(original.world, original.director))) as unknown;
    const resumed = createCordonRun({ seed: 21 });
    restoreWorld(resumed.world, resumed.director, saved);

    expect(resumed.world.cordon.guards).toBe(40);
    expect(takeCordonEvents(resumed.world, 0).ended).toEqual([]);

    for (const run of [original, resumed]) {
      advanceRun(run, 4);
      for (const index of aliveGuards(run.world)) damageEnemy(run.world, index, 1e9, 0);
      advanceRun(run, 1);
    }
    const [ended, ...rest] = takeCordonEvents(resumed.world, 0).ended;
    expect(rest).toEqual([]);
    expect(ended).toMatchObject({ index: 0, outcome: "broken", guards: 40, killed: 40 });
    expect(ended).toEqual(takeCordonEvents(original.world, 0).ended[0]);
  });

  it("журнал закончившихся колец в снимок не входит и после восстановления пуст", () => {
    const original = createCordonRun({ seed: 21 });
    advanceRun(original, 3);
    for (const index of aliveGuards(original.world)) damageEnemy(original.world, index, 1e9, 0);
    advanceRun(original, 1);
    expect(takeCordonEvents(original.world, 0).ended).toHaveLength(1);

    const saved = JSON.parse(JSON.stringify(captureWorld(original.world, original.director))) as { cordon: Record<string, unknown> };
    expect(saved.cordon).not.toHaveProperty("ended");
    const resumed = createCordonRun({ seed: 21 });
    restoreWorld(resumed.world, resumed.director, saved);
    expect(takeCordonEvents(resumed.world, 0).ended).toEqual([]);
    expect(resumed.world.cordon.ringsStarted).toBe(original.world.cordon.ringsStarted);
  });

  it("снимок без новых полей кольца читается: счётчики равны нулю", () => {
    const original = createCordonRun({ seed: 21 });
    advanceRun(original, 4);
    const saved = JSON.parse(JSON.stringify(captureWorld(original.world, original.director))) as { cordon: Record<string, unknown> };
    delete saved.cordon.ringsStarted;
    delete saved.cordon.startedAtSec;
    delete saved.cordon.guards;

    const resumed = createCordonRun({ seed: 21 });
    expect(() => restoreWorld(resumed.world, resumed.director, saved)).not.toThrow();
    expect(resumed.world.cordon).toMatchObject({ ringsStarted: 0, startedAtSec: 0, guards: 0, active: true });
  });

  it("битое поле cordon — ошибка снимка, а не NaN в мире", () => {
    const run = createCordonRun({ seed: 3 });
    advanceRun(run, 1);
    const saved = JSON.parse(JSON.stringify(captureWorld(run.world, run.director))) as Record<string, unknown>;
    saved.cordon = { active: true, centerX: "x" };
    expect(() => restoreWorld(createCordonRun({ seed: 3 }).world, createCordonRun({ seed: 3 }).director, saved)).toThrow(SnapshotError);
  });
});

