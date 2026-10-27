import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  filterByPlatform,
  funnelBars,
  funnelTotal,
  heatBackground,
  heatTone,
  moscowDay,
  platformsOf,
  presetPeriod,
  previousPeriod,
  sortRows,
  worstStep,
  type FunnelRow,
} from "../src/api/funnel";
import { FunnelChart } from "../src/screens/funnel/funnel-chart";

// Воронка полосами (tasks/T-0053, design/screens/admin-funnel.html): числа
// макета — 2840 вошли, 820 дошли до пятого забега.

const NOW = new Date("2026-10-22T15:00:00.000Z");

function row(patch: Partial<FunnelRow> & { counts?: number[] }): FunnelRow {
  const [entered = 0, appOpened = 0, firstRunStarted = 0, firstRunFinished = 0, runs2 = 0, runs5 = 0, returnedD1 = 0, returnedD7 = 0, firstPurchase = 0] = patch.counts ?? [];
  return {
    platform: "telegram",
    startKind: "organic",
    startRef: null,
    startSource: null,
    accounts: entered,
    entered,
    appOpened,
    firstRunStarted,
    firstRunFinished,
    runs2,
    runs5,
    returnedD1,
    returnedD7,
    firstPurchase,
    ...patch,
  };
}

const NOW_ROW = row({ counts: [2840, 2410, 2180, 1990, 1310, 820, 690, 260, 88] });
const BEFORE_ROW = row({ counts: [2310, 1940, 1700, 1560, 1080, 640, 520, 190, 61] });

describe("периоды воронки", () => {
  it("пресет на 7 дней — с начала суток шесть дней назад по Москве до сейчас", () => {
    expect(presetPeriod(7, NOW)).toEqual({ from: "2026-10-15T21:00:00.000Z", to: "2026-10-22T15:00:00.000Z" });
  });

  it("пресеты 30 и 90 — с начала московских суток N−1 дней назад", () => {
    expect(presetPeriod(30, NOW).from).toBe("2026-09-22T21:00:00.000Z");
    expect(presetPeriod(90, NOW).from).toBe("2026-07-24T21:00:00.000Z");
  });

  it("после московской полуночи сутки уже новые, хотя по UTC ещё вчера", () => {
    expect(presetPeriod(7, new Date("2026-10-22T21:30:00.000Z")).from).toBe("2026-10-16T21:00:00.000Z");
    expect(moscowDay(new Date("2026-10-22T21:30:00.000Z"))).toBe("2026-10-23");
  });

  it("прошлый период — той же длины, вплотную перед этим", () => {
    const period = presetPeriod(7, NOW);
    const previous = previousPeriod(period);
    expect(previous).toEqual({ from: "2026-10-09T03:00:00.000Z", to: "2026-10-15T21:00:00.000Z" });
    expect(new Date(previous.to).getTime() - new Date(previous.from).getTime()).toBe(new Date(period.to).getTime() - new Date(period.from).getTime());
  });
});

describe("воронка полосами", () => {
  it("доли от первой и от прошлой вехи", () => {
    const bars = funnelBars(NOW_ROW, null);
    expect(bars).toHaveLength(9);
    expect(bars[0]).toMatchObject({ step: "entered", title: "Вход", count: 2840, ofFirst: 1, ofPrev: null });
    expect(bars[1]?.ofFirst).toBeCloseTo(2410 / 2840, 6);
    expect(bars[5]?.ofPrev).toBeCloseTo(820 / 1310, 6);
  });

  it("с прошлым периодом: изменение доли в п. п. с одним знаком, у входа — число аккаунтов", () => {
    const bars = funnelBars(NOW_ROW, BEFORE_ROW);
    expect(bars[1]?.deltaPts).toBe(0.9);
    expect(bars[5]?.deltaPts).toBe(0.5);
    expect(bars[0]?.deltaPts).toBe(0);
    expect(bars[0]?.countBefore).toBe(2310);
  });

  it("без прошлого периода изменений нет", () => {
    const bars = funnelBars(NOW_ROW, null);
    expect(bars.every((bar) => bar.deltaPts === null && bar.countBefore === null)).toBe(true);
  });

  it("никто не вошёл — доли нули, без деления на ноль", () => {
    const empty = row({ counts: [] });
    const bars = funnelBars(empty, empty);
    expect(bars.every((bar) => bar.ofFirst === 0)).toBe(true);
    expect(bars.slice(1).every((bar) => bar.ofPrev === 0)).toBe(true);
    expect(bars.every((bar) => bar.deltaPts === 0)).toBe(true);
  });

  it("больше всего теряем — «5 забегов»: 37% не дошли от «2 забега»", () => {
    expect(worstStep(funnelBars(NOW_ROW, null))).toBe(5);
  });

  it("потеря на восьмой вехе в расчёт не идёт: дальше она ожидаема", () => {
    const late = row({ counts: [1000, 990, 980, 970, 960, 950, 900, 10, 5] });
    expect(worstStep(funnelBars(late, null))).toBe(1);
  });

  it("потерь нет — null", () => {
    expect(worstStep(funnelBars(row({ counts: [10, 10, 10, 10, 10, 10, 5, 2, 1] }), null))).toBeNull();
    expect(worstStep(funnelBars(row({ counts: [] }), null))).toBeNull();
  });
});

