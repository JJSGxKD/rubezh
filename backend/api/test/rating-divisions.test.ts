import { describe, expect, it } from "vitest";
import { DIVISION_PERCENT, DIVISIONS, divisionCaseSql, divisionOf } from "../src/modules/rating/division-rules.js";
import { MIN_STYLE_RUNS, STYLE_RUNS, summarizeStyle } from "../src/modules/rating/player-style.service.js";
import type { AxisValues } from "../src/modules/rating/score-rules.js";

/**
 * Дивизионы сезона по доле доски и «Твой стиль» — чистые правила (tasks/T-0295,
 * Р152, design/art/meta-v2.md §2.3–2.4). База и Redis — в
 * `rating-style.integration.test.ts`: здесь каждая граница проверяется отдельно.
 */

describe("дивизион по месту и размеру доски", () => {
  it("доска в 1 000: 10-е — рубин, 11-е — золото, 100-е — золото, 101-е — серебро, 350-е — серебро, 351-е — бронза", () => {
    expect(divisionOf(10, 1_000)).toBe("ruby");
    expect(divisionOf(11, 1_000)).toBe("gold");
    expect(divisionOf(100, 1_000)).toBe("gold");
    expect(divisionOf(101, 1_000)).toBe("silver");
    expect(divisionOf(350, 1_000)).toBe("silver");
    expect(divisionOf(351, 1_000)).toBe("bronze");
    expect(divisionOf(1_000, 1_000)).toBe("bronze");
  });

  it("первое место — рубин на любой доске: из одного игрока, из трёх и из миллиона", () => {
    expect(divisionOf(1, 1)).toBe("ruby");
    expect(divisionOf(1, 3)).toBe("ruby");
    expect(divisionOf(1, 99)).toBe("ruby");
    expect(divisionOf(1, 1_000_000)).toBe("ruby");
  });

  it("доска из трёх: второй — серебро, третий — бронза, потому что доли округляются вверх", () => {
    // ceil(0,01 × 3) = 1, ceil(0,10 × 3) = 1, ceil(0,35 × 3) = 2
    expect(divisionOf(2, 3)).toBe("silver");
    expect(divisionOf(3, 3)).toBe("bronze");
  });

  it("доли считаются целыми числами: 35 % от 20 — ровно 7, а не 8 из-за плавающей точки", () => {
    // 0,35 × 20 в двойной точности даёт 7,000000000000001, и потолок поднял бы границу.
    expect(divisionOf(7, 20)).toBe("silver");
    expect(divisionOf(8, 20)).toBe("bronze");
    expect(divisionOf(2, 20)).toBe("gold");
    expect(divisionOf(1, 20)).toBe("ruby");
  });

  it("нет забега — нет дивизиона", () => {
    expect(divisionOf(null, 1_000)).toBeNull();
    expect(divisionOf(null, 0)).toBeNull();
  });

  it("место вне доски (нуль, минус, дробь, больше размера, пустая доска) — не дивизион, а null", () => {
    expect(divisionOf(0, 10)).toBeNull();
    expect(divisionOf(-1, 10)).toBeNull();
    expect(divisionOf(1.5, 10)).toBeNull();
    expect(divisionOf(11, 10)).toBeNull();
    expect(divisionOf(1, 0)).toBeNull();
  });

  it("доли — постоянные модуля: рубин 1 %, золото 10 %, серебро 35 %, порядок от высшего", () => {
    expect(DIVISIONS).toEqual(["ruby", "gold", "silver", "bronze"]);
    expect(DIVISION_PERCENT).toEqual({ ruby: 1, gold: 10, silver: 35 });
  });

  it("запрос закрытия сезона строится из тех же долей, что и чтение", () => {
    const sql = divisionCaseSql();
    for (const division of DIVISIONS) expect(sql.sql).toContain(`'${division}'`);
    expect(sql.values).toEqual([DIVISION_PERCENT.ruby, DIVISION_PERCENT.gold, DIVISION_PERCENT.silver]);
  });
});

/** Оси забега: единица, кроме названных. */
function axes(patch: Partial<AxisValues>): AxisValues {
  return { t: 1, k: 1, h: 1, c: 1, b: 1, ...patch };
}

describe("«Твой стиль» по последним рейтинговым забегам", () => {
  it("предел — десять забегов, минимум для вывода — три", () => {
    expect(STYLE_RUNS).toBe(10);
    expect(MIN_STYLE_RUNS).toBe(3);
  });

  it("меньше трёх забегов — оси и стиль пусты, сказано, сколько сыграть ещё", () => {
    expect(summarizeStyle([], 3)).toEqual({ style: null, strong: null, weak: null, axes: null, runs: 0, missing: 3 });
    expect(summarizeStyle([axes({ k: 2 })], 3)).toMatchObject({ style: null, runs: 1, missing: 2 });
    expect(summarizeStyle([axes({ k: 2 }), axes({ k: 2 })], 3)).toEqual({ style: null, strong: null, weak: null, axes: null, runs: 2, missing: 1 });
  });

  it("три забега — стиль есть: сильная ось с наибольшим средним, слабая с наименьшим", () => {
    const runs = [axes({ t: 1.2, k: 1.8, h: 0.9, c: 0.4 }), axes({ t: 1.0, k: 1.6, h: 1.1, c: 0.6 }), axes({ t: 1.1, k: 2.0, h: 1.0, c: 0.5 })];
    const result = summarizeStyle(runs, 3);
    expect(result).toMatchObject({ style: "k", strong: "k", weak: "c", runs: 3, missing: 0 });
    expect(result.axes).toEqual({ t: 1.1, k: 1.8, h: 1, c: 0.5, b: 1 });
  });

  it("индекс режется потолком до усреднения: один выброс среднего не делает", () => {
    // Охота 9, 1, 1 с потолком 3 даёт (3 + 1 + 1) / 3, а не 3,667.
    const result = summarizeStyle([axes({ h: 9 }), axes({ h: 1 }), axes({ h: 1 })], 3);
    expect(result.axes?.h).toBeCloseTo(1.667, 3);
  });

  it("при равенстве сильной берётся первая ось по порядку t, k, h, c, b, слабой — последняя", () => {
    const flat = summarizeStyle([axes({}), axes({}), axes({})], 3);
    expect(flat).toMatchObject({ strong: "t", weak: "b" });
    const tied = axes({ h: 1.5, c: 1.5, k: 0.5, b: 0.5 });
    expect(summarizeStyle([tied, tied, tied], 3)).toMatchObject({ strong: "h", weak: "b" });
  });

  it("оси в ответе — с тремя знаками", () => {
    const result = summarizeStyle([axes({ k: 1 }), axes({ k: 1 }), axes({ k: 1.5 })], 3);
    expect(result.axes?.k).toBe(1.167);
  });
});
