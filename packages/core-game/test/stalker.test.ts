import type { EnemyDef, StalkerAppearDef, StalkerDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { DIFFICULTIES } from "../src/content/difficulty";
import { MAPS } from "../src/content/maps";
import { PROLOGUE } from "../src/content/prologue";
import { SECRETS } from "../src/content/secrets";
import { CONTENT_SNAPSHOT } from "../src/content/snapshot";
import { STALKER } from "../src/content/stalker";
import { ENDLESS_CURVE, TIMELINE } from "../src/content/waves";
import { findContentProblems } from "../src/game/content-problems";
import { captureWorld, restoreWorld } from "../src/game/run/snapshot";
import { checksumWorld } from "../src/game/sim/checksum";
import { applyContinue } from "../src/game/sim/continue";
import { startCordon } from "../src/game/sim/cordon";
import { createTimelineDirector } from "../src/game/sim/director";
import { damageEnemy } from "../src/game/sim/combat";
import { SIM_EVENT } from "../src/game/sim/events";
import { createRng, deriveSeed, STREAM_SALT } from "../src/game/sim/rng";
import { settleStalkerDeath, stalkerGapRange, type StalkerPhase } from "../src/game/sim/stalker";
import { findStalkerProblems, stalkerAlive } from "../src/game/sim/stalker-body";
import { IDLE_INPUT, stepWorld } from "../src/game/sim/step";
import { createWorld, DEFAULT_SIM_CONFIG, despawnEnemy, spawnEnemy, TICK_HZ, TICK_SEC, type CreateWorldOptions, type World } from "../src/game/sim/world";

// Появления Карачуна (Р205, tasks/T-0423): с четвёртой минуты в случайный момент и с случайной
// стороны проступает предвестие, через `omenSec` выходит Карачун, преследует и растворяется.
// Директора спавна в мирах нет: враги ставятся руками там, где нужны.

const RAT: EnemyDef = { id: "rat", hp: 10, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };
const KARACHUN: EnemyDef = { id: "karachun", hp: 1, speed: 110, damage: 0, xp: 0, pattern: "stalker" };
/** Босс неподвижен и не бьёт: он нужен как живой враг ранга «босс». */
const BOSS: EnemyDef = { id: "boss", hp: 1_000_000, speed: 0.001, damage: 0, xp: 1, pattern: "swarm", rank: "boss" };
const GUARD: EnemyDef = { id: "guard", hp: 1_000_000, speed: 0.001, damage: 0, xp: 1, threat: 1, pattern: "cordon" };
const BOSS_TYPE = 2;
const GUARD_TYPE = 3;

const APPEAR = STALKER.appear;
const OMEN_TICKS = Math.round(APPEAR.omenSec * TICK_HZ);
const FADE_TICKS = Math.round(APPEAR.fadeSec * TICK_HZ);
const FROM_TICK = APPEAR.fromSec * TICK_HZ;
/** Двадцать минут симуляции на загруженной машине CI идут дольше пяти секунд по умолчанию. */
const LONG_RUN_TIMEOUT_MS = 120_000;

function makeWorld(patch: Partial<CreateWorldOptions> = {}, rules: StalkerDef | null = STALKER, seed = 7): World {
  const world = createWorld({
    seed,
    enemies: [RAT, KARACHUN, BOSS, GUARD],
    ...(rules === null ? {} : { stalker: rules }),
    config: { progressionEnabled: false, player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 1000 } },
    ...patch,
  });
  // Касание Карачуна не должно прерывать долгие прогоны: нужные тесты снимают бессмертие сами.
  world.cheats.godMode = true;
  return world;
}

function step(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepWorld(world, IDLE_INPUT);
}

/** Перескочить на тик: время мира — счётчик, а не часы, и тест не гоняет четыре минуты пустого забега. */
function jumpTo(world: World, tick: number): void {
  world.stats.tick = tick;
  world.stats.elapsedSec = tick * TICK_SEC;
}

/** Мир в начале предвестия: перескок на отметку и один шаг. */
function omenWorld(seed = 7, patch: Partial<CreateWorldOptions> = {}): World {
  const world = makeWorld(patch, STALKER, seed);
  jumpTo(world, world.stalker.nextOmenTick);
  step(world, 1);
  expect(world.stalker.phase).toBe("omen");
  return world;
}

/** Мир в начале погони: Карачун только вышел. */
function chaseWorld(seed = 7, patch: Partial<CreateWorldOptions> = {}): World {
  const world = omenWorld(seed, patch);
  step(world, OMEN_TICKS);
  expect(world.stalker.phase).toBe("chase");
  expect(stalkerAlive(world)).toBe(1);
  return world;
}

