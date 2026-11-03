import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { parseArgs, framePlan, changedShare, lifeMs, flashStats, percentile95, meanBrightness } from "../fx/frames-core.mjs";

// Команда нужна живому dev-серверу и браузеру, поэтому в гейт не входит;
// здесь — чистые части: флаги, план кадров и расчёт замеров по числам.

const CATALOG = ["spark", "storm", "dynamite"];

describe("parseArgs", () => {
  it("без сцен — все сцены каталога, обе земли", () => {
    const options = parseArgs([], CATALOG);
    expect(options.scenes).toEqual(CATALOG);
    expect(options.grounds).toEqual(["map", "light"]);
  });

  it("--ground light — одна земля, --ground map — другая", () => {
    expect(parseArgs(["storm", "--ground", "light"], CATALOG).grounds).toEqual(["light"]);
    expect(parseArgs(["storm", "--ground", "map"], CATALOG).grounds).toEqual(["map"]);
    expect(parseArgs(["storm", "--ground", "both"], CATALOG).grounds).toEqual(["map", "light"]);
  });

  it("--ground x — ошибка с допустимыми значениями", () => {
    expect(() => parseArgs(["--ground", "x"], CATALOG)).toThrow(/--ground.*x/);
  });

  it("неизвестная сцена — ошибка с её id", () => {
    expect(() => parseArgs(["storm", "nope"], CATALOG)).toThrow(/nope/);
  });

  it("неизвестный флаг и флаг без значения — ошибка", () => {
    expect(() => parseArgs(["--zzz", "1"], CATALOG)).toThrow(/--zzz/);
    expect(() => parseArgs(["--out"], CATALOG)).toThrow(/--out/);
  });

  it("умолчания адреса и каталога", () => {
    const options = parseArgs(["storm"], CATALOG);
    expect(options.base).toBe("http://localhost:5173");
    expect(options.out).toBe("var/fx");
  });

  it("без каталога имена не проверяются: их проверит страница", () => {
    expect(parseArgs(["storm"], null).scenes).toEqual(["storm"]);
  });
});

describe("framePlan", () => {
  it("90 тиков — 31 кадр: нулевой и 30 шагов по 3", () => {
    const plan = framePlan(90);
    expect(plan).toHaveLength(31);
    expect(plan[0]).toBe(0);
    expect(plan[1]).toBe(3);
    expect(plan[30]).toBe(90);
  });

  it("60 тиков — 21 кадр", () => {
    expect(framePlan(60)).toHaveLength(21);
  });
});

function frame(values: number[]): Uint8Array {
  // 4×4 пикселя, RGBA; значение — серый одинаковый по каналам
  return Uint8Array.from(values.flatMap((v) => [v, v, v, 255]));
}

describe("changedShare", () => {
  it("два пикселя из 16 изменились на 30 — 0,125", () => {
    const before = frame(new Array(16).fill(100));
    const after = frame(new Array(16).fill(100).map((v, i) => (i < 2 ? v + 30 : v)));
    expect(changedShare(before, after)).toBe(0.125);
  });

  it("изменение на 10 ниже порога — 0", () => {
    const before = frame(new Array(16).fill(100));
    const after = frame(new Array(16).fill(110));
    expect(changedShare(before, after)).toBe(0);
  });

  it("порог 24 — по любому каналу", () => {
    const before = Uint8Array.from([0, 0, 0, 255]);
    expect(changedShare(before, Uint8Array.from([0, 0, 25, 255]))).toBe(1);
    expect(changedShare(before, Uint8Array.from([0, 0, 24, 255]))).toBe(0);
  });
});

describe("lifeMs", () => {
  it("затухает: от первого кадра выше порога до трёх тихих подряд — 100 мс", () => {
    expect(lifeMs([0, 0.2, 0.1, 0.004, 0.003, 0.002], 50)).toEqual({ lifeMs: 100, note: null });
  });

  it("не затух до конца — null и пометка", () => {
    const result = lifeMs([0, 0.2, 0.1, 0.09, 0.08, 0.07], 50);
    expect(result.lifeMs).toBeNull();
    expect(result.note).toBe("не затух за 250 мс");
  });

  it("эффекта не было — 0", () => {
    expect(lifeMs([0, 0, 0, 0], 50)).toEqual({ lifeMs: 0, note: null });
  });
});

describe("flashStats", () => {
  it("яркость 100/130/100/130 — три скачка, 20 в секунду, предупреждение", () => {
    const stats = flashStats([100, 130, 100, 130], 50);
    expect(stats.count).toBe(3);
    expect(stats.perSecond).toBeCloseTo(20);
    expect(stats.warning).toBe("частые вспышки");
  });

  it("плавный рост — вспышек нет", () => {
    const stats = flashStats([100, 105, 110], 50);
    expect(stats.count).toBe(0);
    expect(stats.warning).toBeNull();
  });

  it("редкая вспышка не даёт предупреждения", () => {
    const series = new Array(61).fill(100);
    series[30] = 150;
    const stats = flashStats(series, 50);
    expect(stats.count).toBe(2);
    expect(stats.warning).toBeNull();
  });
});

describe("percentile95", () => {
  it("на значениях 1…100 — 95", () => {
    expect(percentile95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
  });

  it("пустой ряд — null", () => {
    expect(percentile95([])).toBeNull();
  });
});

describe("meanBrightness", () => {
  it("среднее по пикселям", () => {
    expect(meanBrightness(frame(new Array(16).fill(100)))).toBeCloseTo(100);
  });
});
