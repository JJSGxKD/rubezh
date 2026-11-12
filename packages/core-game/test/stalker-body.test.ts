import type { EnemyDef, StalkerBodyDef, StalkerDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { CHESTS } from "../src/content/chests";
import { DROPS } from "../src/content/drops";
import { ENEMIES } from "../src/content/enemies";
import { MAPS } from "../src/content/maps";
import { PASSIVES, LEVEL_CURVE, LOADOUT_LIMITS } from "../src/content/upgrades";
import { STALKER } from "../src/content/stalker";
import { CONTENT_SNAPSHOT } from "../src/content/snapshot";
import { ENDLESS_CURVE, TIMELINE } from "../src/content/waves";
import { WEAPONS } from "../src/content/weapons";
import { findContentProblems } from "../src/game/content-problems";
import { captureWorld, restoreWorld } from "../src/game/run/snapshot";
import { checksumWorld } from "../src/game/sim/checksum";
import { damageEnemy, inflictDamage } from "../src/game/sim/combat";
import { createTimelineDirector } from "../src/game/sim/director";
import { ELEMENT_COLD, ELEMENT_FIRE, ELEMENT_LIGHTNING, ELEMENT_PHYSICAL, ELEMENT_POISON } from "../src/game/sim/element-ids";
import { startFreeze } from "../src/game/sim/freeze";
import { PICKUP_KIND, spawnPickup, updatePickups } from "../src/game/sim/pickups";
import { despawnStalker, findStalkerProblems, spawnStalker, stalkerAlive } from "../src/game/sim/stalker-body";
import { IDLE_INPUT, stepWorld, type SimInput } from "../src/game/sim/step";
import { findTimelineProblems } from "../src/game/sim/timeline-content";
import { createWorld, DEFAULT_SIM_CONFIG, damagePlayer, spawnEnemy, TICK_HZ, type CreateWorldOptions, type World } from "../src/game/sim/world";

// Тело неубиваемого преследователя (Р205, tasks/T-0421): удары его не убивают,
// а отталкивают — слабее с каждым ударом серии и не дальше предела в секунду;
// касание снимает долю максимума здоровья мимо брони и отбрасывает игрока.

const RAT: EnemyDef = { id: "rat", hp: 10, speed: 60, damage: 4, xp: 1, pattern: "swarm" };
const KARACHUN: EnemyDef = { id: "karachun", hp: 1, speed: 110, damage: 0, xp: 0, pattern: "stalker" };
const RAT_TYPE = 0;
const KARACHUN_TYPE = 1;

const BODY = STALKER.body;
const PLAYER_MAX_HP = 1000;
const MELEE_INPUT: SimInput = { moveX: 1, moveY: 0 };

function makeWorld(patch: Partial<CreateWorldOptions> = {}, stalker: StalkerDef | undefined = STALKER): World {
  return createWorld({
    seed: 7,
    enemies: [RAT, KARACHUN],
    ...(stalker === undefined ? {} : { stalker }),
    config: {
      progressionEnabled: false,
      player: { ...DEFAULT_SIM_CONFIG.player, maxHp: PLAYER_MAX_HP },
    },
    ...patch,
  });
}

/** Мир, где Карачун уже стоит в точке; игрок в начале координат. */
function withStalker(x = 300, y = 0, patch: Partial<CreateWorldOptions> = {}): { world: World; slot: number } {
  const world = makeWorld(patch);
  const slot = spawnStalker(world, KARACHUN_TYPE, x, y);
  expect(slot).toBeGreaterThanOrEqual(0);
  return { world, slot };
}

function step(world: World, ticks: number, input: SimInput = IDLE_INPUT): void {
  for (let i = 0; i < ticks; i++) stepWorld(world, input);
}

/** Без хода врагов: тест смотрит только на толчки. */
function frozen(world: World): World {
  world.cheats.freezeEnemies = true;
  return world;
}

function secToTicks(sec: number): number {
  return Math.round(sec * TICK_HZ);
}

describe("появление преследователя", () => {
  it("ставит одного: второй вызов при живом возвращает −1", () => {
    const world = makeWorld();
    const first = spawnStalker(world, KARACHUN_TYPE, 300, 0);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(spawnStalker(world, KARACHUN_TYPE, 400, 0)).toBe(-1);
    expect(world.enemies.aliveCount).toBe(1);
    expect(stalkerAlive(world)).toBe(1);
  });

  it("после снятия ставится снова", () => {
    const world = makeWorld();
    spawnStalker(world, KARACHUN_TYPE, 300, 0);
    despawnStalker(world);
    expect(stalkerAlive(world)).toBe(0);
    expect(world.enemies.aliveCount).toBe(0);
    expect(spawnStalker(world, KARACHUN_TYPE, 300, 0)).toBeGreaterThanOrEqual(0);
  });

  it("без правил тела в мире не ставит никого", () => {
    const world = makeWorld({}, undefined);
    expect(spawnStalker(world, KARACHUN_TYPE, 300, 0)).toBe(-1);
    expect(world.enemies.aliveCount).toBe(0);
  });

  it("не ставит врага не того паттерна", () => {
    const world = makeWorld();
    expect(spawnStalker(world, RAT_TYPE, 300, 0)).toBe(-1);
  });

  it("ступень, подстройка и множители отрезка его не меняют, генератор не тронут", () => {
    const world = makeWorld({
      stages: [
        { fromSec: 0, weight: 1, hpMul: 1, damageMul: 1, speedMul: 1, xpMul: 1 },
        { fromSec: 0, weight: 1, hpMul: 5, damageMul: 5, speedMul: 2, xpMul: 1 },
      ],
    });
    world.difficulty.hpMul = 9;
    world.difficulty.damageMul = 9;
    const before = world.rng.getState();
    const slot = spawnStalker(world, KARACHUN_TYPE, 300, 0);
    expect(world.enemies.hp[slot]).toBe(1);
    expect(world.enemies.damage[slot]).toBe(0);
    expect(world.enemies.stage[slot]).toBe(0);
    expect(world.rng.getState()).toBe(before);
  });

  it("идёт на игрока со скоростью из контента", () => {
    const { world, slot } = withStalker(300, 0);
    step(world, TICK_HZ);
    // Секунда хода при скорости 110: ступени и состояния скорость не меняют.
    expect(300 - world.enemies.x[slot]).toBeCloseTo(110, 0);
  });
});

describe("неубиваемость", () => {
  /** Ничего не изменилось: здоровье, счётчики, добыча. */
  function expectUntouched(world: World, slot: number): void {
    expect(world.enemies.alive[slot]).toBe(1);
    expect(world.enemies.hp[slot]).toBe(1);
    expect(world.stats.enemiesKilled).toBe(0);
    expect(Array.from(world.stats.killsByType).every((kills) => kills === 0)).toBe(true);
    expect(world.stats.damageDealt).toBe(0);
    expect(Array.from(world.stats.damageByElement).every((damage) => damage === 0)).toBe(true);
    expect(Array.from(world.stats.damageByWeapon).every((damage) => damage === 0)).toBe(true);
    expect(world.stats.xpCollected).toBe(0);
    expect(world.gems.aliveCount).toBe(0);
    expect(world.pickups.aliveCount).toBe(0);
    expect(world.stats.chestsFound).toBe(0);
    expect(world.chests.dropped).toBe(0);
  }

  function lootWorld(): { world: World; slot: number } {
    return withStalker(300, 0, {
      drops: {
        ...DROPS,
        medkits: { ...DROPS.medkits, chance: 1, eliteChance: 1 },
        magnets: { ...DROPS.magnets, chance: 1, eliteChance: 1 },
      },
      chests: CHESTS,
      config: { progressionEnabled: true, lootEnabled: true, player: { ...DEFAULT_SIM_CONFIG.player, maxHp: PLAYER_MAX_HP } },
    });
  }

  it("десять тысяч урона всех стихий — здоровье то же, убийств, опыта и добычи нет", () => {
    const { world, slot } = lootWorld();
    for (const element of [ELEMENT_PHYSICAL, ELEMENT_FIRE, ELEMENT_COLD, ELEMENT_LIGHTNING, ELEMENT_POISON]) {
      damageEnemy(world, slot, 10_000, 0, element, 1);
    }
    inflictDamage(world, slot, 10_000, 0);
    expectUntouched(world, slot);
  });

  it("чит «убить с одного удара» его не убивает", () => {
    const { world, slot } = lootWorld();
    world.cheats.oneHitKill = true;
    world.cheats.damageMul = 1000;
    damageEnemy(world, slot, 5, 0);
    expectUntouched(world, slot);
  });

  it("молния с перескоком: рядовой бьётся, Карачун цепью не задет и не сдвинут", () => {
    const { world, slot } = withStalker(300, 0);
    const rat = spawnEnemy(world, RAT_TYPE, 300, 12);
    // Рядовой уже шокирован: молния в него перескакивает, и ближайшая цель — Карачун.
    world.enemies.shockTimer[rat] = 5;
    world.enemyGrid.rebuild(world.player.x, world.player.y, world.enemies.x, world.enemies.y, world.enemies.alive, world.enemies.count);
    damageEnemy(world, rat, 3, 0, ELEMENT_LIGHTNING);
    expect(world.enemies.hp[rat]).toBeLessThan(10);
    expect(world.enemies.x[slot]).toBe(300);
    expect(world.enemies.hp[slot]).toBe(1);
    expect(world.enemies.alive[slot]).toBe(1);
    expect(world.stats.killsByType[KARACHUN_TYPE]).toBe(0);
  });

  it("каждое оружие контента за десять секунд забега: Карачун цел", { timeout: 30_000 }, () => {
    for (const weapon of WEAPONS.filter((entry) => entry.evolvedFrom === undefined)) {
      const world = createWorld({
        seed: 11,
        enemies: [RAT, KARACHUN],
        stalker: STALKER,
        weapons: WEAPONS,
        startingWeaponId: weapon.id,
        drops: DROPS,
        chests: CHESTS,
        config: { progressionEnabled: true, lootEnabled: true, player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 1_000_000 } },
      });
      const slot = spawnStalker(world, KARACHUN_TYPE, 120, 0);
      step(world, 10 * TICK_HZ);
      expect(world.enemies.alive[slot], weapon.id).toBe(1);
      expect(world.enemies.hp[slot], weapon.id).toBe(1);
      expect(world.stats.enemiesKilled, weapon.id).toBe(0);
      expect(world.stats.xpCollected, weapon.id).toBe(0);
      expect(world.gems.aliveCount, weapon.id).toBe(0);
    }
  });

  it("стихийное оружие: состояния не накладываются, генератор мира не тронут", () => {
    const { world, slot } = withStalker(300, 0);
    const before = world.rng.getState();
    for (const element of [ELEMENT_FIRE, ELEMENT_COLD, ELEMENT_LIGHTNING, ELEMENT_POISON]) {
      damageEnemy(world, slot, 50, 0, element, 1);
    }
    const enemies = world.enemies;
    expect(world.rng.getState()).toBe(before);
    expect(enemies.burnTimer[slot]).toBe(0);
    expect(enemies.chillTimer[slot]).toBe(0);
    expect(enemies.shockTimer[slot]).toBe(0);
    expect(enemies.poisonTimer[slot]).toBe(0);
    step(world, 120);
    expect(enemies.hp[slot]).toBe(1);
  });

  it("динамит рядом его не трогает, а рядового убивает", () => {
    const world = makeWorld({ drops: { ...DROPS, dynamite: { ...DROPS.dynamite, maxOnField: 1, radiusUnits: 500 } } });
    const slot = spawnStalker(world, KARACHUN_TYPE, 100, 0);
    // Рядовой в том же радиусе: без него проверка пропустила бы и «динамит не сработал вовсе».
    const rat = spawnEnemy(world, RAT_TYPE, 120, 0);
    spawnPickup(world, PICKUP_KIND.dynamite, world.player.x, world.player.y);
    updatePickups(world);
    expect(world.stats.dynamiteCollected).toBe(1);
    expect(world.enemies.alive[rat]).toBe(0);
    expect(world.stats.killsByType[RAT_TYPE]).toBe(1);
    expect(world.enemies.alive[slot]).toBe(1);
    expect(world.enemies.hp[slot]).toBe(1);
    expect(world.stats.killsByType[KARACHUN_TYPE]).toBe(0);
  });

  it("заморозка подбором держит его столько же, сколько босса", () => {
    const { world, slot } = withStalker(300, 0);
    startFreeze(world);
    const total = world.stats.freezeTotalTicks;
    const frozenTicks = Math.floor(total * world.drops.freeze.bossDurationRatio);
    step(world, frozenTicks - 1);
    expect(world.enemies.x[slot]).toBe(300);
    step(world, 10);
    expect(world.enemies.x[slot]).toBeLessThan(300);
  });

  it("убийство через killEnemy до него не доходит: смерть слота не засчитывается никому", () => {
    const { world, slot } = withStalker(300, 0);
    // Единственный путь к убийству — урон, а он возвращает ноль.
    expect(inflictDamage(world, slot, 10_000, 0)).toBe(0);
    expect(world.stats.enemiesKilled).toBe(0);
    expect(world.stats.killsByType[KARACHUN_TYPE]).toBe(0);
  });
});

