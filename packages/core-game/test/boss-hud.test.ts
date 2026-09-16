import type { EnemyDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { createWorld, spawnEnemy, type World } from "../src/game/sim/world";
import { damageEnemy } from "../src/game/sim/combat";
import { BOSS_PHASES, bossPhase, buildBossSnapshot } from "../src/game/run/boss";

// Полоса здоровья босса: только у босса, с фазами от остатка здоровья.

const RAT: EnemyDef = { id: "rat", hp: 10, speed: 1, damage: 1, xp: 1, pattern: "swarm" };
const ELITE: EnemyDef = { id: "elite_rat", hp: 100, speed: 1, damage: 1, xp: 5, rank: "elite", pattern: "swarm" };
const BOSS: EnemyDef = { id: "maw", hp: 200, speed: 1, damage: 1, xp: 20, rank: "boss", pattern: "swarm" };

function world(): World {
  return createWorld({ seed: 1, enemies: [RAT, ELITE, BOSS], config: { progressionEnabled: false } });
}

describe("полоса босса", () => {
  it("пуста, пока на поле нет босса: элита полосы не получает", () => {
    const w = world();
    spawnEnemy(w, 0, 200, 0);
    spawnEnemy(w, 1, 220, 0);

    expect(buildBossSnapshot(w)).toBeNull();
  });

  it("показывает имя, остаток и число фаз", () => {
    const w = world();
    const boss = spawnEnemy(w, 2, 200, 0);

    expect(buildBossSnapshot(w)).toEqual({
      enemyId: "maw",
      hp: w.enemies.hp[boss],
      maxHp: w.enemies.maxHp[boss],
      phase: 0,
      phases: BOSS_PHASES,
    });
  });

  it("меряет долю от здоровья, с которым босс вышел, а не от числа в контенте", () => {
    const w = world();
    // Директор спавна выставляет множители отрезка перед спавном — повторяем
    // ровно это: полоса обязана мерить от того здоровья, что босс получил.
    w.difficulty.hpMul = 2;
    spawnEnemy(w, 2, 200, 0);

    expect(buildBossSnapshot(w)?.maxHp).toBe(BOSS.hp * 2);
  });

  it("переходит в следующую фазу, когда здоровье падает за порог", () => {
    const w = world();
    const boss = spawnEnemy(w, 2, 200, 0);

    damageEnemy(w, boss, BOSS.hp * 0.4, 0);
    expect(buildBossSnapshot(w)?.phase).toBe(1);

    damageEnemy(w, boss, BOSS.hp * 0.3, 0);
    expect(buildBossSnapshot(w)?.phase).toBe(2);
  });

  it("исчезает, когда босс убит", () => {
    const w = world();
    const boss = spawnEnemy(w, 2, 200, 0);
    damageEnemy(w, boss, BOSS.hp * 10, 0);

    expect(buildBossSnapshot(w)).toBeNull();
  });

  it("фазы считаются по долям, а не по числам здоровья", () => {
    expect(bossPhase(1)).toBe(0);
    expect(bossPhase(0.5)).toBe(1);
    expect(bossPhase(0.1)).toBe(2);
  });
});
