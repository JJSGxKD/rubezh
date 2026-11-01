import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * «Ждёт вас» для меню (`GET /admin/attention`, tasks/T-0359): тот же список,
 * что на экране «Сводка», но без тяжёлых рядов — запрос лёгкий, его опрашивают
 * раз в минуту с любого экрана.
 */

const itemSchema = z.object({ section: z.string(), count: z.number(), text: z.string() });
export const attentionResponseSchema = z.object({ items: z.array(itemSchema) });
export type AttentionItem = z.infer<typeof itemSchema>;

export function fetchAttention(api: AdminApi): Promise<ApiResult<z.infer<typeof attentionResponseSchema>>> {
  return api.request("/attention", { schema: attentionResponseSchema });
}

/** Сумма по пунктам — число на знаке меню. */
export function attentionTotal(items: readonly Pick<AttentionItem, "count">[]): number {
  return items.reduce((sum, item) => sum + item.count, 0);
}
