import { describe, expect, it } from "vitest";
import type { UpgradeChange } from "@bh/shared-types";
import { formatChange } from "../src/screens/run/upgrade-format";

// Числа изменения на карточке улучшения.

const change = (patch: Partial<UpgradeChange>): UpgradeChange => ({
  labelKey: "x",
  from: null,
  to: 1,
  format: "value",
  lowerIsBetter: false,
  ...patch,
});

describe("числа улучшения", () => {
  it("значение — как есть, по-русски и без хвоста нулей", () => {
    expect(formatChange(change({ from: 0.26, to: 0.24, lowerIsBetter: true }))).toEqual({
      from: "0,26",
      to: "0,24",
      better: true,
    });
  });

  it("множитель — сдвигом в процентах, со знаком", () => {
    expect(formatChange(change({ from: 1.1, to: 1.2, format: "percent" }))).toEqual({
      from: "+10%",
      to: "+20%",
      better: true,
    });
    expect(formatChange(change({ to: 0.92, format: "percent", lowerIsBetter: true })).to).toBe("−8%");
  });

  it("прибавка — со знаком плюс", () => {
    expect(formatChange(change({ from: 20, to: 45, format: "plus" }))).toMatchObject({ from: "+20", to: "+45" });
  });

  it("у нового предмета сравнивать не с чем", () => {
    expect(formatChange(change({ to: 5 }))).toEqual({ from: null, to: "5", better: null });
  });

  it("ухудшение помечается как ухудшение", () => {
    expect(formatChange(change({ from: 3, to: 2 })).better).toBe(false);
  });
});