function liveEvents(world: World, kind: number): number[] {
  const result: number[] = [];
  const written = world.events.written;
  const length = world.events.kind.length;
  for (let i = Math.max(0, written - length); i < written; i++) {
    if (world.events.kind[i % length] === kind) result.push(i % length);
  }
  return result;
}

function distanceToPlayer(world: World, x: number, y: number): number {
  return Math.sqrt((x - world.player.x) ** 2 + (y - world.player.y) ** 2);
}

function stalkerPoint(world: World): { x: number; y: number } {
  return { x: world.enemies.x[world.stalkerBody.slot], y: world.enemies.y[world.stalkerBody.slot] };
}

function withAppear(patch: Partial<StalkerAppearDef>): StalkerDef {
  return { ...STALKER, appear: { ...APPEAR, ...patch } };
}

describe("расписание появлений", () => {
  it("до fromSec ни предвестия, ни Карачуна, сколько ни идёт забег", () => {
    const world = makeWorld();
    expect(world.stalker.phase).toBe("waiting");
    step(world, FROM_TICK - 1);
    expect(world.stalker.phase).toBe("waiting");
    expect(stalkerAlive(world)).toBe(0);
    expect(liveEvents(world, SIM_EVENT.stalkerOmen)).toHaveLength(0);
    expect(liveEvents(world, SIM_EVENT.stalkerAppear)).toHaveLength(0);
  });

  it("первая отметка — между fromSec и fromSec + firstDelaySec.max", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const tick = makeWorld({}, STALKER, seed).stalker.nextOmenTick;
      expect(tick).toBeGreaterThanOrEqual(FROM_TICK);
      expect(tick).toBeLessThanOrEqual(Math.round((APPEAR.fromSec + APPEAR.firstDelaySec.max) * TICK_HZ));
    }
  });

  it("на отметке — предвестие в точке на appearDistance, через omenSec выходит Карачун в ней же", () => {
    const world = omenWorld();
    const scale = world.config.unitScale;
    const omen = liveEvents(world, SIM_EVENT.stalkerOmen);
    expect(omen).toHaveLength(1);
    const { x, y } = world.stalker;
    expect(distanceToPlayer(world, x, y)).toBeCloseTo(APPEAR.appearDistance * scale, 3);
    expect(world.events.x[omen[0]]).toBeCloseTo(x, 3);
    expect(world.events.y[omen[0]]).toBeCloseTo(y, 3);
    expect(world.events.radius[omen[0]]).toBeCloseTo(APPEAR.omenSec, 3);
    // Пока предвестие горит, Карачуна на поле нет.
    step(world, OMEN_TICKS - 1);
    expect(stalkerAlive(world)).toBe(0);
    expect(world.stalker.phase).toBe("omen");

    step(world, 1);
    expect(world.stalker.phase).toBe("chase");
    expect(stalkerAlive(world)).toBe(1);
    const appear = liveEvents(world, SIM_EVENT.stalkerAppear);
    expect(appear).toHaveLength(1);
    expect(world.events.x[appear[0]]).toBeCloseTo(x, 3);
    expect(world.events.y[appear[0]]).toBeCloseTo(y, 3);
    // За тик он успел сделать шаг к игроку: расстояние — appearDistance с поправкой на шаг.
    const { x: sx, y: sy } = stalkerPoint(world);
    expect(Math.abs(distanceToPlayer(world, sx, sy) - APPEAR.appearDistance * scale)).toBeLessThanOrEqual(1 + KARACHUN.speed * TICK_SEC);
  });

  it("погоня длится chaseSec, потом fadeSec растворения, потом его нет и снова ожидание", () => {
    const world = chaseWorld();
    let chaseTicks = 0;
    while (world.stalker.phase === "chase" && chaseTicks < 5_000) {
      step(world, 1);
      chaseTicks++;
    }
    expect(chaseTicks).toBeGreaterThanOrEqual(APPEAR.chaseSec.min * TICK_HZ);
    expect(chaseTicks).toBeLessThanOrEqual(APPEAR.chaseSec.max * TICK_HZ + 1);
    expect(world.stalker.phase).toBe("fading");
    expect(liveEvents(world, SIM_EVENT.stalkerFade)).toHaveLength(1);
    expect(stalkerAlive(world)).toBe(1);

    step(world, FADE_TICKS - 1);
    expect(stalkerAlive(world)).toBe(1);
    step(world, 1);
    expect(stalkerAlive(world)).toBe(0);
    expect(world.stalker.phase).toBe("waiting");
    expect(world.enemies.aliveCount).toBe(0);
  });

  it("растворяясь, стоит: не идёт, не бьёт и не отталкивается ударом", () => {
    const world = chaseWorld();
    world.cheats.godMode = false;
    world.stalker.chaseTicks = 1;
    step(world, 1);
    expect(world.stalker.phase).toBe("fading");
    const before = stalkerPoint(world);
    // Игрок в ту же точку: касание было бы мгновенным.
    world.player.x = before.x;
    world.player.y = before.y;
    const hp = world.player.hp;
    const hits = world.stalker.hits;
    step(world, 10);
    expect(stalkerPoint(world)).toEqual(before);
    expect(world.player.hp).toBe(hp);
    expect(world.stalker.hits).toBe(hits);
    damageEnemy(world, world.stalkerBody.slot, 50, 0);
    expect(stalkerPoint(world)).toEqual(before);
    expect(world.stalker.pushes).toBe(0);
  });

  it("на 1000 seed первый выход приходит со всех четырёх сторон", () => {
    const quarters = new Set<string>();
    for (let seed = 1; seed <= 1000; seed++) {
      const world = omenWorld(seed);
      const dx = world.stalker.x - world.player.x;
      const dy = world.stalker.y - world.player.y;
      quarters.add(`${dx >= 0 ? "+" : "-"}${dy >= 0 ? "+" : "-"}`);
    }
    expect([...quarters].sort()).toEqual(["++", "+-", "-+", "--"]);
}, LONG_RUN_TIMEOUT_MS);

  it("пауза к поздним минутам короче: средняя на 5-й минуте больше, чем на 15-й", () => {
    const meanGap = (sec: number): number => {
      let total = 0;
      for (let seed = 1; seed <= 300; seed++) {
        const world = makeWorld({}, STALKER, seed);
        jumpTo(world, sec * TICK_HZ);
        world.stalker.phase = "fading";
        world.stalker.phaseTicks = 1;
        step(world, 1);
        expect(world.stalker.phase).toBe("waiting");
        total += world.stalker.nextOmenTick - world.stats.tick + 1;
      }
      return total / 300 / TICK_HZ;
    };
    const early = meanGap(300);
    const late = meanGap(900);
    expect(early).toBeGreaterThan(late);
    // 15-я минута — это lateAtSec: пауза уже в позднем коридоре.
    expect(late).toBeGreaterThanOrEqual(APPEAR.lateGapSec.min);
    expect(late).toBeLessThanOrEqual(APPEAR.lateGapSec.max);
}, LONG_RUN_TIMEOUT_MS);

  it("коридор паузы идёт линейно от gapSec на fromSec до lateGapSec на lateAtSec и дальше не меняется", () => {
    expect(stalkerGapRange(APPEAR, APPEAR.fromSec)).toEqual(APPEAR.gapSec);
    expect(stalkerGapRange(APPEAR, 0)).toEqual(APPEAR.gapSec);
    expect(stalkerGapRange(APPEAR, APPEAR.lateAtSec)).toEqual(APPEAR.lateGapSec);
    expect(stalkerGapRange(APPEAR, APPEAR.lateAtSec * 3)).toEqual(APPEAR.lateGapSec);
    const middle = stalkerGapRange(APPEAR, (APPEAR.fromSec + APPEAR.lateAtSec) / 2);
    expect(middle.min).toBeCloseTo((APPEAR.gapSec.min + APPEAR.lateGapSec.min) / 2, 6);
    expect(middle.max).toBeCloseTo((APPEAR.gapSec.max + APPEAR.lateGapSec.max) / 2, 6);
  });

  it("за 20 минут забега Карачун на поле не больше одного, а приходит неоднократно", () => {
    const world = makeWorld();
    let appearances = 0;
    let alive = 0;
    for (let tick = 0; tick < 20 * 60 * TICK_HZ; tick++) {
      stepWorld(world, IDLE_INPUT);
      expect(world.enemies.aliveCount).toBeLessThanOrEqual(1);
      const now = stalkerAlive(world);
      if (now === 1 && alive === 0) appearances++;
      alive = now;
    }
    expect(appearances).toBeGreaterThanOrEqual(5);
    expect(world.stalker.index).toBeGreaterThanOrEqual(appearances - 1);
  }, LONG_RUN_TIMEOUT_MS);
});

