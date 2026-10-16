import { describe, expect, it } from "vitest";
import { DAILY_RELOAD_SLACK_MS, dailyReloadDelayMs } from "../src/screens/meta/daily-reload";

// Полночь по Москве — 21:00 UTC (meta-schedule.test.ts).
const at = (iso: string): number => Date.parse(iso);

describe("перечитывание награды дня на смене суток", () => {
  it("до полуночи ждём остаток суток и запас", () => {
    const loaded = at("2026-09-14T12:00:00Z");
    expect(dailyReloadDelayMs(loaded, loaded)).toBe(32_405_000);
  });

  it("таймер заводится позже ответа — задержка короче", () => {
    const loaded = at("2026-09-14T20:59:00Z");
    expect(dailyReloadDelayMs(loaded, at("2026-09-14T20:59:30Z"))).toBe(35_000);
  });

  it("смена суток уже прошла — сразу, не отрицательное число", () => {
    const loaded = at("2026-09-14T20:59:00Z");
    expect(dailyReloadDelayMs(loaded, at("2026-09-14T21:10:00Z"))).toBe(0);
  });

  it("ответ после полуночи — следующая смена через сутки", () => {
    const loaded = at("2026-09-14T21:00:05Z");
    expect(dailyReloadDelayMs(loaded, loaded)).toBe(86_400_000);
  });

  it("ровно в полночь следующая смена через сутки с запасом", () => {
    const loaded = at("2026-09-14T21:00:00Z");
    expect(dailyReloadDelayMs(loaded, loaded)).toBe(86_405_000);
  });

  it("запас — константа в 5 секунд, как на главной", () => {
    expect(DAILY_RELOAD_SLACK_MS).toBe(5_000);
  });
});