describe("толчок", () => {
  it("первый удар отодвигает на first, второй подряд — на first × decay", () => {
    const { world, slot } = withStalker(300, 0);
    frozen(world);
    damageEnemy(world, slot, 5, 0);
    expect(world.enemies.x[slot]).toBeCloseTo(300 + BODY.push.first, 2);
    const afterFirst = world.enemies.x[slot];
    damageEnemy(world, slot, 5, 0);
    expect(world.enemies.x[slot] - afterFirst).toBeCloseTo(BODY.push.first * BODY.push.decay, 2);
    expect(world.enemies.hp[slot]).toBe(1);
  });

  it("серия сначала, когда seriesResetSec без ударов прошло", () => {
    const { world, slot } = withStalker(300, 0);
    frozen(world);
    damageEnemy(world, slot, 5, 0);
    damageEnemy(world, slot, 5, 0);
    step(world, secToTicks(BODY.push.seriesResetSec) + 4);
    const before = world.enemies.x[slot];
    damageEnemy(world, slot, 5, 0);
    expect(world.enemies.x[slot] - before).toBeCloseTo(BODY.push.first, 2);
  });

  it("до истечения срока серия не сбрасывается", () => {
    const { world, slot } = withStalker(300, 0);
    frozen(world);
    damageEnemy(world, slot, 5, 0);
    step(world, secToTicks(BODY.push.seriesResetSec) - 6);
    const before = world.enemies.x[slot];
    damageEnemy(world, slot, 5, 0);
    expect(world.enemies.x[slot] - before).toBeCloseTo(BODY.push.first * BODY.push.decay, 2);
  });

  it("толчок идёт от игрока, а не по ходу снаряда", () => {
    const world = makeWorld();
    frozen(world);
    world.player.x = 100;
    world.player.y = 100;
    const slot = spawnStalker(world, KARACHUN_TYPE, 100, 400);
    damageEnemy(world, slot, 5, 0);
    expect(world.enemies.x[slot]).toBeCloseTo(100, 3);
    expect(world.enemies.y[slot]).toBeCloseTo(400 + BODY.push.first, 2);
  });

  it("толчок масштабируется под устройство", () => {
    const world = makeWorld({ config: { progressionEnabled: false, unitScale: 2, player: { ...DEFAULT_SIM_CONFIG.player, maxHp: PLAYER_MAX_HP } } });
    frozen(world);
    const slot = spawnStalker(world, KARACHUN_TYPE, 600, 0);
    damageEnemy(world, slot, 5, 0);
    expect(world.enemies.x[slot]).toBeCloseTo(600 + BODY.push.first * 2, 2);
  });

  it("вспышка попадания ставится: рендеру нужен отклик на удар", () => {
    const { world, slot } = withStalker(300, 0);
    frozen(world);
    step(world, 5);
    damageEnemy(world, slot, 5, 0);
    expect(world.enemies.hitTick[slot]).toBe(world.stats.tick);
  });

  it("у стены толчок зажат границей карты", () => {
    const world = makeWorld({ map: { ...MAPS[0], bounds: { halfWidth: 320 } } });
    frozen(world);
    const slot = spawnStalker(world, KARACHUN_TYPE, 310, 0);
    for (let i = 0; i < 5; i++) damageEnemy(world, slot, 5, 0);
    expect(world.enemies.x[slot]).toBeLessThanOrEqual(320);
  });
});