describe("подсветка источников", () => {
  it("доля как у общей — без подсветки", () => {
    expect(heatTone(0.85, 0.85)).toEqual({ tone: "flat", strength: 0 });
    expect(heatTone(0.86, 0.85).tone).toBe("flat");
  });

  it("выше общей на 3 п. п. и больше — зелёным, насыщенность растёт с разницей", () => {
    const tone = heatTone(0.92, 0.85);
    expect(tone.tone).toBe("up");
    expect(tone.strength).toBeCloseTo(0.14, 6);
  });

  it("ниже общей — красным; насыщенность не выше 30%", () => {
    expect(heatTone(0.6, 0.85)).toEqual({ tone: "down", strength: 0.3 });
    expect(heatTone(0.99, 0.5).strength).toBe(0.3);
  });

  it("фон ячейки — из токенов цвета и в процентах насыщенности", () => {
    expect(heatBackground({ tone: "flat", strength: 0 })).toBeUndefined();
    expect(heatBackground({ tone: "up", strength: 0.14 })).toBe("color-mix(in oklab, var(--color-success) 14%, transparent)");
    expect(heatBackground({ tone: "down", strength: 0.3 })).toBe("color-mix(in oklab, var(--color-danger) 30%, transparent)");
  });
});

describe("таблица источников", () => {
  const organic = row({ startKind: "organic", platform: "telegram", counts: [920, 780, 690, 620, 410, 250, 220, 90, 21] });
  const stream = row({ startKind: "click", startRef: "stream-1009", platform: "max", counts: [610, 540, 500, 460, 330, 230, 190, 80, 30] });
  const ads = row({ startKind: "click", startRef: "ads", platform: "telegram", counts: [1310, 1090, 990, 910, 570, 340, 280, 90, 37] });

  it("сортировка по аккаунтам и по любой вехе — по убыванию, итог в расчёт не входит", () => {
    expect(sortRows([organic, stream, ads], "accounts").map((item) => item.startRef ?? item.startKind)).toEqual(["ads", "organic", "stream-1009"]);
    expect(sortRows([organic, stream, ads], "firstPurchase").map((item) => item.startRef ?? item.startKind)).toEqual(["organic", "ads", "stream-1009"].sort((a, b) => ({ ads: 37, organic: 21, "stream-1009": 30 })[b]! - ({ ads: 37, organic: 21, "stream-1009": 30 })[a]!));
  });

  it("сортировка не меняет исходный список", () => {
    const rows = [organic, stream, ads];
    sortRows(rows, "accounts");
    expect(rows[0]).toBe(organic);
  });

  it("площадки — из строк ответа, без повторов; фильтр оставляет строки площадки", () => {
    expect(platformsOf([organic, stream, ads])).toEqual(["telegram", "max"]);
    expect(filterByPlatform([organic, stream, ads], "max")).toEqual([stream]);
    expect(filterByPlatform([organic, stream, ads], null)).toHaveLength(3);
  });

  it("итог считается по отфильтрованным строкам", () => {
    expect(funnelTotal(filterByPlatform([organic, stream, ads], "max")).entered).toBe(610);
  });
});

describe("разметка воронки", () => {
  const bars = funnelBars(NOW_ROW, BEFORE_ROW);
  const html = (compare: boolean) => renderToStaticMarkup(createElement(FunnelChart, { bars: funnelBars(NOW_ROW, compare ? BEFORE_ROW : null), worst: 5, compare }));

  it("девять полос с названиями вех и числами", () => {
    const out = html(true);
    expect(out.match(/role="img"/g)).toHaveLength(9);
    expect(out).toContain("Вход");
    expect(out).toContain("Покупка");
    expect(bars).toHaveLength(9);
  });

  it("отметка «больше всего теряем» стоит над нужной вехой", () => {
    const out = html(true);
    expect(out).toContain("больше всего теряем");
    expect(out).toContain("37% не доходят от «2 забега» до «5 забегов»");
    expect(out.indexOf("больше всего теряем")).toBeLessThan(out.indexOf("5 забегов</span>") === -1 ? out.length : out.indexOf("5 забегов</span>"));
  });

  it("сравнение включено — черта прошлого периода и изменения; выключено — их нет", () => {
    const on = html(true);
    expect(on).toContain("bg-text/55");
    expect(on).toContain("text-success");
    const off = html(false);
    expect(off).not.toContain("bg-text/55");
    expect(off).not.toContain("text-success");
    expect(off).not.toContain("text-danger");
  });

  it("без отметки, если терять нечего", () => {
    const out = renderToStaticMarkup(createElement(FunnelChart, { bars: funnelBars(NOW_ROW, null), worst: null, compare: false }));
    expect(out).not.toContain("больше всего теряем");
  });
});