describe("оттолкнули далеко", () => {
  it("Карачун дальше farDistance исчезает, предвестие на appearDistance по тому же лучу, отсчёт погони не сбрасывается", () => {
    const world = chaseWorld();
    const scale = world.config.unitScale;
    const slot = world.stalkerBody.slot;
    world.stalker.chaseTicks = 600;
    // По лучу под углом: «тот же луч» — это направление, а не ось.
    const dirX = 0.6;
    const dirY = 0.8;
    const far = (APPEAR.farDistance + 10) * scale;
    world.enemies.x[slot] = world.player.x + dirX * far;
    world.enemies.y[slot] = world.player.y + dirY * far;

    step(world, 1);
    expect(stalkerAlive(world)).toBe(0);
    expect(world.stalker.phase).toBe("omen");
    expect(world.stalker.relocations).toBe(1);
    expect(world.stalker.chaseTicks).toBeLessThanOrEqual(600);
    expect(world.stalker.chaseTicks).toBeGreaterThanOrEqual(598);
    const near = APPEAR.appearDistance * scale;
    expect(world.stalker.x - world.player.x).toBeCloseTo(dirX * near, 3);
    expect(world.stalker.y - world.player.y).toBeCloseTo(dirY * near, 3);
    expect(liveEvents(world, SIM_EVENT.stalkerOmen).length).toBeGreaterThanOrEqual(2);
    // Бросков нет: поток случайности стоит на месте.
    const rngState = world.stalker.rng.getState();
    step(world, OMEN_TICKS);
    expect(world.stalker.rng.getState()).toBe(rngState);
    expect(world.stalker.phase).toBe("chase");
    expect(stalkerAlive(world)).toBe(1);
    // Повторное предвестие шло из времени погони.
    expect(world.stalker.chaseTicks).toBeLessThanOrEqual(600 - OMEN_TICKS);
  });

  it("повторное предвестие, у которого погоня дошла до нуля, кончается без выхода", () => {
    const world = chaseWorld();
    const slot = world.stalkerBody.slot;
    world.stalker.chaseTicks = 10;
    world.enemies.x[slot] = world.player.x + (APPEAR.farDistance + 10) * world.config.unitScale;
    world.enemies.y[slot] = world.player.y;
    step(world, 1);
    expect(world.stalker.phase).toBe("omen");
    step(world, 20);
    expect(world.stalker.phase).toBe("waiting");
    expect(stalkerAlive(world)).toBe(0);
    expect(world.stalker.ended).toHaveLength(1);
    expect(world.stalker.ended[0]).toMatchObject({ index: 0, outcome: "faded", relocations: 1 });
    expect(liveEvents(world, SIM_EVENT.stalkerAppear)).toHaveLength(1);
  });
});

