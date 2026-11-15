import { describe, expect, it } from "vitest";
import {
  XRAY_CORE_BLOCKS,
  XRAY_CORE_MAX,
  XRAY_CORE_MIN,
  compareXrayVersions,
  findXrayCoreProblems,
  formatXrayVersion,
  parseXrayVersion,
  xrayCompatibility,
  type XrayCoreBlock,
} from "../src/xray-core.js";

// Версия ядра Xray и диапазон проверенных версий (Р202).

const range = { min: "26.9.1", max: "26.10.31" };
const blocks: XrayCoreBlock[] = [{ from: "27.1.0", until: "27.2.0", reason: "поле x" }];

describe("parseXrayVersion", () => {
  it("разбирает три числа, ведущая v допустима", () => {
    expect(parseXrayVersion("26.10.31")).toEqual([26, 10, 31]);
    expect(parseXrayVersion("v26.10.31")).toEqual([26, 10, 31]);
  });

  it.each(["26.10", "26.10.31.1", "26.010.1", "-1.0.0", "26.10.31-rc1", "10000.0.0", "", " 26.10.31"])(
    "не принимает %j",
    (text) => {
      expect(parseXrayVersion(text)).toBeNull();
    },
  );
});

describe("compareXrayVersions и formatXrayVersion", () => {
  const v = (s: string) => parseXrayVersion(s)!;
  it("сравнивает по числам, а не по строкам", () => {
    expect(compareXrayVersions(v("26.9.1"), v("26.10.0"))).toBe(-1);
    expect(compareXrayVersions(v("26.10.31"), v("v26.10.31"))).toBe(0);
    expect(compareXrayVersions(v("27.0.0"), v("26.12.31"))).toBe(1);
  });

  it("форматирует без v", () => {
    expect(formatXrayVersion([26, 10, 31])).toBe("26.10.31");
  });
});

describe("xrayCompatibility", () => {
  it("различает проверенную, непроверенную, старую, заблокированную и неразобранную", () => {
    expect(xrayCompatibility("26.10.31", range, blocks)).toEqual({ kind: "tested" });
    expect(xrayCompatibility("26.9.1", range, blocks)).toEqual({ kind: "tested" });
    expect(xrayCompatibility("26.12.1", range, blocks)).toEqual({ kind: "untested" });
    expect(xrayCompatibility("27.1.5", range, blocks)).toEqual({ kind: "blocked", reason: "поле x" });
    expect(xrayCompatibility("27.2.0", range, blocks)).toEqual({ kind: "untested" });
    expect(xrayCompatibility("26.1.1", range, blocks)).toEqual({ kind: "older" });
    expect(xrayCompatibility("мусор", range, blocks)).toEqual({ kind: "unknown" });
  });

  it("блок с until: null закрывает и все новее", () => {
    expect(xrayCompatibility("30.0.0", range, [{ from: "27.1.0", until: null, reason: "r" }])).toEqual({
      kind: "blocked",
      reason: "r",
    });
  });

  it("без аргументов берёт значения пакета", () => {
    expect(xrayCompatibility(XRAY_CORE_MAX)).toEqual({ kind: "tested" });
  });
});

describe("findXrayCoreProblems", () => {
  it("данные пакета верны", () => {
    expect(findXrayCoreProblems({ min: XRAY_CORE_MIN, max: XRAY_CORE_MAX }, XRAY_CORE_BLOCKS)).toEqual([]);
  });

  it("min новее max", () => {
    const p = findXrayCoreProblems({ min: "26.10.31", max: "26.9.1" }, []);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("min");
  });

  it("блок без причины", () => {
    const p = findXrayCoreProblems(range, [{ from: "27.1.0", until: null, reason: " " }]);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("блок 1");
    expect(p[0]).toContain("reason");
  });

  it("until не новее from", () => {
    const p = findXrayCoreProblems(range, [
      { from: "27.1.0", until: null, reason: "r" },
      { from: "27.1.0", until: "27.1.0", reason: "r" },
    ]);
    expect(p).toEqual(["блок 2: until не новее from"]);
  });

  it("блок задевает проверенный отрезок", () => {
    const p = findXrayCoreProblems(range, [{ from: "26.10.0", until: "27.0.0", reason: "r" }]);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("блок 1");
  });
});
