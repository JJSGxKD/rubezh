import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { createHistoryApi } from "../src/state/history-api";

// Клиент истории имущества (docs/35-stage4-plan.md Р51): фильтр и курсор — в
// запросе, ответ — схемой; незнакомая причина не роняет разбор.

function server(paths: string[], answer: unknown): ApiRequest {
  return async <T,>(path: string, schema: object): Promise<ApiResult<T>> => {
    paths.push(path);
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

const PAGE = {
  entries: [
    { id: "w:1", at: "2026-09-30T10:00:00.000Z", category: "currency", kind: "wallet", resource: "coins", amount: -150, reason: "новая_причина" },
    { id: "i:1", at: "2026-09-30T09:00:00.000Z", category: "items", kind: "item", event: "upgraded", itemId: "x", slot: "boots", rarity: "rare", level: 3 },
    { id: "p:1", at: "2026-09-30T08:00:00.000Z", category: "purchases", kind: "purchase", product: "continue_run", stars: 25, refunded: false },
  ],
  nextCursor: "c/1",
};

describe("клиент истории имущества", () => {
  it("всё — без фильтра; категория и курсор уходят в запрос", async () => {
    const paths: string[] = [];
    const api = createHistoryApi(server(paths, PAGE));
    await api.page("all", null);
    await api.page("boosts", "c/1");
    expect(paths).toEqual(["/api/v1/me/history", "/api/v1/me/history?categories=boosts&cursor=c%2F1"]);
  });

  it("строки трёх журналов разбираются, а незнакомая причина — не ошибка", async () => {
    const page = await createHistoryApi(server([], PAGE)).page("all", null);
    expect(page.ok && page.data.entries.map((entry) => entry.kind)).toEqual(["wallet", "item", "purchase"]);
  });
});
