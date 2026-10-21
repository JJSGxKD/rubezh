import { z } from "zod";
import { formatNumber } from "../format";
import type { AdminApi, ApiResult } from "./client";

/**
 * Журнал запросов сервера (`/admin/requests`, docs/35-stage4-plan.md Р92):
 * исходящие вызовы к внешним API и сводка входящих по маршрутам. Времена
 * приходят в UTC-строках ISO, показ в местном времени — в `format.ts`.
 */

export const PERIODS = [
  { id: "hour", title: "Час" },
  { id: "day", title: "Сутки" },
  { id: "week", title: "Неделя" },
] as const;

export type RequestPeriod = (typeof PERIODS)[number]["id"];

/**
 * Время ответа. `atLeast` — попало в корзину «дольше»: верхней границы у неё
 * нет, и значение читается как «не меньше».
 */
const latencySchema = z.object({ ms: z.number(), atLeast: z.boolean() }).nullable();

export type Latency = z.infer<typeof latencySchema>;

export const outboundSummarySchema = z.object({
  period: z.string(),
  from: z.string(),
  to: z.string(),
  services: z.array(
    z.object({
      service: z.string(),
      count: z.number(),
      errors: z.number(),
      errorRate: z.number(),
      viaProxy: z.number(),
      median: latencySchema,
      p95: latencySchema,
    }),
  ),
});

const callSchema = z.object({
  id: z.string(),
  at: z.string(),
  service: z.string(),
  method: z.string(),
  host: z.string(),
  path: z.string(),
  status: z.number().nullable(),
  ok: z.boolean(),
  durationMs: z.number(),
  via: z.string(),
  attempt: z.number(),
  error: z.string().nullable(),
});

export const outboundCallsSchema = z.object({ calls: z.array(callSchema), next: z.string().nullable() });

export const inboundSchema = z.object({
  period: z.string(),
  step: z.enum(["minute", "hour"]),
  from: z.string(),
  to: z.string(),
  series: z.array(z.object({ at: z.string(), total: z.number(), errors: z.number() })),
  routes: z.array(
    z.object({
      method: z.string(),
      route: z.string(),
      count: z.number(),
      c4xx: z.number(),
      c5xx: z.number(),
      median: latencySchema,
      p95: latencySchema,
    }),
  ),
});

export type OutboundSummary = z.infer<typeof outboundSummarySchema>;
export type OutboundCall = z.infer<typeof callSchema>;
export type OutboundPage = z.infer<typeof outboundCallsSchema>;
export type Inbound = z.infer<typeof inboundSchema>;

export interface CallsFilter {
  period: RequestPeriod;
  service?: string | undefined;
  errorsOnly: boolean;
  /** курсор: `id` последней строки предыдущей страницы */
  before?: string | undefined;
}

export function fetchOutboundSummary(api: AdminApi, period: RequestPeriod): Promise<ApiResult<OutboundSummary>> {
  return api.request("/requests/outbound/summary", { query: { period }, schema: outboundSummarySchema });
}

export function fetchOutboundCalls(api: AdminApi, filter: CallsFilter): Promise<ApiResult<OutboundPage>> {
  const service = filter.service === undefined || filter.service === "" ? undefined : filter.service;
  return api.request("/requests/outbound", {
    query: { period: filter.period, service, errors: filter.errorsOnly ? "1" : undefined, before: filter.before },
    schema: outboundCallsSchema,
  });
}

export function fetchInbound(api: AdminApi, period: RequestPeriod): Promise<ApiResult<Inbound>> {
  return api.request("/requests/inbound", { query: { period }, schema: inboundSchema });
}

/** С этой доли 5xx маршрут подсвечивается: один отказ на сто ответов уже заметен игрокам. */
const SERVER_ERROR_ALARM_PERCENT = 1;

/** Тон доли 5xx: от 1% — опасность. Сравнение целыми числами: 9 из 1000 против 10 из 1000 не должно решаться плавающей точкой. */
export function serverErrorTone(count: number, c5xx: number): "neutral" | "danger" {
  return count > 0 && c5xx * 100 >= count * SERVER_ERROR_ALARM_PERCENT ? "danger" : "neutral";
}

/** Доля от 0 до 1 → «2,5%»; ненулевая доля меньше 0,1% не округляется до нуля. */
export function formatShare(rate: number): string {
  if (rate <= 0) return "0%";
  if (rate < 0.001) return "<0,1%";
  const percent = Math.round(rate * 1000) / 10;
  return `${percent.toLocaleString("ru-RU")}%`;
}

/** Время: «90 мс», «2,5 с»; в корзине «дольше» — «≥ 5 с». */
export function formatLatency(latency: Latency): string {
  if (latency === null) return "—";
  const text = latency.ms < 1000 ? `${formatNumber(latency.ms)} мс` : `${(Math.round(latency.ms / 100) / 10).toLocaleString("ru-RU")} с`;
  return latency.atLeast ? `≥ ${text}` : text;
}

const ERROR_TITLES: Readonly<Record<string, string>> = {
  timeout: "не ответил вовремя",
  network: "сеть недоступна",
  aborted: "прерван",
};

/** Исход вызова одной строкой: код ответа или причина сбоя словами. Незнакомая причина новее панели — как есть. */
export function callOutcome(call: Pick<OutboundCall, "status" | "ok" | "error">): string {
  if (call.status !== null) return String(call.status);
  if (call.error === null) return "сбой";
  return ERROR_TITLES[call.error] ?? call.error;
}

/** Как ушёл вызов: напрямую или через прокси с его именем. */
export function viaLabel(via: string): string {
  return via === "direct" ? "напрямую" : via;
}

/** Столбец графика: высоты — доли от максимума по ряду, чтобы экран не считал сам. */
export interface ChartBar {
  at: string;
  total: number;
  errors: number;
}

/** Высоты столбцов от 0 до 1 относительно самого нагруженного шага; пустой период — нули, без деления на ноль. */
export function seriesChart(series: Inbound["series"]): { max: number; bars: ChartBar[] } {
  const max = series.reduce((top, point) => Math.max(top, point.total), 0);
  return {
    max,
    bars: series.map((point) => ({ at: point.at, total: max === 0 ? 0 : point.total / max, errors: max === 0 ? 0 : point.errors / max })),
  };
}
