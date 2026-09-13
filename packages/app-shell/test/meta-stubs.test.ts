import { describe, expect, it } from "vitest";
import { hasTranslation } from "../src/i18n";
import { formatCountdown, msUntilReset } from "../src/screens/meta/schedule";
import {
  ACHIEVEMENTS,
  DAILY_REWARDS,
  WHEEL_SECTORS,
  achievementProgress,
} from "../src/screens/meta/stub-content";
import {
  pickSector,
  sectorCenterDeg,
  sectorOdds,
  spinRotationDeg,
} from "../src/screens/meta/wheel-math";

// Заглушки меты: сброс заданий, колесо, достижения
// (docs/07-monetization-and-ads.md §7, docs/27-design-system-and-app-shell.md §6).

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const utc = (iso: string): number => Date.parse(iso);

describe("сброс заданий по московскому времени", () => {
  it("ежедневный — в полночь по Москве, то есть в 21:00 UTC", () => {
    expect(msUntilReset(utc("2026-09-14T12:00:00Z"), "daily")).toBe(9 * HOUR);
    expect(msUntilReset(utc("2026-09-14T20:59:00Z"), "daily")).toBe(MINUTE);
  });

  it("ровно в момент сброса следующий — через сутки, а не сейчас", () => {
    expect(msUntilReset(utc("2026-09-14T21:00:00Z"), "daily")).toBe(DAY);
  });

  it("недельный — в ночь на понедельник по Москве", () => {
    // 13 сентября 2026 — воскресенье; 23:00 по Москве.
    expect(msUntilReset(utc("2026-09-13T20:00:00Z"), "weekly")).toBe(HOUR);
    // Полночь понедельника по Москве: только что сбросился — следующий через неделю.
    expect(msUntilReset(utc("2026-09-13T21:00:00Z"), "weekly")).toBe(7 * DAY);
    // Полночь четверга по Москве.
    expect(msUntilReset(utc("2026-09-16T21:00:00Z"), "weekly")).toBe(4 * DAY);
  });

  it("граница суток — московская, а не полночь UTC и не часы устройства", () => {
    // 02:30 UTC: полночь UTC была два с половиной часа назад, а сброс — вечером.
    expect(msUntilReset(utc("2026-09-14T02:30:00Z"), "daily")).toBe(18 * HOUR + 30 * MINUTE);
  });
});

describe("обратный отсчёт", () => {
  it("показывает самое крупное и без нулевых хвостов", () => {
    expect(formatCountdown(3 * DAY + 4 * HOUR + 10 * MINUTE)).toBe("3 д 4 ч");
    expect(formatCountdown(2 * DAY)).toBe("2 д");
    expect(formatCountdown(5 * HOUR + 12 * MINUTE)).toBe("5 ч 12 мин");
    expect(formatCountdown(HOUR)).toBe("1 ч");
    expect(formatCountdown(12 * MINUTE)).toBe("12 мин");
  });

  it("округляет вверх и не показывает «0 мин» перед самым сбросом", () => {
    expect(formatCountdown(59.5 * MINUTE)).toBe("1 ч");
    expect(formatCountdown(20 * 1000)).toBe("1 мин");
    expect(formatCountdown(0)).toBe("1 мин");
    expect(formatCountdown(-5)).toBe("1 мин");
  });
});

describe("колесо удачи", () => {
  it("выбирает сектор пропорционально весу", () => {
    const weights = [1, 0, 3];
    expect(pickSector(weights, 0)).toBe(0);
    expect(pickSector(weights, 0.24)).toBe(0);
    expect(pickSector(weights, 0.26)).toBe(2);
  });

  it("никогда не выдаёт сектор с нулевым весом, даже на краях броска", () => {
    expect(pickSector([2, 0], 1)).toBe(0);
    expect(pickSector([0, 5, 0], 0)).toBe(1);
    expect(pickSector([0, 5, 0], 0.9999)).toBe(1);
    expect(pickSector([3, -2, 0], 0.99)).toBe(0);
  });

  it("без единого веса не падает", () => {
    expect(pickSector([], 0.5)).toBe(0);
    expect(pickSector([0, 0], 0.5)).toBe(0);
  });

  it("останавливает стрелку ровно на середине выпавшего сектора", () => {
    const count = WHEEL_SECTORS.length;
    for (let index = 0; index < count; index += 1) {
      for (const current of [0, 137.5, 2000]) {
        const rotation = spinRotationDeg(current, index, count, 5);
        const underPointer = (((rotation + sectorCenterDeg(index, count)) % 360) + 360) % 360;
        expect(Math.min(underPointer, 360 - underPointer)).toBeCloseTo(0, 6);
        // Только вперёд и не меньше пяти полных оборотов, но и не лишний шестой.
        expect(rotation - current).toBeGreaterThanOrEqual(5 * 360);
        expect(rotation - current).toBeLessThan(6 * 360);
      }
    }
  });

  it("показывает шансы, в сумме дающие сто процентов", () => {
    const odds = sectorOdds(WHEEL_SECTORS.map((sector) => sector.weight));
    expect(odds.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 6);
    expect(odds.every((value) => value > 0)).toBe(true);
  });

  it("не даёт донатную валюту: к случайной награде не должно быть денежного пути", () => {
    // docs/07-monetization-and-ads.md §7: крутка бесплатная или за рекламу, а
    // антирекламный пакет выдаёт рекламные награды без ролика.
    expect(WHEEL_SECTORS.some((sector) => sector.reward.kind === "premium")).toBe(false);
  });
});

describe("награда дня и достижения", () => {
  it("неделя из семи дней", () => {
    expect(DAILY_REWARDS).toHaveLength(7);
  });

  it("прогресс достижения не уходит за цель и не показывает NaN из битого хранилища", () => {
    const survive = ACHIEVEMENTS.find((achievement) => achievement.id === "survive_1");
    if (survive === undefined) throw new Error("нет достижения survive_1");

    expect(achievementProgress(survive, { bestSurvivalSec: 30, runs: 0 })).toEqual({
      value: 30,
      target: 60,
      done: false,
    });
    expect(achievementProgress(survive, { bestSurvivalSec: 610, runs: 0 })).toEqual({
      value: 60,
      target: 60,
      done: true,
    });
    expect(achievementProgress(survive, { bestSurvivalSec: Number.NaN, runs: 0 }).value).toBe(0);
    expect(achievementProgress(survive, { bestSurvivalSec: -4, runs: 0 }).value).toBe(0);
  });

  it("у каждого достижения есть название и описание", () => {
    for (const achievement of ACHIEVEMENTS) {
      expect(hasTranslation(`achievement.${achievement.id}.name`), achievement.id).toBe(true);
      expect(hasTranslation(`achievement.${achievement.id}.description`), achievement.id).toBe(true);
    }
  });
});