describe("предел толчков", () => {
  it("за любые 60 тиков подряд он уходит не дальше maxPerSec", () => {
    // Затухание почти нулевое: без предела серия легко ушла бы дальше шестидесяти.
    const body: StalkerBodyDef = { ...BODY, push: { ...BODY.push, decay: 0.99 } };
    const world = frozen(makeWorld({}, { ...STALKER, body }));
    const slot = spawnStalker(world, KARACHUN_TYPE, 1000, 0);
    const xs: number[] = [world.enemies.x[slot]];
    for (let tick = 0; tick < 240; tick++) {
      damageEnemy(world, slot, 5, 0);
      stepWorld(world, IDLE_INPUT);
      xs.push(world.enemies.x[slot]);
    }
    let reached = 0;
    for (let from = 0; from + 60 < xs.length; from++) {
      const shift = xs[from + 60] - xs[from];
      expect(shift, `окно с тика ${String(from)}`).toBeLessThanOrEqual(body.push.maxPerSec + 1e-6);
      reached = Math.max(reached, shift);
    }
    // Предел достигается: иначе проверка зелёная и без самого предела.
    expect(reached).toBeGreaterThan(body.push.maxPerSec - 1);
  });

  it("под огнём каждый тик с нормальными числами сумма сдвигов ограничена серией", () => {
    const world = frozen(makeWorld());
    const slot = spawnStalker(world, KARACHUN_TYPE, 1000, 0);
    for (let tick = 0; tick < 120; tick++) {
      damageEnemy(world, slot, 5, 0);
      stepWorld(world, IDLE_INPUT);
    }
    expect(world.enemies.x[slot] - 1000).toBeLessThanOrEqual(BODY.push.maxPerSec * 2);
  });

  it("стоящий игрок под огнём: он всё равно подходит и касается не позже шести секунд", () => {
    const { world, slot } = withStalker(160, 0);
    let touchedAt = -1;
    for (let tick = 0; tick < 6 * TICK_HZ && touchedAt < 0; tick++) {
      damageEnemy(world, slot, 5, 0);
      stepWorld(world, IDLE_INPUT);
      if (world.player.hp < PLAYER_MAX_HP) touchedAt = tick;
    }
    expect(touchedAt).toBeGreaterThanOrEqual(0);
  });
});

