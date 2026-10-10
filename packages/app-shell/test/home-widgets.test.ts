import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatCountdown } from "../src/screens/meta/schedule";
import type { DailyWidget, WheelWidget } from "../src/state/home-api";
import { arrangeWidgets, dailyFace, recordFace, tasksFace, wheelFace, type WidgetReadiness } from "../src/screens/home-widget-rules";

// Виджеты главной (docs/35-stage4-plan.md WP42, часть 3): готовое к забору —
// первым и во всю ширину, дыр в сетке нет; что говорит каждый виджет —
// правилом. Ответ главной и его свежесть — в home-api.test.ts.

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
/** Полночь по Москве после NOW — 21:00 UTC. */
const MIDNIGHT = Date.parse("2026-10-04T21:00:00.000Z");
const HOUR = 3_600_000;

const DAYS = [60, 80, 100, 120, 150, 180, 300].map((coins, index) => ({ coins, shards: index === 6 ? 10 : 0, claimed: index < 2, today: index === 2 }));
const DAILY: DailyWidget = { canClaim: true, days: DAYS, next: { coins: 120, shards: 0 } };
const WHEEL: WheelWidget = { free: false, jackpot: 1_000, ad: { available: true, readyAt: null, vip: false } };

function ready(patch: Partial<WidgetReadiness> = {}): WidgetReadiness {
  return { daily: false, wheel: false, tasks: false, ...patch };
}

describe("порядок и размер виджетов", () => {
  it("ничего не готово — рекорд во всю ширину, за ним задания, награда дня, колесо и друзья", () => {
    expect(arrangeWidgets(ready())).toEqual([
      { id: "record", size: "hero" },
      { id: "tasks", size: "tile" },
      { id: "daily", size: "tile" },
      { id: "wheel", size: "tile" },
      { id: "friends", size: "tile" },
    ]);
  });

  it("готовое — первым и во всю ширину: награда дня, колесо, задания", () => {
    expect(arrangeWidgets(ready({ tasks: true, daily: true, wheel: true })).slice(0, 3)).toEqual([
      { id: "daily", size: "hero" },
      { id: "wheel", size: "hero" },
      { id: "tasks", size: "hero" },
    ]);
    expect(arrangeWidgets(ready({ wheel: true }))).toEqual([
      { id: "wheel", size: "hero" },
      { id: "record", size: "tile" },
      { id: "tasks", size: "tile" },
      { id: "daily", size: "tile" },
      { id: "friends", size: "tile" },
    ]);
  });

  it("плиток нечётно — последняя во всю ширину строкой: дыр в сетке нет ни при каком сочетании", () => {
    expect(arrangeWidgets(ready({ daily: true, wheel: true }))).toEqual([
      { id: "daily", size: "hero" },
      { id: "wheel", size: "hero" },
      { id: "record", size: "tile" },
      { id: "tasks", size: "tile" },
      { id: "friends", size: "row" },
    ]);
    for (const mask of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const slots = arrangeWidgets({ daily: (mask & 1) > 0, wheel: (mask & 2) > 0, tasks: (mask & 4) > 0 });
      expect(slots.map((slot) => slot.id).sort(), String(mask)).toEqual(["daily", "friends", "record", "tasks", "wheel"]);
      expect(slots.filter((slot) => slot.size === "tile").length % 2, String(mask)).toBe(0);
      // Широкие — только сверху: плитка выше широкого ломала бы правило «готовое — первым».
      const firstTile = slots.findIndex((slot) => slot.size !== "hero");
      expect(slots.slice(firstTile).every((slot) => slot.size !== "hero"), String(mask)).toBe(true);
    }
  });
});

describe("награда дня", () => {
  it("ждёт — сегодняшняя награда, какой день и полоса недели", () => {
    expect(dailyFace(DAILY, true, NOW)).toEqual({ state: "ready", reward: { coins: 100, shards: 0 }, day: 3, days: DAYS });
  });

  it("забрана — завтрашняя награда и отсчёт до полуночи по Москве", () => {
    expect(dailyFace({ ...DAILY, canClaim: false }, false, NOW)).toEqual({ state: "waiting", next: { coins: 120, shards: 0 }, untilMs: MIDNIGHT, days: DAYS });
    // Забрали на экране награды — знак погас раньше, чем пришёл ответ главной: завтра то же самое.
    expect(dailyFace(DAILY, false, NOW)).toMatchObject({ state: "waiting", next: { coins: 120, shards: 0 } });
  });

  it("полночь прошла, а ответ вчерашний — ждёт то, что вчера было «завтра», без полосы прошлой недели", () => {
    expect(dailyFace({ ...DAILY, canClaim: false }, true, NOW)).toEqual({ state: "ready", reward: { coins: 120, shards: 0 }, day: null, days: [] });
  });

  it("без ответа — ждёт по знаку без подробностей, иначе подсказка", () => {
    expect(dailyFace(null, true, NOW)).toEqual({ state: "ready", reward: null, day: null, days: [] });
    expect(dailyFace(null, false, NOW)).toEqual({ state: "idle" });
  });
});

