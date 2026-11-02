import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { RUBEZH } from "../src/content/rubezh";
import { ENDLESS_CURVE, TIMELINE } from "../src/content/waves";
import { buildRunResult } from "../src/game/run/run-result";
import { damageEnemy } from "../src/game/sim/combat";
import { createRng, deriveSeed, STREAM_SALT } from "../src/game/sim/rng";
import { planSegment, segmentStartSec } from "../src/game/sim/timeline";
import { spawnEnemy, TICK_HZ } from "../src/game/sim/world";
import { aliveRubezhGuards, createRubezhWorld, guardDef, jumpToSec, stepTicks, typeIndexOf } from "./helpers/rubezh-run";

// Рубеж (T-0120, Р102/Р105, docs/39-retention-mechanics.md Б6): на отметке
// приходит страж, его смерть — победа в итоге забега, а забег идёт дальше.

const MARK = RUBEZH.atSec;

/** Пустой мир на секунде `sec`, один шаг сделан. */
function stepAt(seed: number, sec: number) {
  const world = createRubezhWorld(seed);
  jumpToSec(world, sec);
  stepTicks(world, 1);
  return world;
}

function resultOf(world: ReturnType<typeof createRubezhWorld>) {
  return buildRunResult(world, {
    runId: "r",
    seed: 1,
    outcome: "died",
    startingWeaponId: "none",
    contentHash: "test",
  });
}

describe("приход стража", () => {
  it("на 599 с стража нет, фаза «ждёт»", () => {
    const world = stepAt(1, MARK - 1);
    expect(aliveRubezhGuards(world)).toHaveLength(0);
    expect(world.rubezh.phase).toBe("pending");
    expect(world.stats.enemiesSpawned).toBe(0);
  });

  it("за тик до отметки стража ещё нет, на отметке — ровно один", () => {
    const world = createRubezhWorld(1);
    jumpToSec(world, MARK - 1 / TICK_HZ);
    stepTicks(world, 1);
    expect(aliveRubezhGuards(world)).toHaveLength(0);

    stepTicks(world, 1);
    expect(aliveRubezhGuards(world)).toHaveLength(1);
    expect(world.rubezh.phase).toBe("guard");
    expect(world.stats.elapsedSec).toBeGreaterThanOrEqual(MARK);
  });

  it("повторные шаги стражей не добавляют", () => {
    const world = stepAt(1, MARK);
    stepTicks(world, 600);
    expect(aliveRubezhGuards(world)).toHaveLength(1);
    expect(world.stats.enemiesSpawned).toBe(1);
  });

  it("потолок живых заполнен — страж всё равно приходит", () => {
    const world = createRubezhWorld(1);
    world.difficulty.maxAlive = 2;
    const rat = typeIndexOf(world, "swarm_rat");
    for (let i = 0; i < 5; i++) spawnEnemy(world, rat, 4000 + i * 10, 4000);
    expect(world.enemies.aliveCount).toBeGreaterThan(world.difficulty.maxAlive);

    jumpToSec(world, MARK);
    stepTicks(world, 1);
    expect(aliveRubezhGuards(world)).toHaveLength(1);
  });

  it("приходит снаружи видимой области, на кольце спавна", () => {
    const world = stepAt(3, MARK);
    const [guard] = aliveRubezhGuards(world);
    const dx = world.enemies.x[guard] - world.player.x;
    const dy = world.enemies.y[guard] - world.player.y;
    expect(Math.sqrt(dx * dx + dy * dy)).toBeGreaterThanOrEqual(world.config.view.spawnRadius * 0.95);
  });

  it("здоровье с полосой босса: размер и ранг из контента", () => {
    const world = stepAt(1, MARK);
    const [guard] = aliveRubezhGuards(world);
    const type = world.enemyTypes[world.enemies.type[guard]];
    expect(type.rank).toBe("boss");
    expect(world.enemies.maxHp[guard]).toBeGreaterThanOrEqual(guardDef().hp);
    // size 2: радиус стража больше радиуса героя, иначе он незаметен
    expect(type.radius).toBeGreaterThan(world.config.player.radius);
  });

  it("мир без правил рубежа или без стража в контенте — фаза «пропущен», стража нет", () => {
    const without = createRubezhWorld(1, { rubezh: undefined });
    jumpToSec(without, MARK);
    stepTicks(without, 5);
    expect(without.rubezh.phase).toBe("skipped");
    expect(aliveRubezhGuards(without)).toHaveLength(0);

    const noGuard = createRubezhWorld(1, { enemies: ENEMIES.filter((enemy) => enemy.id !== RUBEZH.guard) });
    jumpToSec(noGuard, MARK);
    stepTicks(noGuard, 5);
    expect(noGuard.rubezh.phase).toBe("skipped");
  });
});