describe("касание", () => {
  /** Игрок с бронёй и сопротивлениями: касание обязано пройти мимо них. */
  function armoured(world: World): void {
    world.playerStats.armor = 10;
    world.playerStats.resistFire = 0.5;
    world.playerStats.resistCold = 0.5;
    world.playerStats.resistLightning = 0.5;
    world.playerStats.resistPoison = 0.5;
  }

  /** Шагает, пока игрок не получит урон; возвращает число шагов. */
  function untilTouch(world: World, input: SimInput = IDLE_INPUT, limit = 10 * TICK_HZ): number {
    for (let tick = 0; tick < limit; tick++) {
      const hp = world.player.hp;
      stepWorld(world, input);
      if (world.player.hp < hp) return tick;
    }
    return -1;
  }

  it("снимает долю максимума здоровья мимо брони и сопротивлений", () => {
    const { world } = withStalker(200, 0);
    armoured(world);
    expect(untilTouch(world)).toBeGreaterThanOrEqual(0);
    expect(PLAYER_MAX_HP - world.player.hp).toBeCloseTo(PLAYER_MAX_HP * BODY.touchMaxHpShare, 2);
    expect(world.stats.damageTaken).toBeCloseTo(PLAYER_MAX_HP * BODY.touchMaxHpShare, 2);
  });

  it("отбрасывает от Карачуна на distance за sec, ввод в это время не действует", () => {
    const { world, slot } = withStalker(200, 0);
    expect(untilTouch(world)).toBeGreaterThanOrEqual(0);
    expect(world.player.knockbackTicks).toBe(secToTicks(BODY.knockback.sec));
    const startX = world.player.x;
    const startY = world.player.y;
    const stalkerX = world.enemies.x[slot];
    expect(stalkerX).toBeGreaterThan(startX);

    // Игрок давит на Карачуна — и всё равно летит прочь.
    let ticks = 0;
    while (world.player.knockbackTicks > 0 && ticks < 100) {
      stepWorld(world, MELEE_INPUT);
      ticks++;
    }
    expect(ticks).toBe(secToTicks(BODY.knockback.sec));
    expect(startX - world.player.x).toBeCloseTo(BODY.knockback.distance, 0);
    expect(Math.abs(world.player.x - startX + BODY.knockback.distance)).toBeLessThanOrEqual(2);
    expect(world.player.y).toBeCloseTo(startY, 3);
    // После отброса игрок стоит: разгон заново, а не остаток скорости.
    expect(world.player.vx).toBe(0);
    expect(world.player.vy).toBe(0);
  });

  it("очередью не бьёт: второе касание — не раньше touchCooldownSec, хотя тела соприкасаются", () => {
    const { world, slot } = withStalker(0, 0);
    world.player.hp = 100_000;
    world.player.maxHp = 100_000;
    world.playerStats.maxHp = 100_000;
    const hits: number[] = [];
    for (let tick = 0; tick < 4 * TICK_HZ; tick++) {
      // Игрок прикован к телу Карачуна: касание есть на каждом тике.
      world.player.x = world.enemies.x[slot];
      world.player.y = world.enemies.y[slot];
      const hp = world.player.hp;
      stepWorld(world, IDLE_INPUT);
      if (world.player.hp < hp) hits.push(tick);
    }
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[1] - hits[0]).toBe(secToTicks(BODY.touchCooldownSec));
  });

  it("после касания он стоит recoverSec", () => {
    const { world, slot } = withStalker(200, 0);
    expect(untilTouch(world)).toBeGreaterThanOrEqual(0);
    const x = world.enemies.x[slot];
    step(world, secToTicks(BODY.recoverSec) - 5);
    expect(world.enemies.x[slot]).toBe(x);
    step(world, 20);
    expect(world.enemies.x[slot]).not.toBe(x);
  });

  it("щит буста гасит касание целиком", () => {
    const { world } = withStalker(200, 0);
    world.player.shieldHits = 1;
    expect(untilTouch(world, IDLE_INPUT, 6 * TICK_HZ)).toBe(-1);
    expect(world.player.hp).toBe(PLAYER_MAX_HP);
    expect(world.player.shieldHits).toBe(0);
  });

  it("неуязвимость после второго шанса защищает", () => {
    const { world } = withStalker(200, 0);
    world.player.invulnerableTicks = 10_000;
    expect(untilTouch(world, IDLE_INPUT, 4 * TICK_HZ)).toBe(-1);
    expect(world.player.hp).toBe(PLAYER_MAX_HP);
  });

  it("бессмертие разработчика не даёт урона", () => {
    const { world } = withStalker(200, 0);
    world.cheats.godMode = true;
    expect(untilTouch(world, IDLE_INPUT, 4 * TICK_HZ)).toBe(-1);
    expect(world.player.hp).toBe(PLAYER_MAX_HP);
  });

  it("смерть от касания записывает причиной тип Карачуна", () => {
    const { world } = withStalker(200, 0);
    world.player.hp = 10;
    for (let tick = 0; tick < 6 * TICK_HZ && world.player.alive; tick++) stepWorld(world, IDLE_INPUT);
    expect(world.player.alive).toBe(false);
    expect(world.stats.deathCauseType).toBe(KARACHUN_TYPE);
  });

  it("обычное попадание по игроку не затронуто: damagePlayer без нового аргумента считает броню", () => {
    const world = makeWorld();
    world.playerStats.armor = 10;
    damagePlayer(world, 15, RAT_TYPE);
    expect(PLAYER_MAX_HP - world.player.hp).toBeCloseTo(5, 3);
  });
});

