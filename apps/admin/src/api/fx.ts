import { z } from "zod";
import { formatNumber } from "../format";
import type { AdminApi, ApiResult } from "./client";

/**
 * Курсы валют (`/admin/fx`, docs/36-fx-rates-and-pricing.md): обзор со
 * свежестью, источники с расходом запросов и заданные курсы валют площадок.
 * Числа курсов — строками, как их отдаёт сервер: без потерь на плавающей точке.
 */
const rateSchema = z.object({
  currency: z.string(),
  usdPerUnit: z.string(),
  unitsPerUsd: z.string(),
  sources: z.array(z.string()),
  observedAt: z.string(),
  freshness: z.string(),
});

const manualSchema = z.object({
  currency: z.string(),
  purpose: z.string(),
  price: z.string(),
  quote: z.string(),
  usdPerUnit: z.string().nullable(),
  sources: z.array(z.string()),
  observedAt: z.string(),
  freshness: z.string(),
  setBy: z.string(),
  expiresAt: z.string(),
  note: z.string(),
});

const sourceSchema = z.object({
  source: z.string(),
  tariff: z.string(),
  month: z.string().nullable(),
  used: z.number(),
  pausedUntil: z.string().nullable(),
  nextPollAt: z.string().nullable(),
  /** месячный лимит: число или `null` — без лимита; `from` — из тарифа в коде или из панели */
  limit: z.object({ perMonth: z.number().nullable(), from: z.enum(["tariff", "panel"]) }),
  /** доля лимита; без лимита `null`, сверх лимита больше единицы */
  usedShare: z.number().nullable(),
});

export const fxOverviewSchema = z.object({
  enabled: z.boolean(),
  rates: z.array(rateSchema),
  missing: z.array(z.string()),
  manual: z.array(manualSchema),
  sources: z.array(sourceSchema),
});

export type FxOverview = z.infer<typeof fxOverviewSchema>;
export type ManualRate = z.infer<typeof manualSchema>;
export type SourceRow = z.infer<typeof sourceSchema>;

/** Валюты площадок, курс которых задаётся руками, и валюты котировки — те же списки, что у сервера. */
export const PLATFORM_CURRENCIES = ["XTR"] as const;
export const QUOTE_CURRENCIES = ["USD", "EUR", "RUB"] as const;
export const MANUAL_PURPOSES = [
  ["price", "для цен"],
  ["payout", "для выплат"],
] as const;

export interface ManualRateInput {
  currency: string;
  purpose: string;
  price: string;
  quote: string;
  expiresInDays: number;
  note: string;
}

export function fetchFxOverview(api: AdminApi): Promise<ApiResult<FxOverview>> {
  return api.request("/fx", { schema: fxOverviewSchema });
}

export function setManualRate(api: AdminApi, input: ManualRateInput): Promise<ApiResult<ManualRate>> {
  return api.request("/fx/manual", { method: "POST", body: input, schema: manualSchema });
}

/** Границы счётчиков запросов — те же, что у `sourceLimitSchema` и `sourceUsedSchema` на сервере. */
export const MAX_REQUESTS = 100_000_000;

export interface LimitInput {
  /** запросов в месяц; `null` — без лимита */
  perMonth: number | null;
  note: string;
}

export interface UsedInput {
  used: number;
  note: string;
}

/** Лимит источника: в панели он правится, а сброс возвращает тариф из кода (Р89). */
export function setSourceLimit(api: AdminApi, source: string, input: LimitInput): Promise<ApiResult<SourceRow>> {
  return api.request(`/fx/sources/${encodeURIComponent(source)}/limit`, { method: "PUT", body: { perMonth: input.perMonth, note: input.note.trim() }, schema: sourceSchema });
}

export function resetSourceLimit(api: AdminApi, source: string): Promise<ApiResult<SourceRow>> {
  return api.request(`/fx/sources/${encodeURIComponent(source)}/limit`, { method: "DELETE", schema: sourceSchema });
}

export function correctSourceUsed(api: AdminApi, source: string, input: UsedInput): Promise<ApiResult<SourceRow>> {
  return api.request(`/fx/sources/${encodeURIComponent(source)}/used`, { method: "PUT", body: { used: input.used, note: input.note.trim() }, schema: sourceSchema });
}

/** Тон расхода лимита: с 80% — предупреждение, с 100% — опасность. */
export function budgetTone(usedShare: number | null): "neutral" | "warning" | "danger" {
  if (usedShare === null) return "neutral";
  if (usedShare >= 1) return "danger";
  return usedShare >= 0.8 ? "warning" : "neutral";
}

/** «6 120 из 10 000»; без лимита — счётчик и «без лимита». */
export function usageText(source: Pick<SourceRow, "used" | "limit">): string {
  const { perMonth } = source.limit;
  return perMonth === null ? `${formatNumber(source.used)}, без лимита` : `${formatNumber(source.used)} из ${formatNumber(perMonth)}`;
}

/** Откуда лимит: тариф из кода или правка в панели. */
export function limitCaption(source: Pick<SourceRow, "tariff" | "limit">): string {
  return source.limit.from === "panel" ? "задан в панели" : `по тарифу «${source.tariff}»`;
}

/** Целое из поля: пробелы между разрядами не мешают; не целое — `NaN`. */
export function parseCount(text: string): number {
  const compact = text.replace(/\s/g, "");
  return /^\d{1,15}$/.test(compact) ? Number(compact) : Number.NaN;
}

function noteProblem(note: string): string | null {
  const length = note.trim().length;
  return length < 3 || length > 200 ? "Причина — от 3 до 200 символов: она попадёт в аудит" : null;
}

/** Те же границы, что у сервера: не отправлять заведомо отклонённое. `null` — годно. */
export function limitProblem(input: LimitInput): string | null {
  const { perMonth } = input;
  if (perMonth !== null && (!Number.isInteger(perMonth) || perMonth < 1 || perMonth > MAX_REQUESTS)) return `Лимит — целое от 1 до ${formatNumber(MAX_REQUESTS)} или «без лимита»`;
  return noteProblem(input.note);
}

export function usedProblem(input: UsedInput): string | null {
  if (!Number.isInteger(input.used) || input.used < 0 || input.used > MAX_REQUESTS) return `Счётчик — целое от 0 до ${formatNumber(MAX_REQUESTS)}`;
  return noteProblem(input.note);
}

/** Те же границы, что у `manualRateSchema` на сервере: не отправлять заведомо отклонённое. `null` — годно. */
export function manualRateProblem(input: ManualRateInput): string | null {
  if (!/^\d{1,12}(\.\d{1,40})?$/.test(input.price)) return "Цена — число с точкой: 0.013";
  if (/^0+(\.0+)?$/.test(input.price)) return "Цена не может быть нулевой";
  if (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > 90) return "Срок — от 1 до 90 дней: заданный курс без срока устаревал бы молча";
  const note = input.note.trim().length;
  if (note < 3 || note > 200) return "Причина — от 3 до 200 символов: она попадёт в аудит";
  return null;
}