describe("поток случайности рубежа", () => {
  it("свой поток от seed забега, не общий", () => {
    const world = createRubezhWorld(99);
    expect(world.rubezh.rng.getState()).toBe(createRng(deriveSeed(99, STREAM_SALT.rubezh)).getState());
    expect(world.rubezh.rng.getState()).not.toBe(world.rng.getState());
  });

  it("приход стража не сдвигает world.rng", () => {
    const with_ = createRubezhWorld(5);
    const without = createRubezhWorld(5, { rubezh: undefined });
    jumpToSec(with_, MARK);
    jumpToSec(without, MARK);
    stepTicks(with_, 1);
    stepTicks(without, 1);

    expect(aliveRubezhGuards(with_)).toHaveLength(1);
    expect(with_.rng.getState()).toBe(without.rng.getState());
    expect(with_.rng.nextFloat()).toBe(without.rng.nextFloat());
  });

  it("до отметки поток рубежа не расходуется", () => {
    const world = createRubezhWorld(5);
    const before = world.rubezh.rng.getState();
    jumpToSec(world, 100);
    stepTicks(world, 600);
    expect(world.rubezh.rng.getState()).toBe(before);
  });

  it("место стража зависит от seed и повторяется на том же", () => {
    const place = (seed: number): [number, number] => {
      const world = stepAt(seed, MARK);
      const [guard] = aliveRubezhGuards(world);
      return [world.enemies.x[guard], world.enemies.y[guard]];
    };
    expect(place(11)).toEqual(place(11));
    expect(place(11)).not.toEqual(place(12));
  });
});

describe("победа: смерть стража", () => {
  it("убитый страж ставит фазу «взят» и секунду победы, забег идёт дальше", () => {
    const world = stepAt(1, MARK);
    stepTicks(world, 120);
    const [guard] = aliveRubezhGuards(world);
    const diedAt = world.stats.elapsedSec;
    damageEnemy(world, guard, 1e9, 0);

    expect(world.rubezh.phase).toBe("cleared");
    expect(world.rubezh.clearedSec).toBe(diedAt);
    expect(world.player.alive).toBe(true);

    stepTicks(world, 600);
    expect(world.player.alive).toBe(true);
    expect(world.stats.elapsedSec).toBeGreaterThan(diedAt);
  });

  it("второй страж не приходит", () => {
    const world = stepAt(1, MARK);
    damageEnemy(world, aliveRubezhGuards(world)[0], 1e9, 0);
    stepTicks(world, 1200);
    expect(aliveRubezhGuards(world)).toHaveLength(0);
    expect(world.stats.enemiesSpawned).toBe(1);
    expect(world.rubezh.phase).toBe("cleared");
  });

  it("смерть другого босса фазу не меняет", () => {
    const world = stepAt(1, MARK);
    const boss = spawnEnemy(world, typeIndexOf(world, "boss_ram"), 4000, 4000);
    damageEnemy(world, boss, 1e9, 0);
    expect(world.rubezh.phase).toBe("guard");
    expect(world.rubezh.clearedSec).toBeNull();
  });

  it("смерть игрока после победы оставляет секунду победы в итоге", () => {
    const world = stepAt(1, MARK);
    stepTicks(world, 60);
    damageEnemy(world, aliveRubezhGuards(world)[0], 1e9, 0);
    const clearedSec = world.rubezh.clearedSec;
    world.player.alive = false;
    stepTicks(world, 600);

    expect(resultOf(world).rubezh).toEqual({ reached: true, clearedSec, guardHpPercent: null });
  });
});

