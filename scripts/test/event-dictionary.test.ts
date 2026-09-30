import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ANALYTICS_EVENTS } from "../../packages/app-shell/src/state/analytics";
import { EVENT_DICTIONARY, EVENT_TYPES } from "../../backend/api/src/modules/events/event-dictionary.js";

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
    expect(payload.safeParse({ product: "shop_item", sku: "gems_60", priceStars: 50, chargedStars: 50 }).success).toBe(false);
  });
});
