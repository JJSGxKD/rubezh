import { describe, expect, it } from "vitest";
import { claimFeedView, FEED_VIEWS_PER_LAUNCH, FEED_WINDOW_MS, feedTextOf, freshItems, nextHoldMs, nextIndex } from "../src/screens/home-feed-rules";
import type { FeedItem } from "../src/state/feed-api";

// Правила ленты на главной (Р114, tasks/T-0176): как долго держится событие,
// что считается устаревшим, по какому кругу они сменяются и какими словами
// говорятся. Всё без React и без часов: время и случайность приходят параметром.

const NOW = Date.parse("2026-10-21T12:00:00.000Z");

function item(id: string, overrides: Partial<FeedItem> = {}): FeedItem {
  return { id, kind: "boss", name: "Игрок", atMs: NOW - 1_000, seconds: null, ...overrides };
}

describe("сколько держится событие", () => {
  it("5…8 секунд, обе границы достижимы", () => {
    expect(nextHoldMs(() => 0)).toBe(5_000);
    expect(nextHoldMs(() => 0.999999)).toBe(8_000);
    expect(nextHoldMs(() => 0.5)).toBe(6_500);
  });

  it("на ста значениях не выходит за 5000…8000", () => {
    for (let index = 0; index < 100; index += 1) {
      const hold = nextHoldMs(() => index / 100);
      expect(hold).toBeGreaterThanOrEqual(5_000);
      expect(hold).toBeLessThanOrEqual(8_000);
    }
  });
});

describe("свежесть на устройстве", () => {
  it("ровно сутки назад остаётся, на миллисекунду старше — нет", () => {
    expect(FEED_WINDOW_MS).toBe(86_400_000);
    const edge = item("edge", { atMs: NOW - FEED_WINDOW_MS });
    const stale = item("stale", { atMs: NOW - FEED_WINDOW_MS - 1 });
    expect(freshItems([edge, stale], NOW)).toEqual([edge]);
  });

  it("порядок остальных сохраняется, пустой список — пустой", () => {
    const list = [item("a"), item("b"), item("c")];
    expect(freshItems(list, NOW).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(freshItems([], NOW)).toEqual([]);
  });
});

describe("следующее событие", () => {
  const list = [item("a"), item("b"), item("c")];

  it("по кругу: 0 → 1 → 2 → 0", () => {
    expect(nextIndex(list, "a")).toBe(1);
    expect(nextIndex(list, "b")).toBe(2);
    expect(nextIndex(list, "c")).toBe(0);
  });

  it("текущего нет в обновлённом списке или его ещё нет — с начала", () => {
    expect(nextIndex(list, "gone")).toBe(0);
    expect(nextIndex(list, null)).toBe(0);
  });

  it("одно событие остаётся им же", () => {
    expect(nextIndex([item("a")], "a")).toBe(0);
  });

  it("пустой список — минус один, без падения", () => {
    expect(nextIndex([], "a")).toBe(-1);
    expect(nextIndex([], null)).toBe(-1);
  });
});

describe("слова события", () => {
  it("длинный забег — имя и целые минуты", () => {
    expect(feedTextOf(item("a", { kind: "long_run", name: "Ян", seconds: 725 }))).toEqual({ key: "feed.longRun", params: { name: "Ян", minutes: 12 } });
  });

  it("рекорд недели — имя и время минуты:секунды", () => {
    expect(feedTextOf(item("a", { kind: "week_record", name: "Ян", seconds: 725 }))).toEqual({ key: "feed.weekRecord", params: { name: "Ян", time: "12:05" } });
  });

  it("босс и сундук — только имя", () => {
    expect(feedTextOf(item("a", { kind: "boss", name: "Ян" }))).toEqual({ key: "feed.boss", params: { name: "Ян" } });
    expect(feedTextOf(item("a", { kind: "chest", name: "Ян" }))).toEqual({ key: "feed.chest", params: { name: "Ян" } });
  });
});

describe("показы для аналитики", () => {
  it("раз на событие за запуск", () => {
    const seen = new Set<string>();
    expect(claimFeedView(seen, "a")).toBe(true);
    expect(claimFeedView(seen, "a")).toBe(false);
    expect(claimFeedView(seen, "b")).toBe(true);
  });

  it("не больше двадцати за запуск", () => {
    const seen = new Set<string>();
    for (let index = 0; index < FEED_VIEWS_PER_LAUNCH; index += 1) expect(claimFeedView(seen, `e${index}`)).toBe(true);
    expect(FEED_VIEWS_PER_LAUNCH).toBe(20);
    expect(claimFeedView(seen, "extra")).toBe(false);
    expect(seen.size).toBe(20);
  });
});
