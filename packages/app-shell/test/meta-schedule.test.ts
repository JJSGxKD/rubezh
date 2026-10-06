import { describe, expect, it } from "vitest";
import { formatCountdown, msUntilReset } from "../src/screens/meta/schedule";
import { sectorCenterDeg, spinRotationDeg } from "../src/screens/meta/wheel-math";

// Мета: сброс заданий и поворот колеса
// (docs/07-monetization-and-ads.md §7, docs/27-design-system-and-app-shell.md §6).
// Сектора и шансы колеса, прогресс заданий и достижений — на сервере, их
// проверяют backend/api/test/wheel.test.ts и tasks.test.ts.

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
  it("останавливает стрелку ровно на середине выпавшего сектора", () => {
    for (const count of [6, 8, 12]) {
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
    }
  });
});
