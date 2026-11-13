import type { EnemyDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { findEnemyContentProblems } from "../src/game/patterns/enemy-types";
import { captureWorld, restoreWorld } from "../src/game/run/snapshot";
import { checksumWorld } from "../src/game/sim/checksum";
import { PUDDLE_POOL_SIZE, PUDDLE_TICK_SEC, puddleCount, spawnPuddle } from "../src/game/sim/hazards";
import type { Spawner } from "../src/game/sim/spawner";
import { IDLE_INPUT, stepWorld } from "../src/game/sim/step";
import { createWorld, despawnEnemy, DEFAULT_SIM_CONFIG, spawnEnemy, TICK_HZ, type World } from "../src/game/sim/world";

/**
 * Лужи врага со следом (`sim/hazards.ts`, T-0282): враг оставляет лужи, игрок
 * в луже получает урон тиками. Урон проверяется на физическом враге: у яда
 * к тику добавляется состояние, а здесь меряется чистая арифметика луж.
 */

const TRAIL = { everySec: 1.5, radius: 26, lifeSec: 4, damagePerSec: 5 };
// Враг стоит почти на месте: ему не нужно ходить, чтобы ставить лужи.
const PUDDLER: EnemyDef = { id: "puddler", hp: 40, speed: 0.001, damage: 0, xp: 1, pattern: "swarm", trail: TRAIL };
const PLAIN: EnemyDef = { id: "plain", hp: 40, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };
const VENOM: EnemyDef = { ...PUDDLER, id: "venom", element: "poison", statusChance: 1 };

const TYPES = [PUDDLER, PLAIN, VENOM];
const PUDDLER_TYPE = 0;
const VENOM_TYPE = 2;
const FAR = 300;

const NO_SPAWNER: Spawner = { update: () => undefined };

function setup(): World {
  return createWorld({
    seed: 7,
    enemies: TYPES,
    weapons: [],
    config: { progressionEnabled: false, player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 1000 } },
  });
}

function stepTicks(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepWorld(world, IDLE_INPUT);
}

function stepSeconds(world: World, seconds: number): void {
  stepTicks(world, Math.round(seconds * TICK_HZ));
}

describe("лужи в мире", () => {
  it("враг с everySec 1,5 за 4,6 с жизни ставит три лужи, первая — через everySec", () => {
    const world = setup();
    spawnEnemy(world, PUDDLER_TYPE, FAR, 0);
    stepTicks(world, 89);
    expect(puddleCount(world)).toBe(0);
    stepSeconds(world, 4.6 - 89 / TICK_HZ);
    expect(puddleCount(world)).toBe(3);
  });

  it("враг без следа луж не ставит", () => {
    const world = setup();
    spawnEnemy(world, 1, FAR, 0);
    stepSeconds(world, 6);
    expect(puddleCount(world)).toBe(0);
  });

  it("лужа ставится в точке врага", () => {
    const world = setup();
    spawnEnemy(world, PUDDLER_TYPE, FAR, 40);
    stepSeconds(world, 1.6);
    const puddles = world.hazards.puddles;
    const slot = [...puddles.alive].findIndex((alive) => alive === 1);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(Math.abs(puddles.x[slot] - FAR)).toBeLessThan(2);
    expect(Math.abs(puddles.y[slot] - 40)).toBeLessThan(2);
  });

  it("лужа живёт lifeSec и исчезает", () => {
    const world = setup();
    spawnPuddle(world, PUDDLER_TYPE, FAR, 0);
    stepTicks(world, 4 * TICK_HZ - 1);
    expect(puddleCount(world)).toBe(1);
    stepTicks(world, 2);
    expect(puddleCount(world)).toBe(0);
  });

  it("умер враг — лужи остаются и доживают свой срок", () => {
    const world = setup();
    const slot = spawnEnemy(world, PUDDLER_TYPE, FAR, 0);
    stepSeconds(world, 1.6);
    expect(puddleCount(world)).toBe(1);
    despawnEnemy(world, slot);
    stepSeconds(world, 1);
    expect(puddleCount(world)).toBe(1);
    stepSeconds(world, 4);
    expect(puddleCount(world)).toBe(0);
  });

  it("новый враг в слоте умершего отсчитывает everySec заново", () => {
    const world = setup();
    const slot = spawnEnemy(world, PUDDLER_TYPE, FAR, 0);
    stepSeconds(world, 1.4);
    despawnEnemy(world, slot);
    expect(spawnEnemy(world, PUDDLER_TYPE, -FAR, 0)).toBe(slot);
    stepSeconds(world, 0.5);
    expect(puddleCount(world)).toBe(0);
  });

  it("65-я лужа вытесняет самую старую", () => {
    const world = setup();
    for (let i = 0; i < PUDDLE_POOL_SIZE; i++) spawnPuddle(world, PUDDLER_TYPE, FAR + i * 100, 500);
    expect(puddleCount(world)).toBe(PUDDLE_POOL_SIZE);
    spawnPuddle(world, PUDDLER_TYPE, -5000, 500);
    expect(puddleCount(world)).toBe(PUDDLE_POOL_SIZE);
    const xs = [...world.hazards.puddles.x].filter((_, slot) => world.hazards.puddles.alive[slot] === 1);
    expect(xs).not.toContain(FAR);
    expect(xs).toContain(FAR + 100);
    expect(xs).toContain(-5000);
    // Следующая вытесняет следующую по возрасту, а не только что поставленную.
    spawnPuddle(world, PUDDLER_TYPE, -6000, 500);
    const after = [...world.hazards.puddles.x].filter((_, slot) => world.hazards.puddles.alive[slot] === 1);
    expect(after).not.toContain(FAR + 100);
    expect(after).toContain(-5000);
  });
});

