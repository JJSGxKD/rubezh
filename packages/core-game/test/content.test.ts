import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { WAVES } from "../src/content/waves";
import { UPGRADES } from "../src/content/upgrades";
import { IMPLEMENTED_PATTERNS } from "../src/game/patterns";

// Дешёвые тесты, ловящие опечатки в контенте за миллисекунды
// (docs/17-testing-strategy.md §3.1). Геймдизайнер узнаёт об ошибке из CI
// через минуту, а не из ручного плейтеста через день.

describe("контент врагов", () => {
  it("не содержит дублирующихся id", () => {
    const ids = ENEMIES.map((enemy) => enemy.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("использует только реализованные паттерны поведения", () => {
    for (const enemy of ENEMIES) {
      expect(IMPLEMENTED_PATTERNS, `враг ${enemy.id}`).toContain(enemy.pattern);
    }
  });

  it("держит числовые поля в осмысленных границах", () => {
    for (const enemy of ENEMIES) {
      expect(enemy.hp, `hp врага ${enemy.id}`).toBeGreaterThan(0);
      expect(enemy.speed, `speed врага ${enemy.id}`).toBeGreaterThan(0);
      expect(enemy.damage, `damage врага ${enemy.id}`).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("контент волн", () => {
  it("ссылается только на существующих врагов", () => {
    const known = new Set(ENEMIES.map((enemy) => enemy.id));
    for (const wave of WAVES) {
      for (const spawn of wave.spawns) {
        expect(known, `волна на ${wave.second}s`).toContain(spawn.enemy);
      }
    }
  });

  it("не содержит пустых волн и спавнов нулевого размера", () => {
    for (const wave of WAVES) {
      expect(wave.spawns.length, `волна на ${wave.second}s`).toBeGreaterThan(0);
      for (const spawn of wave.spawns) {
        expect(spawn.count, `спавн ${spawn.enemy}`).toBeGreaterThan(0);
      }
    }
  });

  it("идёт по строго возрастающей секунде", () => {
    for (let i = 1; i < WAVES.length; i++) {
      expect(WAVES[i].second).toBeGreaterThan(WAVES[i - 1].second);
    }
  });
});

describe("контент апгрейдов", () => {
  it("не содержит дублирующихся id", () => {
    const ids = UPGRADES.map((upgrade) => upgrade.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("задаёт положительное число стаков там, где оно указано", () => {
    for (const upgrade of UPGRADES) {
      if (upgrade.maxStacks === undefined) continue;
      expect(upgrade.maxStacks, `апгрейд ${upgrade.id}`).toBeGreaterThan(0);
    }
  });
});
