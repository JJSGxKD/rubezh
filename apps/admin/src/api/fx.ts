import { z } from "zod";
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

/** Те же границы, что у `manualRateSchema` на сервере: не отправлять заведомо отклонённое. `null` — годно. */
export function manualRateProblem(input: ManualRateInput): string | null {
  if (!/^\d{1,12}(\.\d{1,40})?$/.test(input.price)) return "Цена — число с точкой: 0.013";
  if (/^0+(\.0+)?$/.test(input.price)) return "Цена не может быть нулевой";
  if (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > 90) return "Срок — от 1 до 90 дней: заданный курс без срока устаревал бы молча";
  const note = input.note.trim().length;
  if (note < 3 || note > 200) return "Причина — от 3 до 200 символов: она попадёт в аудит";
  return null;
}