describe("урон луж по игроку", () => {
  const tickDamage = TRAIL.damagePerSec * PUDDLE_TICK_SEC;

  it("игрок в луже секунду — два тика по damagePerSec × 0,5", () => {
    const world = setup();
    spawnPuddle(world, PUDDLER_TYPE, 0, 0);
    stepSeconds(world, 1);
    expect(1000 - world.player.hp).toBeCloseTo(2 * tickDamage, 5);
  });

  it("в двух перекрытых лужах — тот же урон, что в одной", () => {
    const single = setup();
    spawnPuddle(single, PUDDLER_TYPE, 0, 0);
    stepSeconds(single, 2);

    const double = setup();
    spawnPuddle(double, PUDDLER_TYPE, 0, 0);
    spawnPuddle(double, PUDDLER_TYPE, 5, 0);
    stepSeconds(double, 2);

    expect(1000 - double.player.hp).toBeCloseTo(1000 - single.player.hp, 5);
    expect(1000 - double.player.hp).toBeCloseTo(4 * tickDamage, 5);
  });

  it("вне лужи урона нет, а край круга считается с радиусом игрока", () => {
    const world = setup();
    const reach = world.enemyTypes[PUDDLER_TYPE].trail?.radius ?? 0;
    // Центр лужи дальше радиуса лужи и игрока — не задевает.
    spawnPuddle(world, PUDDLER_TYPE, reach + world.config.player.radius + 1, 0);
    stepSeconds(world, 2);
    expect(world.player.hp).toBe(1000);

    // Чуть ближе — задевает: центр игрока ближе, чем радиус лужи и игрока вместе.
    const edge = setup();
    spawnPuddle(edge, PUDDLER_TYPE, reach + edge.config.player.radius - 1, 0);
    stepSeconds(edge, 1);
    expect(edge.player.hp).toBeLessThan(1000);
  });

  it("зайти в лужу на миг не больно: тик идёт по времени внутри", () => {
    const world = setup();
    spawnPuddle(world, PUDDLER_TYPE, 0, 0);
    stepTicks(world, 20);
    expect(world.player.hp).toBe(1000);
  });

  it("урон идёт через damagePlayer: броня работает", () => {
    const world = setup();
    world.playerStats.armor = 1;
    spawnPuddle(world, PUDDLER_TYPE, 0, 0);
    stepSeconds(world, 1);
    expect(1000 - world.player.hp).toBeCloseTo(2 * (tickDamage - 1), 5);
  });

  it("ядовитая лужа травит игрока: состояние со statusChance, причина смерти — враг", () => {
    const world = setup();
    spawnPuddle(world, VENOM_TYPE, 0, 0);
    stepSeconds(world, 0.6);
    expect(world.player.poisonTimer).toBeGreaterThan(0);

    world.player.hp = 1;
    stepSeconds(world, 1);
    expect(world.player.alive).toBe(false);
    expect(world.stats.deathCauseType).toBe(VENOM_TYPE);
  });

  it("лужа без стихии бьёт без состояния", () => {
    const world = setup();
    spawnPuddle(world, PUDDLER_TYPE, 0, 0);
    stepSeconds(world, 1);
    expect(world.player.poisonTimer).toBe(0);
    expect(world.player.burnTimer).toBe(0);
  });
});

