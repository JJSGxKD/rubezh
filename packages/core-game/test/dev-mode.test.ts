import { describe, expect, it } from "vitest";
import { DROPS } from "../src/content/drops";
import { ENEMIES } from "../src/content/enemies";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
import { applyDevCommand } from "../src/game/run/dev-commands";
import { damageEnemy } from "../src/game/sim/combat";
import { IDLE_INPUT, stepWorld } from "../src/game/sim/step";
import {
  createWorld,
  damagePlayer,
  hasActiveCheats,
  NO_CHEATS,
  NO_OWNER_TYPE,
  spawnEnemy,
  TICK_SEC,
  type World,
} from "../src/game/sim/world";

// Режим разработчика: читы в симуляции и разовые команды (docs/26-stage2-plan.md, WP14).

function world(): World {
  return createWorld({
    seed: 3,
    enemies: ENEMIES,
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    drops: DROPS,
    startingWeaponId: "spark",
  });
}

function typeIndex(target: World, id: string): number {
  return target.enemyTypes.findIndex((type) => type.id === id);
}

function aliveEnemies(target: World): number[] {
  const result: number[] = [];
  for (let i = 0; i < target.enemies.count; i++) if (target.enemies.alive[i] === 1) result.push(i);
  return result;
}

describe("читы в симуляции", () => {
  it("у обычного забега нейтральны", () => {
    const target = world();
    expect(target.cheats).toEqual(NO_CHEATS);
    expect(hasActiveCheats(target.cheats)).toBe(false);
  });

  it("бессмертие не отнимает здоровья, но попадание остаётся событием", () => {
    const target = world();
    target.cheats.godMode = true;
    const written = target.events.written;
    damagePlayer(target, 500, 0);
    expect(target.player.hp).toBe(target.player.maxHp);
    expect(target.player.alive).toBe(true);
    expect(target.events.written).toBe(written + 1);
  });

  it("убийство с одного удара и множитель урона", () => {
    const target = world();
    const tank = spawnEnemy(target, typeIndex(target, "tank_ghoul"), 400, 0);
    target.cheats.damageMul = 3;
    damageEnemy(target, tank, 10, NO_OWNER_TYPE);
    expect(target.enemies.hp[tank]).toBeCloseTo(60 - 30);

    target.cheats.oneHitKill = true;
    damageEnemy(target, tank, 1, NO_OWNER_TYPE);
    expect(target.enemies.alive[tank]).toBe(0);
    expect(target.stats.damageDealt).toBeCloseTo(60);
  });

  it("множитель скорости разгоняет игрока, заморозка останавливает врагов", () => {
    const normal = world();
    const fast = world();
    fast.cheats.moveSpeedMul = 2;
    for (let i = 0; i < 60; i++) {
      stepWorld(normal, { moveX: 1, moveY: 0 });
      stepWorld(fast, { moveX: 1, moveY: 0 });
    }
    expect(fast.player.x).toBeGreaterThan(normal.player.x * 1.8);

    const frozen = world();
    frozen.cheats.freezeEnemies = true;
    const rat = spawnEnemy(frozen, typeIndex(frozen, "swarm_rat"), 150, 0);
    const x = frozen.enemies.x[rat];
    for (let i = 0; i < 30; i++) stepWorld(frozen, IDLE_INPUT);
    expect(frozen.enemies.x[rat]).toBe(x);
  });
});

describe("команды разработчика", () => {
  it("выдаёт оружие сверх лимита слотов и не теряет его урон в статистике", () => {
    const target = world();
    for (const weapon of WEAPONS) {
      expect(applyDevCommand(target, { kind: "giveWeapon", id: weapon.id, level: 99 })).toEqual({ applied: true, cheat: true });
    }
    expect(target.loadout.weapons).toHaveLength(WEAPONS.length);
    expect(target.loadout.weapons.every((slot) => slot.level === target.weaponTypes[slot.typeIndex]?.levels.length)).toBe(true);
    expect(target.stats.damageByWeapon.length).toBeGreaterThanOrEqual(WEAPONS.length);
    expect(applyDevCommand(target, { kind: "giveWeapon", id: "nope", level: 1 }).applied).toBe(false);
  });

  it("выдаёт пассивку и сразу пересчитывает характеристики", () => {
    const target = world();
    const before = target.playerStats.damageMul;
    applyDevCommand(target, { kind: "givePassive", id: "might", level: 3 });
    expect(target.playerStats.damageMul).toBeGreaterThan(before);
  });

  it("поднимает уровень и сразу готовит выбор", () => {
    const target = world();
    applyDevCommand(target, { kind: "levelUp", count: 2 });
    expect(target.progression.level).toBe(3);
    expect(target.progression.offers.length).toBeGreaterThan(0);
  });

  it("ставит врагов кольцом рядом с игроком, а подбор — не под ноги", () => {
    const target = world();
    applyDevCommand(target, { kind: "spawnEnemy", id: "elite_ghoul", count: 4 });
    const spawned = aliveEnemies(target);
    expect(spawned).toHaveLength(4);
    for (const index of spawned) {
      const distance = Math.sqrt(target.enemies.x[index] ** 2 + target.enemies.y[index] ** 2);
      expect(distance).toBeCloseTo(220 * target.config.unitScale, 0);
    }

    applyDevCommand(target, { kind: "spawnPickup", pickup: "dynamite" });
    const slot = target.pickups.alive.indexOf(1);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(Math.abs(target.pickups.x[slot] ?? 0) + Math.abs(target.pickups.y[slot] ?? 0)).toBeGreaterThan(target.playerStats.pickupRadius);
  });

  it("очищает поле с добычей и лечит", () => {
    const target = world();
    applyDevCommand(target, { kind: "spawnEnemy", id: "swarm_rat", count: 10 });
    target.player.hp = 1;
    expect(applyDevCommand(target, { kind: "killAll" }).applied).toBe(true);
    expect(aliveEnemies(target)).toHaveLength(0);
    expect(target.gems.aliveCount).toBeGreaterThan(0);
    applyDevCommand(target, { kind: "heal" });
    expect(target.player.hp).toBe(target.playerStats.maxHp);
  });

  it("перематывает часы вперёд, но не назад, и очищает поле без добычи", () => {
    const target = world();
    applyDevCommand(target, { kind: "spawnEnemy", id: "swarm_rat", count: 5 });
    expect(applyDevCommand(target, { kind: "jumpToMinute", minute: 7 }).applied).toBe(true);
    expect(target.stats.elapsedSec).toBeCloseTo(420);
    expect(target.stats.tick).toBe(Math.round(420 / TICK_SEC));
    expect(aliveEnemies(target)).toHaveLength(0);
    expect(target.gems.aliveCount).toBe(0);
    expect(applyDevCommand(target, { kind: "jumpToMinute", minute: 3 }).applied).toBe(false);
  });

  it("шаг по тикам исполняет сцена, а не мир", () => {
    expect(applyDevCommand(world(), { kind: "stepTicks", ticks: 5 })).toEqual({ applied: false, cheat: false });
  });
});