describe("когда он не приходит", () => {
  it("живой босс в отметку — предвестия нет, пока босс жив; убит — предвестие на следующем тике", () => {
    const world = makeWorld();
    const boss = spawnEnemy(world, BOSS_TYPE, 400, 0, world.rng, true);
    expect(boss).toBeGreaterThanOrEqual(0);
    jumpTo(world, world.stalker.nextOmenTick);
    step(world, 200);
    expect(world.stalker.phase).toBe("waiting");
    expect(liveEvents(world, SIM_EVENT.stalkerOmen)).toHaveLength(0);

    despawnEnemy(world, boss);
    step(world, 1);
    expect(world.stalker.phase).toBe("omen");
  });

  it("поток не зависит от блокировки: те же броски, сдвинуты только моменты", () => {
    const free = omenWorld(11);
    const blocked = makeWorld({}, STALKER, 11);
    const boss = spawnEnemy(blocked, BOSS_TYPE, 400, 0, blocked.rng, true);
    jumpTo(blocked, blocked.stalker.nextOmenTick);
    step(blocked, 300);
    expect(blocked.stalker.phase).toBe("waiting");
    despawnEnemy(blocked, boss);
    step(blocked, 1);
    expect(blocked.stalker.phase).toBe("omen");
    expect(blocked.stalker.x).toBeCloseTo(free.stalker.x, 6);
    expect(blocked.stalker.y).toBeCloseTo(free.stalker.y, 6);
    expect(blocked.stalker.chaseTicks).toBe(free.stalker.chaseTicks);
    expect(blocked.stalker.rng.getState()).toBe(free.stalker.rng.getState());
  });

  it("босс, вышедший во время погони, её не обрывает", () => {
    const world = chaseWorld();
    spawnEnemy(world, BOSS_TYPE, 400, 0, world.rng, true);
    step(world, 60);
    expect(world.stalker.phase).toBe("chase");
    expect(stalkerAlive(world)).toBe(1);
  });

  it("строй стражей в отметку — предвестия нет, пока строй стоит", () => {
    const world = makeWorld();
    jumpTo(world, world.stalker.nextOmenTick);
    startCordon(world, GUARD_TYPE, 4, { radius: 200, minRadius: 80, shrinkPerSec: 6, lifeSec: 12 });
    expect(world.cordon.active).toBe(true);
    step(world, 120);
    expect(world.cordon.active).toBe(true);
    expect(world.stalker.phase).toBe("waiting");
    expect(liveEvents(world, SIM_EVENT.stalkerOmen)).toHaveLength(0);
  });

  it("строй встал во время погони — Карачуна нет на этом же тике, исход cut", () => {
    const world = chaseWorld();
    startCordon(world, GUARD_TYPE, 4, { radius: 200, minRadius: 80, shrinkPerSec: 6, lifeSec: 12 });
    step(world, 1);
    expect(world.cordon.active).toBe(true);
    expect(stalkerAlive(world)).toBe(0);
    expect(world.stalker.phase).toBe("waiting");
    expect(world.stalker.ended).toHaveLength(1);
    expect(world.stalker.ended[0]).toMatchObject({ index: 0, outcome: "cut" });
    expect(world.stalker.nextOmenTick).toBeGreaterThan(world.stats.tick);
  });

  it("строй встал во время предвестия — предвестие снято, исход cut и выхода нет", () => {
    const world = omenWorld();
    startCordon(world, GUARD_TYPE, 4, { radius: 200, minRadius: 80, shrinkPerSec: 6, lifeSec: 12 });
    step(world, OMEN_TICKS + 5);
    expect(world.stalker.phase).toBe("waiting");
    expect(stalkerAlive(world)).toBe(0);
    expect(world.stalker.ended[0]).toMatchObject({ outcome: "cut", lifeSec: 0 });
    expect(liveEvents(world, SIM_EVENT.stalkerAppear)).toHaveLength(0);
  });

  it("открытый разлом не даёт начать появление", () => {
    const world = makeWorld({ secrets: SECRETS });
    const site = world.secrets.sites[0];
    expect(site).toBeDefined();
    site.kind = "rift";
    site.opened = true;
    site.used = false;
    jumpTo(world, world.stalker.nextOmenTick);
    step(world, 120);
    expect(world.stalker.phase).toBe("waiting");

    // Закрытый разлом не мешает.
    site.used = true;
    step(world, 1);
    expect(world.stalker.phase).toBe("omen");
  });

  it("мёртвому игроку предвестие не ставится", () => {
    const world = makeWorld();
    world.player.alive = false;
    jumpTo(world, world.stalker.nextOmenTick);
    step(world, 5);
    expect(world.stalker.phase).toBe("waiting");
  });
});

