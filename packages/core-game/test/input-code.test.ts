import { describe, expect, it } from "vitest";
import { DIRECTION_CODES, IDLE_CODE, inputOfCode, quantizeDirection } from "../src/game/sim/input-code";

const input = (code: number) => inputOfCode(code, { moveX: 0, moveY: 0 });

describe("квантование направления", () => {
  it("каждый из 256 кодов переходит в свою точку и обратно без потерь", () => {
    const points = new Set<string>();
    for (let code = 0; code < DIRECTION_CODES; code++) {
      const { moveX, moveY } = input(code);
      expect(Math.max(Math.abs(moveX), Math.abs(moveY))).toBe(32);
      points.add(`${moveX},${moveY}`);
      expect(quantizeDirection(moveX, moveY, IDLE_CODE)).toBe(code);
    }
    expect(points.size).toBe(DIRECTION_CODES);
  });

  it("клавиатура попадает в точки без округления", () => {
    expect(input(quantizeDirection(1, 0, IDLE_CODE))).toEqual({ moveX: 32, moveY: 0 });
    expect(input(quantizeDirection(1, 1, IDLE_CODE))).toEqual({ moveX: 32, moveY: 32 });
    expect(input(quantizeDirection(-1, -1, IDLE_CODE))).toEqual({ moveX: -32, moveY: -32 });
    expect(input(quantizeDirection(0, -1, IDLE_CODE))).toEqual({ moveX: 0, moveY: -32 });
  });

  it("длина вектора не влияет, нулевой и битый вектор — покой", () => {
    expect(quantizeDirection(0.3, -0.2, IDLE_CODE)).toBe(quantizeDirection(300, -200, IDLE_CODE));
    expect(quantizeDirection(0, 0, 5)).toBe(IDLE_CODE);
    expect(quantizeDirection(Number.NaN, 1, IDLE_CODE)).toBe(IDLE_CODE);
    expect(input(IDLE_CODE)).toEqual({ moveX: 0, moveY: 0 });
  });

  it("направление почти вдоль оси вправо сверху не уходит в код 256", () => {
    expect(quantizeDirection(1, -0.001, IDLE_CODE)).toBe(32);
    expect(quantizeDirection(1, -0.999, IDLE_CODE)).toBe(0);
    expect(quantizeDirection(0.999, -1, IDLE_CODE)).toBe(0);
  });

  it("дрожь пальца на границе двух направлений не переключает код", () => {
    // Середина между кодами 10 и 11 на правой стороне: y = 10.5 - 32.
    let code = quantizeDirection(32, -21.4, IDLE_CODE);
    const seen = new Set<number>();
    for (let frame = 0; frame < 200; frame++) {
      // Запас гистерезиса — четверть шага за серединой: дрожь в его пределах не видна.
      const jitter = frame % 2 === 0 ? 0.2 : -0.2;
      code = quantizeDirection(32, -21.5 + jitter, code);
      seen.add(code);
    }
    expect(seen.size).toBe(1);
    // Настоящий поворот пальца переключает сразу.
    expect(quantizeDirection(32, -19, code)).toBe(13);
  });

  it("гистерезис работает и через ноль оборота", () => {
    const code = quantizeDirection(32, -32, IDLE_CODE);
    expect(code).toBe(0);
    // Чуть левее угла — это верхняя сторона, код 255.6, но до нуля ближе запаса.
    expect(quantizeDirection(31.6, -32, code)).toBe(0);
    expect(quantizeDirection(30, -32, code)).toBe(254);
  });
});