describe("боссы таймлайна при страже", () => {
  /** Боссовые события плана отрезка с номером. */
  function bossEvents(world: ReturnType<typeof createRubezhWorld>, index: number): string[] {
    const plan = planSegment(world, TIMELINE, ENDLESS_CURVE, index);
    return plan.events.map((event) => world.enemyTypes[event.typeIndex]).filter((type) => type.rank === "boss").map((type) => type.id);
  }

  /** Номера отрезков, на которых начинается событие босса при нейтральной подстройке. */
  function bossSegments(): { index: number; startSec: number }[] {
    const world = createRubezhWorld(1);
    const found: { index: number; startSec: number }[] = [];
    for (let index = 0; index < TIMELINE.length + 30; index++) {
      if (bossEvents(world, index).length > 0) found.push({ index, startSec: segmentStartSec(TIMELINE, ENDLESS_CURVE, index) });
    }
    return found;
  }

  it("между 540 и 660 с в таймлайне нет боссов: страж приходит один", () => {
    for (const { startSec } of bossSegments()) {
      expect(startSec <= MARK - 60 || startSec >= MARK + 60, `босс на ${startSec} с`).toBe(true);
    }
  });

  it("событие босса из окна вокруг отметки переносится на первый отрезок после него — один раз", () => {
    const world = createRubezhWorld(1);
    const first = bossSegments().find((segment) => segment.startSec >= MARK);
    // 570 с кривой (Матрёшка каждые пять отрезков) приходит на 690 с
    expect(first?.startSec).toBe(MARK + 90);
    expect(bossEvents(world, first?.index ?? -1)).toEqual(["boss_matryoshka"]);
    const secs = bossSegments().map((segment) => segment.startSec);
    expect(secs.filter((sec) => sec >= MARK - 60 && sec < MARK + 90)).toEqual([]);
    expect(secs.slice(0, 3)).toEqual([MARK + 90, 750, 870]);
  });

  it("мир без стража окна не знает: формула кривой прежняя, Матрёшка на 570 с", () => {
    const world = createRubezhWorld(1, { rubezh: undefined });
    const index = TIMELINE.length + (570 - ENDLESS_CURVE.fromSec) / ENDLESS_CURVE.segmentSec;
    expect(segmentStartSec(TIMELINE, ENDLESS_CURVE, index)).toBe(570);
    expect(bossEvents(world, index)).toEqual(["boss_matryoshka"]);
  });

  it("пока страж жив, события боссов пропущены — не отложены на потом", () => {
    const segments = bossSegments().filter((segment) => segment.startSec >= MARK);
    const [first, second] = segments;
    const alive = stepAt(1, MARK);
    expect(alive.rubezh.phase).toBe("guard");
    expect(bossEvents(alive, first.index)).toEqual([]);
    expect(bossEvents(alive, second.index)).toEqual([]);

    // страж пал: следующий босс по расписанию приходит как обычно, пропущенные не наверстываются
    damageEnemy(alive, aliveRubezhGuards(alive)[0], 1e9, 0);
    expect(bossEvents(alive, second.index)).toEqual(bossEvents(createRubezhWorld(1), second.index));
    expect(bossEvents(alive, second.index)).toEqual(["boss_ram"]);
  });

  it("не мешает остальным событиям отрезка", () => {
    const first = bossSegments().filter((segment) => segment.startSec >= MARK)[0];
    const clean = createRubezhWorld(1);
    const alive = stepAt(1, MARK);
    const kinds = (world: typeof clean) => planSegment(world, TIMELINE, ENDLESS_CURVE, first.index).events.filter((event) => world.enemyTypes[event.typeIndex].rank !== "boss").length;
    expect(kinds(alive)).toBe(kinds(clean));
  });

  it("после смерти стража босс таймлайна приходит по расписанию", () => {
    const first = bossSegments().filter((segment) => segment.startSec >= MARK)[0];
    const world = stepAt(1, MARK);
    damageEnemy(world, aliveRubezhGuards(world)[0], 1e9, 0);
    expect(bossEvents(world, first.index).length).toBeGreaterThan(0);
  });

  it("до прихода стража босс отрезка идёт как обычно", () => {
    const first = bossSegments().find((segment) => segment.startSec >= MARK);
    expect(bossEvents(createRubezhWorld(1), first?.index ?? -1).length).toBeGreaterThan(0);
  });
});

describe("итог забега: rubezh", () => {
  it("умер на 580 с — страж не приходил", () => {
    const world = stepAt(1, 580);
    world.player.alive = false;
    expect(resultOf(world).rubezh).toEqual({ reached: false, clearedSec: null, guardHpPercent: null });
  });

  it("умер на 650 с при живом страже с 40% здоровья", () => {
    const world = stepAt(1, MARK);
    const [guard] = aliveRubezhGuards(world);
    world.enemies.hp[guard] = world.enemies.maxHp[guard] * 0.4;
    jumpToSec(world, 650);
    world.player.alive = false;
    expect(resultOf(world).rubezh).toEqual({ reached: true, clearedSec: null, guardHpPercent: 40 });
  });

  it("почти убитый страж не округляется до нуля: живой — не меньше процента", () => {
    const world = stepAt(1, MARK);
    const [guard] = aliveRubezhGuards(world);
    world.enemies.hp[guard] = world.enemies.maxHp[guard] * 0.001;
    const percent = resultOf(world).rubezh?.guardHpPercent;
    expect(percent).toBe(1);
  });

  it("победил и умер — секунда победы задана, здоровья стража нет", () => {
    const world = stepAt(1, MARK);
    stepTicks(world, 30);
    damageEnemy(world, aliveRubezhGuards(world)[0], 1e9, 0);
    world.player.alive = false;
    const rubezh = resultOf(world).rubezh;
    expect(rubezh?.reached).toBe(true);
    expect(rubezh?.clearedSec).toBe(world.rubezh.clearedSec);
    expect(rubezh?.clearedSec).toBeGreaterThanOrEqual(MARK);
    expect(rubezh?.guardHpPercent).toBeNull();
  });

  it("сдача — тоже итог с рубежом: победа не сбрасывается", () => {
    const world = stepAt(1, MARK);
    damageEnemy(world, aliveRubezhGuards(world)[0], 1e9, 0);
    const result = buildRunResult(world, { runId: "r", seed: 1, outcome: "abandoned", startingWeaponId: "none", contentHash: "test" });
    expect(result.rubezh?.clearedSec).not.toBeNull();
    expect(result.outcome).toBe("abandoned");
  });
});