describe("новичок", () => {
  const easy = DIFFICULTIES.find((level) => level.id === "easy");
  const level = (accountLevel: number): Partial<CreateWorldOptions> => ({ loadout: { modifiers: {}, boosts: [], accountLevel } });

  it("в прологе, на «Лёгкой» и ниже minAccountLevel Карачуна нет", () => {
    expect(easy).toBeDefined();
    expect(makeWorld({ prologue: PROLOGUE }).stalker.phase).toBe("off");
    expect(makeWorld(easy === undefined ? {} : { difficulty: easy }).stalker.phase).toBe("off");
    expect(makeWorld(level(APPEAR.minAccountLevel - 1)).stalker.phase).toBe("off");
  });

  it("с minAccountLevel и без уровня — ждёт", () => {
    expect(makeWorld(level(APPEAR.minAccountLevel)).stalker.phase).toBe("waiting");
    expect(makeWorld().stalker.phase).toBe("waiting");
  });

  it("без правил в мире директора нет", () => {
    expect(makeWorld({}, null).stalker.phase).toBe("off");
  });

  it("выключенный директор не выпускает никого", () => {
    const world = makeWorld(level(1));
    jumpTo(world, FROM_TICK + 600 * TICK_HZ);
    step(world, 100);
    expect(world.stalker.phase).toBe("off");
    expect(stalkerAlive(world)).toBe(0);
  });
});

describe("свой поток случайности", () => {
  it("за 20 минут забега основной генератор не сдвинулся ни разу, а поток Карачуна работал", () => {
    const withRules = makeWorld();
    const without = makeWorld({}, null);
    const initial = without.rng.getState();
    const streamAtStart = withRules.stalker.rng.getState();
    for (let tick = 0; tick < 20 * 60 * TICK_HZ; tick++) {
      stepWorld(withRules, IDLE_INPUT);
      stepWorld(without, IDLE_INPUT);
    }
    expect(withRules.rng.getState()).toBe(without.rng.getState());
    expect(withRules.rng.getState()).toBe(initial);
    expect(withRules.stalker.rng.getState()).not.toBe(streamAtStart);
  }, LONG_RUN_TIMEOUT_MS);

  it("поток растёт из соли STREAM_SALT.stalker", () => {
    expect(STREAM_SALT.stalker).toBe(0x5354414c);
    expect(new Set(Object.values(STREAM_SALT)).size).toBe(Object.values(STREAM_SALT).length);
    const world = makeWorld({}, STALKER, 5);
    const expected = createRng(deriveSeed(5, STREAM_SALT.stalker));
    expected.nextRange(0, 1);
    expect(world.stalker.rng.getState()).toBe(expected.getState());
  });
});

