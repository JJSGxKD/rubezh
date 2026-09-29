import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { useShell } from "./shell";

/**
 * История имущества с сервера (docs/35-stage4-plan.md Р51, §3.17): движения
 * валют, осколков, предметов, бустов и покупок одной лентой. Причины, виды и
 * ресурсы — строками: сервер новее клиента пришлёт новую причину, и лента
 * покажет её общей подписью, а не упадёт.
 *
 * Модуль грузится вместе с экраном истории — первой загрузке он не нужен.
 */

export const HISTORY_FILTERS = ["all", "currency", "shards", "items", "boosts", "purchases"] as const;
export type HistoryFilter = (typeof HISTORY_FILTERS)[number];

const walletSchema = z.object({
  id: z.string(),
  at: z.string(),
  category: z.string(),
  kind: z.literal("wallet"),
  resource: z.string(),
  amount: z.number(),
  reason: z.string(),
});
const itemSchema = z.object({
  id: z.string(),
  at: z.string(),
  category: z.string(),
  kind: z.literal("item"),
  event: z.string(),
  itemId: z.string(),
  slot: z.string(),
  rarity: z.string(),
  level: z.nullable(z.number()),
});
const purchaseSchema = z.object({
  id: z.string(),
  at: z.string(),
  category: z.string(),
  kind: z.literal("purchase"),
  product: z.string(),
  stars: z.number(),
  refunded: z.boolean(),
});

const viewSchema = z.object({ entries: z.array(z.union([walletSchema, itemSchema, purchaseSchema])), nextCursor: z.nullable(z.string()) });

export type HistoryEntry = z.infer<typeof viewSchema>["entries"][number];
export type HistoryPage = z.infer<typeof viewSchema>;

export interface HistoryApi {
  page(filter: HistoryFilter, cursor: string | null): Promise<ApiResult<HistoryPage>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createHistoryApi(request: ApiRequest = apiRequest): HistoryApi {
  return {
    page: (filter, cursor) => {
      const query = [filter === "all" ? null : `categories=${filter}`, cursor === null ? null : `cursor=${encodeURIComponent(cursor)}`].filter((part): part is string => part !== null);
      return request(`/api/v1/me/history${query.length === 0 ? "" : `?${query.join("&")}`}`, viewSchema, { method: "GET" });
    },
  };
}

/** История — только с входом: имущество живёт на сервере. */
export function historyAvailable(): boolean {
  return useShell.getState().capabilities.auth !== undefined;
}