describe("потолок живых, перенос вперёд, пик", () => {
  it("отставшего Карачуна вперёд не переносят, рядового — переносят", () => {
    const world = makeWorld();
    const far = world.config.view.retentionRadius * 3;
    const slot = spawnStalker(world, KARACHUN_TYPE, far, 0);
    stepWorld(world, IDLE_INPUT);
    expect(world.stats.enemiesRecycled).toBe(0);
    expect(world.enemies.x[slot]).toBeGreaterThan(far - 5);

    // Контроль: рядовой на том же расстоянии уносится вперёд, поэтому проверка что-то проверяет.
    spawnEnemy(world, RAT_TYPE, far, 0);
    stepWorld(world, IDLE_INPUT);
    expect(world.stats.enemiesRecycled).toBe(1);
  });

  it("директор выпускает рядовых до потолка, не считая Карачуна", () => {
    const cap = 10;
    const world = createWorld({
      seed: 5,
      enemies: ENEMIES,
      stalker: STALKER,
      weapons: WEAPONS,
      map: MAPS[0],
      config: { progressionEnabled: false, player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 1_000_000 } },
    });
    const typeIndex = ENEMIES.findIndex((enemy) => enemy.id === "karachun");
    spawnStalker(world, typeIndex, 900, 0);
    const timeline = [{ fromSec: 0, maxAlive: cap, spawns: [{ enemy: "swarm_rat", perSec: 30 }] }];
    const director = createTimelineDirector(timeline, ENDLESS_CURVE);
    let peakOthers = 0;
    for (let tick = 0; tick < 8 * TICK_HZ; tick++) {
      director.update(world, 1 / TICK_HZ);
      stepWorld(world, IDLE_INPUT);
      peakOthers = Math.max(peakOthers, world.enemies.aliveCount - stalkerAlive(world));
    }
    expect(peakOthers).toBe(cap);
    // Пик забега тоже не считает Карачуна: он не толпа.
    expect(world.stats.peakEnemies).toBeLessThanOrEqual(cap);
  });
});