describe("журнал появлений", () => {
  it("растворился: faded, счётчики и время жизни", () => {
    const world = chaseWorld();
    let guard = 0;
    while (world.stalker.ended.length === 0 && guard++ < 5_000) step(world, 1);
    expect(world.stalker.ended).toHaveLength(1);
    const end = world.stalker.ended[0];
    expect(end.index).toBe(0);
    expect(end.outcome).toBe("faded");
    expect(end.hits).toBeGreaterThanOrEqual(1);
    expect(end.pushes).toBe(0);
    expect(end.relocations).toBe(0);
    expect(end.lifeSec).toBeGreaterThanOrEqual(APPEAR.chaseSec.min + APPEAR.fadeSec - 0.1);
    expect(end.lifeSec).toBeLessThanOrEqual(APPEAR.chaseSec.max + APPEAR.fadeSec + 0.1);
    // Запись сделана внутри шага, до приращения счётчика тиков.
    expect(end.elapsedSec).toBeCloseTo((world.stats.tick - 1) * TICK_SEC, 6);
    expect(world.stalker.index).toBe(1);
  });

  it("срезан строем: cut с толчками", () => {
    const world = chaseWorld();
    const slot = world.stalkerBody.slot;
    damageEnemy(world, slot, 5, 0);
    damageEnemy(world, slot, 5, 0);
    step(world, 30);
    startCordon(world, GUARD_TYPE, 4, { radius: 200, minRadius: 80, shrinkPerSec: 6, lifeSec: 12 });
    step(world, 1);
    const end = world.stalker.ended[0];
    expect(end.outcome).toBe("cut");
    expect(end.pushes).toBe(2);
    expect(end.relocations).toBe(0);
    expect(end.lifeSec).toBeGreaterThan(0.5);
  });

  it("игрок погиб: died, пауза от этого тика, повторная запись не появляется", () => {
    const world = chaseWorld();
    world.cheats.godMode = false;
    world.player.hp = 1;
    let guard = 0;
    while (world.player.alive && guard++ < 1_000) step(world, 1);
    expect(world.player.alive).toBe(false);
    step(world, 1);
    expect(world.stalker.ended).toHaveLength(1);
    expect(world.stalker.ended[0]).toMatchObject({ index: 0, outcome: "died", hits: 1 });
    expect(world.stalker.phase).toBe("waiting");
    expect(world.stalker.nextOmenTick).toBeGreaterThan(world.stats.tick);
    step(world, 5);
    expect(world.stalker.ended).toHaveLength(1);
  });

  it("смерть, не дождавшаяся следующего тика, закрывается явным вызовом сцены", () => {
    const world = chaseWorld();
    world.player.alive = false;
    expect(settleStalkerDeath(world)).toBe(true);
    expect(world.stalker.ended[0]).toMatchObject({ outcome: "died" });
    expect(settleStalkerDeath(world)).toBe(false);
  });
});

describe("второй шанс", () => {
  it("смерть во время погони — died; после продолжения Карачуна нет, а предвестие не раньше паузы", () => {
    const world = chaseWorld();
    world.cheats.godMode = false;
    world.player.hp = 1;
    let guard = 0;
    while (world.player.alive && guard++ < 1_000) step(world, 1);
    expect(applyContinue(world)).toBe(true);
    expect(stalkerAlive(world)).toBe(0);
    expect(world.stalker.ended).toHaveLength(1);
    expect(world.stalker.ended[0].outcome).toBe("died");
    expect(world.stalker.phase).toBe("waiting");
    expect(world.stalker.nextOmenTick).toBeGreaterThanOrEqual(world.stats.tick + APPEAR.lateGapSec.min * TICK_HZ);

    world.cheats.godMode = true;
    step(world, APPEAR.lateGapSec.min * TICK_HZ - 5);
    expect(world.stalker.phase).toBe("waiting");
    expect(stalkerAlive(world)).toBe(0);
  });

  it("продолжение при ожидании тоже отодвигает предвестие на паузу", () => {
    const world = makeWorld();
    jumpTo(world, FROM_TICK);
    world.stalker.nextOmenTick = FROM_TICK + 5;
    world.player.alive = false;
    expect(applyContinue(world)).toBe(true);
    expect(world.stalker.nextOmenTick).toBeGreaterThanOrEqual(FROM_TICK + APPEAR.lateGapSec.min * TICK_HZ);
  });
});