describe("снимок забега с лужами", () => {
  it("восстановленный мир идёт тем же ходом: лужи, таймеры следа и сумма", () => {
    const original = setup();
    spawnEnemy(original, PUDDLER_TYPE, FAR, 0);
    spawnEnemy(original, PUDDLER_TYPE, -FAR, 120);
    stepSeconds(original, 2.2);
    spawnPuddle(original, VENOM_TYPE, 30, 0);
    stepSeconds(original, 0.7);
    expect(puddleCount(original)).toBeGreaterThan(1);

    const saved = JSON.parse(JSON.stringify(captureWorld(original, NO_SPAWNER))) as unknown;
    const resumed = setup();
    restoreWorld(resumed, NO_SPAWNER, saved);
    expect(checksumWorld(resumed)).toBe(checksumWorld(original));
    expect(puddleCount(resumed)).toBe(puddleCount(original));

    stepSeconds(original, 6);
    stepSeconds(resumed, 6);
    expect(checksumWorld(resumed)).toBe(checksumWorld(original));
    expect(resumed.hazards.puddles.ttl).toEqual(original.hazards.puddles.ttl);
    expect(resumed.hazards.puddles.x).toEqual(original.hazards.puddles.x);
    expect(resumed.player.hp).toBe(original.player.hp);
  });

  it("снимок без лужи читается: лужи пусты, отсчёт следа идёт с нуля", () => {
    const original = setup();
    spawnEnemy(original, PUDDLER_TYPE, FAR, 0);
    const saved = JSON.parse(JSON.stringify(captureWorld(original, NO_SPAWNER))) as Record<string, unknown>;
    delete saved["hazards"];
    const resumed = setup();
    restoreWorld(resumed, NO_SPAWNER, saved);
    expect(puddleCount(resumed)).toBe(0);
  });
});

describe("проверка следа в контенте", () => {
  const bog = (trail: Record<string, number>): EnemyDef => ({ ...PUDDLER, id: "bog_lurker", trail: { ...TRAIL, ...trail } } as EnemyDef);

  it("называет врага и поле, вышедшее из коридора", () => {
    expect(findEnemyContentProblems([bog({ radius: 70 })])).toContain("враг bog_lurker: trail.radius вне 12…60");
    expect(findEnemyContentProblems([bog({ radius: 11 })])).toContain("враг bog_lurker: trail.radius вне 12…60");
    expect(findEnemyContentProblems([bog({ everySec: 0.4 })])).toContain("враг bog_lurker: trail.everySec вне 0,5…5");
    expect(findEnemyContentProblems([bog({ everySec: 5.5 })])).toContain("враг bog_lurker: trail.everySec вне 0,5…5");
    expect(findEnemyContentProblems([bog({ lifeSec: 0.5 })])).toContain("враг bog_lurker: trail.lifeSec вне 1…8");
    expect(findEnemyContentProblems([bog({ lifeSec: 9 })])).toContain("враг bog_lurker: trail.lifeSec вне 1…8");
    expect(findEnemyContentProblems([bog({ damagePerSec: 0 })])).toContain("враг bog_lurker: trail.damagePerSec вне 1…20");
    expect(findEnemyContentProblems([bog({ damagePerSec: 21 })])).toContain("враг bog_lurker: trail.damagePerSec вне 1…20");
  });

  it("граничные значения коридора допустимы, число не из чисел — нет", () => {
    expect(findEnemyContentProblems([bog({ everySec: 0.5, radius: 12, lifeSec: 1, damagePerSec: 1 })])).toEqual([]);
    expect(findEnemyContentProblems([bog({ everySec: 5, radius: 60, lifeSec: 8, damagePerSec: 20 })])).toEqual([]);
    expect(findEnemyContentProblems([bog({ radius: Number.NaN })])).toContain("враг bog_lurker: trail.radius вне 12…60");
  });

  it("враг со следом без стихии допустим: урон без состояния", () => {
    expect(findEnemyContentProblems([PUDDLER])).toEqual([]);
  });

  it("весь контент проходит проверку, а след есть у Болотника", () => {
    expect(findEnemyContentProblems(ENEMIES)).toEqual([]);
    const lurker = ENEMIES.find((enemy) => enemy.id === "bog_lurker");
    expect(lurker?.trail).toEqual({ everySec: 1.5, radius: 26, lifeSec: 4, damagePerSec: 5 });
  });
});
