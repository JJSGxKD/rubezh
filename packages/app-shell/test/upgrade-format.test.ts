import { describe, expect, it } from "vitest";
import type { UpgradeChange } from "@bh/shared-types";
import { t } from "../src/i18n";
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

describe("навыки защиты: Вампиризм и Стойкость", () => {
  it("лечение за убийство растёт — лучше, значения целые", () => {
    expect(formatChange(change({ labelKey: "upgrade.stat.passive.healOnKill", from: 1, to: 2 }))).toEqual({
      from: "1",
      to: "2",
      better: true,
    });
  });

  it("период щита сокращается — лучше, значения в секундах", () => {
    expect(formatChange(change({ labelKey: "upgrade.stat.passive.wardIntervalSec", from: 30, to: 25, lowerIsBetter: true }))).toEqual({
      from: "30",
      to: "25",
      better: true,
    });
  });

  it("подписи и тексты навыков есть в словаре", () => {
    for (const key of [
      "upgrade.stat.passive.healOnKill",
      "upgrade.stat.passive.wardIntervalSec",
      "passive.vampirism.name",
      "passive.vampirism.description",
      "passive.steadfast.name",
      "passive.steadfast.description",
    ]) {
      expect(t(key), key).not.toBe(key);
    }
  });
});