describe("снимок и контрольная сумма", () => {
  function options(): Partial<CreateWorldOptions> {
    return {};
  }

  function reach(phase: StalkerPhase): World {
    if (phase === "waiting") {
      const world = makeWorld(options());
      jumpTo(world, 1000);
      return world;
    }
    if (phase === "omen") return omenWorld();
    const world = chaseWorld();
    if (phase === "fading") {
      world.stalker.chaseTicks = 1;
      step(world, 1);
      expect(world.stalker.phase).toBe("fading");
    }
    return world;
  }

  function stateOf(world: World): Omit<World["stalker"], "ended" | "rng"> & { rng: number } {
    const state: Partial<World["stalker"]> = { ...world.stalker };
    delete state.ended;
    return { ...(state as Omit<World["stalker"], "ended" | "rng">), rng: world.stalker.rng.getState() };
  }

  for (const phase of ["waiting", "omen", "chase", "fading"] as const) {
    it(`снимок в фазе ${phase} восстанавливается, сумма совпадает через 600 тиков`, () => {
      const original = reach(phase);
      const director = createTimelineDirector(TIMELINE, ENDLESS_CURVE);
      const saved = JSON.parse(JSON.stringify(captureWorld(original, director))) as unknown;
      const resumed = makeWorld(options());
      restoreWorld(resumed, createTimelineDirector(TIMELINE, ENDLESS_CURVE), saved);
      expect(resumed.stalker.phase).toBe(phase);
      expect(stateOf(resumed)).toEqual(stateOf(original));
      expect(checksumWorld(resumed)).toBe(checksumWorld(original));

      step(original, 600);
      step(resumed, 600);
      expect(stateOf(resumed)).toEqual(stateOf(original));
      expect(checksumWorld(resumed)).toBe(checksumWorld(original));
    });
  }

  it("контрольная сумма видит фазу, тики и поток директора", () => {
    const world = makeWorld();
    const base = checksumWorld(world);
    world.stalker.nextOmenTick += 1;
    expect(checksumWorld(world)).not.toBe(base);
    world.stalker.nextOmenTick -= 1;
    expect(checksumWorld(world)).toBe(base);
    world.stalker.rng.nextUint32();
    expect(checksumWorld(world)).not.toBe(base);

    const omen = omenWorld();
    const omenSum = checksumWorld(omen);
    omen.stalker.phaseTicks -= 1;
    expect(checksumWorld(omen)).not.toBe(omenSum);
  });

  it("мир без правил считает сумму как раньше: директор в неё не входит", () => {
    const world = makeWorld({}, null);
    const sum = checksumWorld(world);
    world.stalker.nextOmenTick += 5;
    expect(checksumWorld(world)).toBe(sum);
  });

  it("снимок без поля stalker читается: Карачун не выходит раньше паузы", () => {
    const original = makeWorld();
    jumpTo(original, 20_000);
    const director = createTimelineDirector(TIMELINE, ENDLESS_CURVE);
    const saved = JSON.parse(JSON.stringify(captureWorld(original, director))) as Record<string, unknown>;
    delete saved["stalker"];

    const resumed = makeWorld();
    restoreWorld(resumed, createTimelineDirector(TIMELINE, ENDLESS_CURVE), saved);
    expect(resumed.stats.tick).toBe(20_000);
    expect(resumed.stalker.phase).toBe("waiting");
    expect(resumed.stalker.nextOmenTick).toBeGreaterThanOrEqual(20_000 + APPEAR.lateGapSec.min * TICK_HZ);
    step(resumed, 100);
    expect(resumed.stalker.phase).toBe("waiting");
    expect(stalkerAlive(resumed)).toBe(0);
  });

  it("снимок с неизвестной фазой отвергается", () => {
    const original = makeWorld();
    const director = createTimelineDirector(TIMELINE, ENDLESS_CURVE);
    const saved = JSON.parse(JSON.stringify(captureWorld(original, director))) as { stalker: { phase: string } };
    saved.stalker.phase = "lurking";
    expect(() => restoreWorld(makeWorld(), createTimelineDirector(TIMELINE, ENDLESS_CURVE), saved)).toThrow(/stalker\.phase/);
  });
});

describe("события мира", () => {
  it("номера событий предвестия, выхода и растворения", () => {
    expect(SIM_EVENT.stalkerOmen).toBe(11);
    expect(SIM_EVENT.stalkerAppear).toBe(12);
    expect(SIM_EVENT.stalkerFade).toBe(13);
  });
});