describe("снимок забега и контрольная сумма", () => {
  it("снимок посреди серии толчков и отброса игрока восстанавливается: сумма совпадает через 300 тиков", { timeout: 30_000 }, () => {
    const typeIndex = ENEMIES.findIndex((enemy) => enemy.id === "karachun");
    const options = (): CreateWorldOptions => ({
      seed: 99,
      enemies: ENEMIES,
      stalker: STALKER,
      weapons: WEAPONS,
      passives: PASSIVES,
      levelCurve: LEVEL_CURVE,
      loadoutLimits: LOADOUT_LIMITS,
      drops: DROPS,
      chests: CHESTS,
      map: MAPS[0],
      config: { progressionEnabled: false, player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 1_000_000 } },
    });
    const original = createWorld(options());
    const director = createTimelineDirector(TIMELINE, ENDLESS_CURVE);
    const slot = spawnStalker(original, typeIndex, 200, 0);
    let guard = 0;
    while (original.player.knockbackTicks < 4 && guard++ < 600) {
      damageEnemy(original, slot, 5, 0);
      director.update(original, 1 / TICK_HZ);
      stepWorld(original, IDLE_INPUT);
    }
    expect(original.player.knockbackTicks).toBeGreaterThanOrEqual(4);
    damageEnemy(original, slot, 5, 0);
    damageEnemy(original, slot, 5, 0);
    expect(original.stalkerBody.seriesFactor).toBeLessThan(1);

    const saved = JSON.parse(JSON.stringify(captureWorld(original, director))) as unknown;
    const resumed = createWorld(options());
    const resumedDirector = createTimelineDirector(TIMELINE, ENDLESS_CURVE);
    restoreWorld(resumed, resumedDirector, saved);
    expect(checksumWorld(resumed)).toBe(checksumWorld(original));
    expect(resumed.stalkerBody).toEqual(original.stalkerBody);
    expect(resumed.player.knockbackTicks).toBe(original.player.knockbackTicks);

    for (let tick = 0; tick < 300; tick++) {
      director.update(original, 1 / TICK_HZ);
      stepWorld(original, IDLE_INPUT);
      resumedDirector.update(resumed, 1 / TICK_HZ);
      stepWorld(resumed, IDLE_INPUT);
    }
    expect(checksumWorld(resumed)).toBe(checksumWorld(original));
    expect(resumed.stalkerBody).toEqual(original.stalkerBody);
  });

  it("снимок прежнего формата без тела и отброса читается: тело пустое, отброса нет", () => {
    const original = makeWorld();
    const director = createTimelineDirector(TIMELINE, ENDLESS_CURVE);
    const saved = JSON.parse(JSON.stringify(captureWorld(original, director))) as Record<string, unknown>;
    delete saved["stalkerBody"];
    const player = saved["player"] as Record<string, unknown>;
    delete player["knockbackTicks"];
    delete player["knockbackVx"];
    delete player["knockbackVy"];

    const resumed = makeWorld();
    spawnStalker(resumed, KARACHUN_TYPE, 300, 0);
    restoreWorld(resumed, createTimelineDirector(TIMELINE, ENDLESS_CURVE), saved);
    expect(resumed.stalkerBody.slot).toBe(-1);
    expect(resumed.player.knockbackTicks).toBe(0);
    expect(stalkerAlive(resumed)).toBe(0);
  });

  it("контрольная сумма видит тело: серия толчков и отброс меняют её", () => {
    const { world, slot } = withStalker(300, 0);
    frozen(world);
    const before = checksumWorld(world);
    damageEnemy(world, slot, 5, 0);
    const afterPush = checksumWorld(world);
    expect(afterPush).not.toBe(before);
    world.player.knockbackTicks = 5;
    world.player.knockbackVx = 3;
    expect(checksumWorld(world)).not.toBe(afterPush);
  });

  it("мир без Карачуна считает ту же сумму, что и до задачи: тело в неё не входит", () => {
    const a = makeWorld();
    const b = makeWorld({}, undefined);
    expect(checksumWorld(a)).toBe(checksumWorld(b));
  });
});

