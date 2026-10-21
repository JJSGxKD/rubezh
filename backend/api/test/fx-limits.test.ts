import type { Tariff } from "@bh/fx";
import { describe, expect, it } from "vitest";
import { applyLimits, crossedThresholds, effectiveTariff, usedShare } from "../src/modules/fx/fx-limits.js";

/**
 * Лимит источника курсов из панели (docs/35-stage4-plan.md, Р89, T-0062):
 * чистые функции без базы — тариф из кода и заданный в панели лимит, пороги
 * 80% и 100% между двумя значениями счётчика.
 */

const DEMO: Tariff = { name: "demo", perMinute: 30, perMonth: 10_000, minIntervalMs: 300_000 };

describe("тариф с лимитом из панели", () => {
  it("строки в панели нет — тариф как есть", () => {
    expect(effectiveTariff(DEMO, undefined)).toEqual(DEMO);
  });

  it("задан лимит — меняется только месячный, остальное прежнее", () => {
    expect(effectiveTariff(DEMO, { perMonth: 20_000 })).toEqual({ name: "demo", perMinute: 30, perMonth: 20_000, minIntervalMs: 300_000 });
  });

  it("«без лимита» — тоже значение: месячного лимита нет", () => {
    expect(effectiveTariff(DEMO, { perMonth: null })).toEqual({ ...DEMO, perMonth: null });
  });

  it("тариф из кода не мутируется", () => {
    effectiveTariff(DEMO, { perMonth: 1 });
    expect(DEMO.perMonth).toBe(10_000);
  });
});

describe("пороги расхода", () => {
  it("80% перейдён одним опросом", () => {
    expect(crossedThresholds(7_999, 8_000, 10_000)).toEqual([80]);
  });

  it("за один проход перейдены оба порога", () => {
    expect(crossedThresholds(7_000, 10_000, 10_000)).toEqual([80, 100]);
  });

  it("между порогами ничего не перейдено", () => {
    expect(crossedThresholds(8_500, 9_000, 10_000)).toEqual([]);
  });

  it("порог уже был за спиной — повторно не называется", () => {
    expect(crossedThresholds(8_000, 8_001, 10_000)).toEqual([]);
    expect(crossedThresholds(9_999, 10_000, 10_000)).toEqual([100]);
    expect(crossedThresholds(10_000, 10_001, 10_000)).toEqual([]);
  });

  it("без месячного лимита порогов нет", () => {
    expect(crossedThresholds(0, 1_000_000, null)).toEqual([]);
  });

  it("счётчик не вырос или упал — порогов нет", () => {
    expect(crossedThresholds(5_000, 5_000, 10_000)).toEqual([]);
    expect(crossedThresholds(9_000, 100, 10_000)).toEqual([]);
  });

  it("лимит в одну единицу: первый же запрос — и 80%, и 100%", () => {
    expect(crossedThresholds(0, 1, 1)).toEqual([80, 100]);
  });

  it("порог 80% считается целыми числами: 8 из 10, а не 0,7999 из 1", () => {
    expect(crossedThresholds(7, 8, 10)).toEqual([80]);
    expect(crossedThresholds(3, 4, 5)).toEqual([80]);
  });
});

describe("доля израсходованного", () => {
  it("доля от лимита; без лимита её нет", () => {
    expect(usedShare(6_120, 10_000)).toBeCloseTo(0.612, 6);
    expect(usedShare(0, 10_000)).toBe(0);
    expect(usedShare(500, null)).toBeNull();
  });

  it("сверх лимита доля больше единицы — счётчик разошёлся с лимитом, это видно", () => {
    expect(usedShare(12_000, 10_000)).toBeCloseTo(1.2, 6);
  });
});

describe("подмена тарифа у источников", () => {
  const source = (id: string, tariff: Tariff) => ({ id, tariff, currencies: [], fetch: async () => [] });

  it("источник получает новый объект с новым тарифом, прежний не меняется", () => {
    const original = source("coingecko", DEMO);
    const [changed] = applyLimits([original], new Map([["coingecko", { perMonth: 500 }]]));
    expect(changed).not.toBe(original);
    expect(changed?.tariff.perMonth).toBe(500);
    expect(changed?.fetch).toBe(original.fetch);
    expect(original.tariff.perMonth).toBe(10_000);
  });

  it("у источника без строки в панели — тот же источник", () => {
    const original = source("cbr", DEMO);
    const [same] = applyLimits([original], new Map([["coingecko", { perMonth: 500 }]]));
    expect(same).toBe(original);
  });
});
