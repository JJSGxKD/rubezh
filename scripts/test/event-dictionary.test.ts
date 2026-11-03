import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ANALYTICS_EVENTS } from "../../packages/app-shell/src/state/analytics";
import { EVENT_DICTIONARY, EVENT_TYPES, MAX_PAYLOAD_KEYS } from "../../backend/api/src/modules/events/event-dictionary.js";

// Один словарь событий на три места: клиент, сервер и документ
// (docs/22-analytics-and-metrics.md §3.3). Разойдутся — клиент начнёт слать
// события, которые сервер молча отбрасывает, или документ опишет несуществующие.

const docs = readFileSync(fileURLToPath(new URL("../../docs/22-analytics-and-metrics.md", import.meta.url)), "utf8");

describe("словарь событий", () => {
  it("клиент шлёт ровно те события, которые знает сервер", () => {
    expect([...ANALYTICS_EVENTS].sort()).toEqual([...EVENT_TYPES].sort());
  });

  it("каждое событие сервера описано в документе", () => {
    for (const event of EVENT_TYPES) expect(docs, event).toContain(`\`${event}\``);
  });

  it("покупка в магазине — с товаром и без номера продолжения; второй шанс — как прежде, режим обязателен у обоих", () => {
    const { payload } = EVENT_DICTIONARY.purchase_completed;
    expect(payload.safeParse({ product: "shop_item", sku: "gems_60", priceStars: 50, chargedStars: 1, mode: "test" }).success).toBe(true);
    expect(payload.safeParse({ product: "vip", sku: "vip_month", priceStars: 200, chargedStars: 200, mode: "live" }).success).toBe(true);
    expect(payload.safeParse({ product: "continue_run", priceStars: 3, chargedStars: 3, mode: "live", continueNo: 1 }).success).toBe(true);
    // Товар по акции — со скидкой в процентах; дробная скидка — мусор.
    expect(payload.safeParse({ product: "shop_item", sku: "gems_330", priceStars: 175, chargedStars: 175, mode: "live", promoPct: 30 }).success).toBe(true);
    expect(payload.safeParse({ product: "shop_item", sku: "gems_330", priceStars: 175, chargedStars: 175, mode: "live", promoPct: 30.5 }).success).toBe(false);
    expect(payload.safeParse({ product: "shop_item", sku: "gems_60", priceStars: 50, chargedStars: 50 }).success).toBe(false);
  });

  describe("сила и давление (tasks/T-0196, решение 5)", () => {
    const started = { seed: 1, weapon: "spark", map: "frontier", difficulty: "hard", screenMode: "fullscreen", orientation: "portrait", devMode: false };
    const finished = {
      seed: 1,
      survivalSec: 420,
      level: 12,
      wave: 5,
      enemiesKilled: 300,
      weapon: "spark",
      map: "frontier",
      difficulty: "hard",
      contentHash: "abc",
      isNewRecord: false,
      cheats: false,
    };
    const power = { power: 2.01, pressure: 1, deviceClass: "light" };

    it("run_started принимает power, pressure и deviceClass; без них тоже", () => {
      const { payload } = EVENT_DICTIONARY.run_started;
      expect(payload.safeParse({ ...started, ...power }).success).toBe(true);
      expect(payload.safeParse(started).success).toBe(true);
      expect(payload.safeParse({ ...started, power: -1 }).success).toBe(false);
      expect(payload.safeParse({ ...started, pressure: "high" }).success).toBe(false);
    });

    it("run_finished и run_abandoned принимают все пять полей; без них тоже", () => {
      const full = { ...finished, ...power, powerEnd: 2.4, pressureEnd: 1.04 };
      expect(EVENT_DICTIONARY.run_finished.payload.safeParse(full).success).toBe(true);
      expect(EVENT_DICTIONARY.run_abandoned.payload.safeParse(full).success).toBe(true);
      expect(EVENT_DICTIONARY.run_finished.payload.safeParse(finished).success).toBe(true);
      expect(EVENT_DICTIONARY.run_finished.payload.safeParse({ ...full, powerEnd: -0.5 }).success).toBe(false);
      expect(EVENT_DICTIONARY.run_finished.payload.safeParse({ ...full, pressureEnd: "x" }).success).toBe(false);
    });

    it("потолок ключей payload не меньше 48: поля итога растут вместе", () => {
      expect(MAX_PAYLOAD_KEYS).toBeGreaterThanOrEqual(48);
    });
  });
});
