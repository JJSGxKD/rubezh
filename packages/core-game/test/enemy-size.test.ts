import type { EnemyDef, EnemyPattern } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import {
  BOSS_RADIUS_MUL,
  ELITE_RADIUS_MUL,
  ENEMY_SIZE_MAX,
  ENEMY_SIZE_MIN,
  MAX_PATTERN_RADIUS,
  PATTERN_TRAITS,
  findEnemyContentProblems,
  resolveEnemyTypes,
} from "../src/game/patterns/enemy-types";

// Поле `size` у врага (tasks/T-0229): множитель радиуса поверх радиуса паттерна
// и ранга. Не задан — размер прежний, поэтому golden-тесты баланса не меняются.

const UNIT_SCALE = 1.5;

type Patch = Partial<Omit<EnemyDef, "pattern" | "params">>;

function enemy(patch: Patch = {}): EnemyDef {
  return { id: "x", hp: 10, speed: 40, damage: 3, xp: 1, pattern: "rush", ...patch };
}

/** Враг любого паттерна: делящемуся нужны потомки — берём второго врага `y`. */
function enemyOf(pattern: EnemyPattern, patch: Patch): EnemyDef {
  const base = { id: "x", hp: 10, speed: 40, damage: 3, xp: 1, ...patch };
  return pattern === "splitter" ? { ...base, pattern, params: { children: [{ enemy: "y", count: 1 }] } } : { ...base, pattern };
}

function radiusOf(def: EnemyDef): number {
  return resolveEnemyTypes([def], UNIT_SCALE)[0].radius;
}

describe("размер врага: радиус", () => {
  it("без size радиус прежний — обычный, элита и босс", () => {
    const base = PATTERN_TRAITS.rush.radius * UNIT_SCALE;
    expect(radiusOf(enemy())).toBeCloseTo(base, 9);
    expect(radiusOf(enemy({ rank: "elite" }))).toBeCloseTo(base * ELITE_RADIUS_MUL, 9);
    expect(radiusOf(enemy({ rank: "boss" }))).toBeCloseTo(base * BOSS_RADIUS_MUL, 9);
  });

  it("size умножает радиус паттерна и ранга: босс на rush с size 2", () => {
    const expected = PATTERN_TRAITS.rush.radius * BOSS_RADIUS_MUL * 2 * UNIT_SCALE;
    expect(radiusOf(enemy({ rank: "boss", size: 2 }))).toBeCloseTo(expected, 9);
  });

  it("size мельче единицы уменьшает радиус", () => {
    expect(radiusOf(enemy({ size: 0.7 }))).toBeCloseTo(PATTERN_TRAITS.rush.radius * 0.7 * UNIT_SCALE, 9);
  });

  it("size 1 не отличается от незаданного", () => {
    expect(radiusOf(enemy({ size: 1 }))).toBe(radiusOf(enemy()));
  });
});

describe("размер врага: коридор", () => {
  it("границы коридора — 0,7 и 2,5, сами границы допустимы", () => {
    expect(ENEMY_SIZE_MIN).toBe(0.7);
    expect(ENEMY_SIZE_MAX).toBe(2.5);
    expect(findEnemyContentProblems([enemy({ size: 0.7 })])).toEqual([]);
    expect(findEnemyContentProblems([enemy({ size: 2.5 })])).toEqual([]);
  });

  it("size 0,69 и 2,51 — сообщение называет врага и поле", () => {
    for (const size of [0.69, 2.51]) {
      const problems = findEnemyContentProblems([enemy({ id: "big_boy", size })]);
      expect(problems).toEqual(["враг big_boy: size вне 0,7…2,5"]);
    }
  });

  it("не число и отрицательное — тоже ошибка, а не молчаливый нуль", () => {
    for (const size of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(findEnemyContentProblems([enemy({ size })]), String(size)).toHaveLength(1);
    }
  });

  it("мир с size вне коридора не создаётся: ошибка при старте", () => {
    expect(() => resolveEnemyTypes([enemy({ size: 3 })], 1)).toThrow(/size вне 0,7…2,5/);
  });
});

describe("размер врага: запас запросов к сетке", () => {
  it("MAX_PATTERN_RADIUS не меньше радиуса любого врага с size из коридора", () => {
    for (const pattern of Object.keys(PATTERN_TRAITS) as EnemyPattern[]) {
      for (const rank of [undefined, "elite", "boss"] as const) {
        const type = resolveEnemyTypes([enemyOf(pattern, { rank, size: ENEMY_SIZE_MAX }), enemy({ id: "y" })], 1)[0];
        expect(type.radius, `${pattern}/${rank ?? "normal"}`).toBeLessThanOrEqual(MAX_PATTERN_RADIUS);
      }
    }
  });

  it("запас считается с верхом коридора и боссом, а не с обычным радиусом", () => {
    const largest = Math.max(...Object.values(PATTERN_TRAITS).map((traits) => traits.radius));
    expect(MAX_PATTERN_RADIUS).toBeCloseTo(largest * BOSS_RADIUS_MUL * ENEMY_SIZE_MAX, 9);
  });
});