describe("правила тела в контенте", () => {
  function problems(mutate: (body: StalkerBodyDef) => StalkerBodyDef, enemy: EnemyDef = KARACHUN): string[] {
    return findStalkerProblems({ ...STALKER, enemy: enemy.id, body: mutate(structuredClone(BODY)) }, [RAT, enemy]);
  }

  it("числа из контента проходят проверку, как и контент в целом", () => {
    expect(findStalkerProblems(STALKER, ENEMIES)).toEqual([]);
    expect(findContentProblems(CONTENT_SNAPSHOT)).toEqual([]);
    expect(CONTENT_SNAPSHOT.stalker).toBe(STALKER);
  });

  it("враг Карачун есть в контенте и на паттерне stalker", () => {
    const def = ENEMIES.find((enemy) => enemy.id === STALKER.enemy);
    expect(def?.pattern).toBe("stalker");
    expect(def?.hp).toBe(1);
  });

  it("называет поле: враг не найден или не того паттерна", () => {
    expect(findStalkerProblems({ ...STALKER, enemy: "nobody" }, ENEMIES).join("\n")).toContain("stalker.enemy");
    expect(findStalkerProblems({ ...STALKER, enemy: "swarm_rat" }, ENEMIES).join("\n")).toContain("stalker.enemy");
  });

  it("враг с опытом, уроном, рангом, сопротивлением, стихией или размером — ошибка", () => {
    for (const patch of [{ xp: 1 }, { damage: 1 }, { rank: "elite" as const }, { resist: { fire: 0.5 } }, { element: "fire" as const }, { size: 1.2 }]) {
      const text = problems((body) => body, { ...KARACHUN, ...patch }).join("\n");
      expect(text, JSON.stringify(patch)).toContain(Object.keys(patch)[0]);
    }
  });

  it.each([
    ["touchMaxHpShare", (b: StalkerBodyDef) => ({ ...b, touchMaxHpShare: 0.05 })],
    ["touchMaxHpShare", (b: StalkerBodyDef) => ({ ...b, touchMaxHpShare: 0.7 })],
    ["knockback.distance", (b: StalkerBodyDef) => ({ ...b, knockback: { ...b.knockback, distance: 250 } })],
    ["knockback.distance", (b: StalkerBodyDef) => ({ ...b, knockback: { ...b.knockback, distance: -1 } })],
    ["knockback.sec", (b: StalkerBodyDef) => ({ ...b, knockback: { ...b.knockback, sec: 0.01 } })],
    ["knockback.sec", (b: StalkerBodyDef) => ({ ...b, knockback: { ...b.knockback, sec: 0.8 } })],
    ["touchCooldownSec", (b: StalkerBodyDef) => ({ ...b, touchCooldownSec: 0.2 })],
    ["touchCooldownSec", (b: StalkerBodyDef) => ({ ...b, touchCooldownSec: 11 })],
    ["recoverSec", (b: StalkerBodyDef) => ({ ...b, recoverSec: b.touchCooldownSec + 1 })],
    ["recoverSec", (b: StalkerBodyDef) => ({ ...b, recoverSec: -1 })],
    ["push.first", (b: StalkerBodyDef) => ({ ...b, push: { ...b.push, first: 0 } })],
    ["push.first", (b: StalkerBodyDef) => ({ ...b, push: { ...b.push, first: 81 } })],
    ["push.decay", (b: StalkerBodyDef) => ({ ...b, push: { ...b.push, decay: 1 } })],
    ["push.decay", (b: StalkerBodyDef) => ({ ...b, push: { ...b.push, decay: 0 } })],
    ["push.seriesResetSec", (b: StalkerBodyDef) => ({ ...b, push: { ...b.push, seriesResetSec: 0.05 } })],
    ["push.seriesResetSec", (b: StalkerBodyDef) => ({ ...b, push: { ...b.push, seriesResetSec: 4 } })],
    ["push.maxPerSec", (b: StalkerBodyDef) => ({ ...b, push: { ...b.push, maxPerSec: 0 } })],
    ["push.maxPerSec", (b: StalkerBodyDef) => ({ ...b, push: { ...b.push, maxPerSec: 67 } })],
    ["touchMaxHpShare", (b: StalkerBodyDef) => ({ ...b, touchMaxHpShare: Number.NaN })],
  ])("число %s вне коридора — ошибка называет поле", (field, mutate) => {
    const text = problems(mutate).join("\n");
    expect(text).toContain(`stalker.${field}`);
  });

  it("maxPerSec ровно 0,6 скорости врага допустим, чуть больше — нет", () => {
    expect(problems((b) => ({ ...b, push: { ...b.push, maxPerSec: 66 } }))).toEqual([]);
    expect(problems((b) => ({ ...b, push: { ...b.push, maxPerSec: 66.1 } })).join("\n")).toContain("stalker.push.maxPerSec");
  });

  it("createWorld не принимает невалидные правила тела", () => {
    const body: StalkerBodyDef = { ...BODY, touchMaxHpShare: 5 };
    expect(() => makeWorld({}, { ...STALKER, body })).toThrow(/stalker\.touchMaxHpShare/);
  });
});