describe("правила появления", () => {
  const enemies = [RAT, KARACHUN];
  const problems = (patch: Partial<StalkerAppearDef>, maxAccountLevel = 20): string[] =>
    findStalkerProblems(withAppear(patch), enemies, { maxAccountLevel });

  it("нынешние правила чисты", () => {
    expect(findStalkerProblems(STALKER, enemies, { maxAccountLevel: 20 })).toEqual([]);
  });

  const cases: [string, Partial<StalkerAppearDef>][] = [
    ["stalker.appear.fromSec", { fromSec: -1 }],
    ["stalker.appear.firstDelaySec", { firstDelaySec: { min: 30, max: 10 } }],
    ["stalker.appear.firstDelaySec", { firstDelaySec: { min: -5, max: 10 } }],
    ["stalker.appear.gapSec", { gapSec: { min: 90, max: 80 } }],
    ["stalker.appear.gapSec", { gapSec: { min: 5, max: 110 } }],
    ["stalker.appear.gapSec", { gapSec: { min: 70, max: 700 } }],
    ["stalker.appear.lateGapSec", { lateGapSec: { min: 5, max: 55 } }],
    ["stalker.appear.lateGapSec", { lateGapSec: { min: 35, max: 700 } }],
    ["stalker.appear.lateGapSec", { lateGapSec: { min: 75, max: 80 } }],
    ["stalker.appear.lateGapSec", { lateGapSec: { min: 35, max: 120 } }],
    ["stalker.appear.lateAtSec", { lateAtSec: 240 }],
    ["stalker.appear.chaseSec", { chaseSec: { min: 2, max: 20 } }],
    ["stalker.appear.chaseSec", { chaseSec: { min: 10, max: 61 } }],
    ["stalker.appear.chaseSec", { chaseSec: { min: 20, max: 10 } }],
    ["stalker.appear.omenSec", { omenSec: 0.4 }],
    ["stalker.appear.omenSec", { omenSec: 3.5 }],
    ["stalker.appear.fadeSec", { fadeSec: 0.1 }],
    ["stalker.appear.fadeSec", { fadeSec: 2.5 }],
    ["stalker.appear.appearDistance", { appearDistance: 99 }],
    ["stalker.appear.farDistance", { farDistance: 249 }],
    ["stalker.appear.minAccountLevel", { minAccountLevel: 0 }],
    ["stalker.appear.minAccountLevel", { minAccountLevel: 2.5 }],
    ["stalker.appear.minAccountLevel", { minAccountLevel: 21 }],
  ];
  for (const [field, patch] of cases) {
    it(`${field}: ${JSON.stringify(patch)} — проблема с именем поля`, () => {
      const found = problems(patch);
      expect(found.some((message) => message.includes(field)), found.join("\n")).toBe(true);
    });
  }

  it("в видимую область стоящей камеры на самом узком экране входит только appearDistance 150, а 160 — нет", () => {
    const withDistance = (appearDistance: number): string[] =>
      findContentProblems({ ...CONTENT_SNAPSHOT, stalker: withAppear({ appearDistance }) }).filter((problem) => problem.path === "stalker").map((problem) => problem.message);
    expect(withDistance(150)).toEqual([]);
    const tooFar = withDistance(160);
    expect(tooFar.some((message) => message.includes("appearDistance") && message.includes(MAPS[0].id))).toBe(true);
  });

  it("farDistance не больше радиуса кольца спавна карты", () => {
    const found = findContentProblems({ ...CONTENT_SNAPSHOT, stalker: withAppear({ farDistance: 5_000 }) }).filter((problem) => problem.path === "stalker");
    expect(found.some((problem) => problem.message.includes("farDistance"))).toBe(true);
  });

  it("minAccountLevel выше лестницы открытий — проблема контента", () => {
    const top = Math.max(...CONTENT_SNAPSHOT.accountUnlocks.map((entry) => entry.level));
    const ok = findContentProblems({ ...CONTENT_SNAPSHOT, stalker: withAppear({ minAccountLevel: top }) });
    expect(ok.filter((problem) => problem.path === "stalker")).toEqual([]);
    const bad = findContentProblems({ ...CONTENT_SNAPSHOT, stalker: withAppear({ minAccountLevel: top + 1 }) });
    expect(bad.some((problem) => problem.path === "stalker" && problem.message.includes("minAccountLevel"))).toBe(true);
  });

  it("мир с неверными правилами не создаётся", () => {
    expect(() => makeWorld({}, withAppear({ omenSec: 0 }))).toThrow(/omenSec/);
  });
});
