import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Трафик через узлы Xray (`GET /admin/proxy-traffic`, docs/35-stage4-plan.md Р192,
 * tasks/T-0386): сколько байт сервер прогнал через каждый узел каждой подписки за
 * сутки, неделю или месяц. Считает ядро Xray на нашем сервере; цифра поставщика
 * в карточке подписки — другая и общая на все его устройства. «Отдано» — байты от
 * нас к узлу, «получено» — от узла к нам.
 */

export const TRAFFIC_PERIODS = ["day", "week", "month"] as const;
export type TrafficPeriod = (typeof TRAFFIC_PERIODS)[number];

const bytes = z.number().nonnegative();

const nodeSchema = z.object({
  nodeKey: z.string(),
  name: z.string(),
  /** узла уже нет в подписке: он ушёл при обновлении, а трафик за окно остался */
  inSubscription: z.boolean(),
  upBytes: bytes,
  downBytes: bytes,
});
export type TrafficNode = z.infer<typeof nodeSchema>;

const subscriptionSchema = z.object({
  key: z.string(),
  name: z.string(),
  upBytes: bytes,
  downBytes: bytes,
  /** только узлы, через которые что-то прошло */
  nodes: z.array(nodeSchema),
});
export type TrafficSubscription = z.infer<typeof subscriptionSchema>;

const reportSchema = z.object({
  period: z.enum(TRAFFIC_PERIODS),
  /** границы часов окна, ISO */
  from: z.string(),
  to: z.string(),
  /** когда сервер последний раз получил счётчики Xray; `null` — ни разу */
  lastCollectedAt: z.string().nullable(),
  subscriptions: z.array(subscriptionSchema),
});
export type TrafficReport = z.infer<typeof reportSchema>;

export function fetchProxyTraffic(api: AdminApi, period: TrafficPeriod): Promise<ApiResult<TrafficReport>> {
  return api.request("/proxy-traffic", { query: { period }, schema: reportSchema });
}