describe("Карачун и таймлайн", () => {
  const firstSegment = TIMELINE[0];
  const rest = TIMELINE.slice(1);
  const MESSAGE = /преследователь karachun не приходит таймлайном: его выпускает директор преследователя/;

  it("контент без преследователя в таймлайне чист", () => {
    expect(findTimelineProblems(TIMELINE, ENDLESS_CURVE, ENEMIES)).toEqual([]);
  });

  it("в потоке — ошибка с именем", () => {
    const segment = { ...firstSegment, spawns: [...firstSegment.spawns, { enemy: "karachun", perSec: 1 }] };
    expect(findTimelineProblems([segment, ...rest], ENDLESS_CURVE, ENEMIES).join("\n")).toMatch(MESSAGE);
  });

  it("в выбросе — ошибка с именем", () => {
    const segment = { ...firstSegment, spawns: [...firstSegment.spawns, { enemy: "karachun", burst: 2 }] };
    expect(findTimelineProblems([segment, ...rest], ENDLESS_CURVE, ENEMIES).join("\n")).toMatch(MESSAGE);
  });

  it("в событиях ring и flank — ошибка с именем", () => {
    for (const kind of ["ring", "flank"] as const) {
      const segment = { ...firstSegment, events: [...(firstSegment.events ?? []), { kind, enemy: "karachun", count: 1 }] };
      expect(findTimelineProblems([segment, ...rest], ENDLESS_CURVE, ENEMIES).join("\n"), kind).toMatch(MESSAGE);
    }
  });

  it("в событии cordon и внутри строя — ошибка с именем", () => {
    const ring = { radius: 300, minRadius: 100, shrinkPerSec: 8, lifeSec: 45 };
    const asGuard = { ...firstSegment, events: [{ kind: "cordon" as const, enemy: "karachun", count: 4, ring }] };
    expect(findTimelineProblems([asGuard, ...rest], ENDLESS_CURVE, ENEMIES).join("\n")).toMatch(MESSAGE);

    const inside = {
      ...firstSegment,
      events: [{ kind: "cordon" as const, enemy: "cordon_guard", count: 24, ring: { ...ring, inner: [{ enemy: "karachun", count: 1 }] } }],
    };
    expect(findTimelineProblems([inside, ...rest], ENDLESS_CURVE, ENEMIES).join("\n")).toMatch(MESSAGE);
  });

  it("в смеси кривой и в событиях кривой — ошибка с именем", () => {
    const pool = { ...ENDLESS_CURVE, pool: [...ENDLESS_CURVE.pool, "karachun"] };
    expect(findTimelineProblems(TIMELINE, pool, ENEMIES).join("\n")).toMatch(MESSAGE);

    const events = { ...ENDLESS_CURVE, events: [...ENDLESS_CURVE.events, { kind: "flank" as const, enemy: "karachun", count: 1, everySegments: 1 }] };
    expect(findTimelineProblems(TIMELINE, events, ENEMIES).join("\n")).toMatch(MESSAGE);
  });
});