describe("колесо", () => {
  it("бесплатная крутка ждёт — с джекпотом; без ответа — тоже ждёт, но без числа", () => {
    expect(wheelFace(WHEEL, true, NOW, true)).toEqual({ state: "ready", jackpot: 1_000 });
    expect(wheelFace(null, true, NOW, true)).toEqual({ state: "ready", jackpot: null });
    expect(wheelFace(null, false, NOW, true)).toEqual({ state: "idle" });
  });

  it("потрачена — крутка за рекламу, если площадка её покажет; у VIP — и без роликов", () => {
    expect(wheelFace(WHEEL, false, NOW, true)).toEqual({ state: "ad", vip: false, jackpot: 1_000 });
    expect(wheelFace({ ...WHEEL, ad: { ...WHEEL.ad, vip: true } }, false, NOW, false)).toEqual({ state: "ad", vip: true, jackpot: 1_000 });
    expect(wheelFace(WHEEL, false, NOW, false)).toEqual({ state: "waiting", untilMs: MIDNIGHT, jackpot: 1_000 });
    expect(wheelFace({ ...WHEEL, ad: { ...WHEEL.ad, available: false } }, false, NOW, true)).toMatchObject({ state: "waiting" });
  });

  it("крутка за рекламу на кулдауне — отсчёт до неё; кулдаун прошёл — можно", () => {
    const cooling = { ...WHEEL, ad: { ...WHEEL.ad, readyAt: new Date(NOW + 12 * 60_000).toISOString() } };
    expect(wheelFace(cooling, false, NOW, true)).toEqual({ state: "cooldown", untilMs: NOW + 12 * 60_000 });
    expect(wheelFace(cooling, false, NOW + 13 * 60_000, true)).toMatchObject({ state: "ad" });
  });
});

describe("задания", () => {
  it("награды ждут — числом со знака меню: он свежее ответа главной", () => {
    expect(tasksFace({ dailyDone: 2, dailyTotal: 4, claimable: 0 }, 3)).toEqual({ state: "ready", claimable: 3, done: 2, total: 4 });
    expect(tasksFace(null, 1)).toEqual({ state: "ready", claimable: 1, done: null, total: null });
  });

  it("не ждут — кольцо заданий суток; заданий суток нет или ответа нет — подсказка", () => {
    expect(tasksFace({ dailyDone: 1, dailyTotal: 4, claimable: 0 }, 0)).toEqual({ state: "progress", done: 1, total: 4 });
    expect(tasksFace({ dailyDone: 5, dailyTotal: 4, claimable: 0 }, 0)).toEqual({ state: "progress", done: 4, total: 4 });
    expect(tasksFace({ dailyDone: 0, dailyTotal: 0, claimable: 0 }, 0)).toEqual({ state: "idle" });
    expect(tasksFace(null, 0)).toEqual({ state: "idle" });
  });
});

describe("рекорд", () => {
  it("нет рекорда — впереди; последний забег на этой сложности — сколько не хватило или рекорд в нём", () => {
    expect(recordFace(0, "normal", null, 3)).toEqual({ state: "none" });
    expect(recordFace(754, "normal", { difficultyId: "normal", survivalSec: 712.4 }, 3)).toEqual({ state: "gap", bestSec: 754, gapSec: 42 });
    expect(recordFace(754.6, "normal", { difficultyId: "normal", survivalSec: 754.6 }, 3)).toEqual({ state: "record", bestSec: 754.6 });
  });

  it("последний забег на другой сложности или его не было — сколько забегов сыграно", () => {
    expect(recordFace(754, "normal", { difficultyId: "hard", survivalSec: 100 }, 7)).toEqual({ state: "best", bestSec: 754, runs: 7 });
    expect(recordFace(754, "normal", null, 7)).toEqual({ state: "best", bestSec: 754, runs: 7 });
  });
});

describe("отсчёт в плитке", () => {
  // Одно правило точности со всеми отсчётами (`formatCountdown`): вниз не округляем.
  it("часы не округляются вниз, минуты — вверх, нуля минут нет", () => {
    expect(formatCountdown(5 * HOUR + 50 * 60_000)).toBe("5 ч 50 мин");
    expect(formatCountdown(HOUR)).toBe("1 ч");
    expect(formatCountdown(59.5 * 60_000)).toBe("1 ч");
    expect(formatCountdown(20 * 1000)).toBe("1 мин");
  });

  it("плитка берёт отсчёт у formatCountdown, а грубого правила больше нет", async () => {
    const rules = await import("../src/screens/home-widget-rules");
    expect("roughCountdown" in rules).toBe(false);
    const source = readFileSync(new URL("../src/screens/home-widgets.tsx", import.meta.url), "utf8");
    expect(source).toContain("formatCountdown(ms)");
    expect(source).not.toContain("roughCountdown");
  });
});
