import { describe, expect, it } from "vitest";
import { boostCost, boostToDescribe, boostTileState, preRunModes } from "../src/screens/pre-run-rules";

// Правила листа «Перед забегом» (docs/35-stage4-plan.md, Р88): вкладки режимов,
// состояние плиток бустов, сумма к списанию и что описывать под плитками.

const CATALOG = [
  { id: "fury", resource: "coins", amount: 120 },
  { id: "aegis", resource: "coins", amount: 150 },
  { id: "lure", resource: "coins", amount: 90 },
  { id: "head_start", resource: "gems", amount: 4 },
  { id: "insight", resource: "gems", amount: 6 },
] as const;

const price = (id: string) => {
  const found = CATALOG.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`нет цены ${id}`);
  return { resource: found.resource, amount: found.amount };
};

const tile = (id: string, selected: string[], balances: { coins: number; gems: number } | null, maxPerRun = 3) =>
  boostTileState({ id, selected, price: price(id), catalog: CATALOG, balances, maxPerRun });

describe("вкладки режимов", () => {
  it("без доступа вкладок нет вовсе", () => {
    expect(preRunModes({ devMode: false, stressTest: false })).toEqual([]);
  });

  it("только разработчика — «Бесконечный» и «Разработчика»", () => {
    expect(preRunModes({ devMode: true, stressTest: false })).toEqual(["endless", "dev"]);
  });

  it("оба — три вкладки", () => {
    expect(preRunModes({ devMode: true, stressTest: true })).toEqual(["endless", "dev", "stress"]);
  });

  it("только стресс — «Бесконечный» и «Стресс»", () => {
    expect(preRunModes({ devMode: false, stressTest: true })).toEqual(["endless", "stress"]);
  });
});

describe("состояние плитки буста", () => {
  const rich = { coins: 1000, gems: 100 };

  it("свободная плитка при деньгах не выбрана и не приглушена", () => {
    expect(tile("fury", [], rich)).toEqual({ chosen: false, disabled: false });
  });

  it("выбранная плитка не приглушается, даже если денег уже не хватает", () => {
    expect(tile("fury", ["fury"], { coins: 0, gems: 0 })).toEqual({ chosen: true, disabled: false });
  });

  it("на трёх из трёх остальные приглушены, выбранные — нет", () => {
    const selected = ["fury", "aegis", "head_start"];
    expect(tile("lure", selected, rich).disabled).toBe(true);
    expect(tile("insight", selected, rich).disabled).toBe(true);
    expect(tile("fury", selected, rich)).toEqual({ chosen: true, disabled: false });
  });

  it("за самоцветы при двух самоцветах и цене четыре — приглушён, за монеты — нет", () => {
    const balances = { coins: 500, gems: 2 };
    expect(tile("head_start", [], balances).disabled).toBe(true);
    expect(tile("fury", [], balances).disabled).toBe(false);
  });

  it("уже выбранный за монеты уменьшает доступное для следующего за монеты", () => {
    const balances = { coins: 200, gems: 0 };
    expect(tile("lure", [], balances).disabled).toBe(false);
    expect(tile("lure", ["fury"], balances).disabled).toBe(true);
  });

  it("выбранный за монеты не мешает буст за самоцветы", () => {
    expect(tile("head_start", ["fury"], { coins: 120, gems: 4 }).disabled).toBe(false);
  });

  it("кошелёк не загружен — баланс нулевой, как у прежнего списка: невыбранное приглушено", () => {
    expect(tile("fury", [], null).disabled).toBe(true);
    expect(tile("fury", ["fury"], null)).toEqual({ chosen: true, disabled: false });
  });
});

describe("сумма к списанию", () => {
  it("ничего не выбрано — пусто", () => {
    expect(boostCost([], CATALOG)).toEqual({});
  });

  it("считает по валютам: Ярость + Щит + Фора", () => {
    expect(boostCost(["fury", "aegis", "head_start"], CATALOG)).toEqual({ coins: 270, gems: 4 });
  });

  it("нулевая валюта в сумму не попадает", () => {
    expect(boostCost(["fury"], CATALOG)).toEqual({ coins: 120 });
    expect(boostCost(["insight"], CATALOG)).toEqual({ gems: 6 });
  });

  it("неизвестный id подсчёт не ломает", () => {
    expect(boostCost(["fury", "ghost"], CATALOG)).toEqual({ coins: 120 });
    expect(boostCost(["ghost"], CATALOG)).toEqual({});
  });
});

describe("что описывать под плитками", () => {
  it("последний тронутый, пока он выбран", () => {
    expect(boostToDescribe("aegis", ["fury", "aegis"])).toBe("aegis");
  });

  it("тронутый, но снятый с выбора, описывается, пока не тронут другой", () => {
    expect(boostToDescribe("aegis", ["fury"])).toBe("aegis");
  });

  it("ничего не тронуто — последний выбранный", () => {
    expect(boostToDescribe(null, ["fury", "aegis"])).toBe("aegis");
  });

  it("ни тронутого, ни выбранного — ничего", () => {
    expect(boostToDescribe(null, [])).toBeNull();
  });
});
