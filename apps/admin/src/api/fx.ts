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
  /** запасной курс рыночной валюты, который сейчас в снимке вместо рыночного; сервер до Р90 поля не отдавал */
  fallback: z.boolean().default(false),
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

/**
 * Ручной курс — любой валюте, кроме доллара (Р90). У валюты площадки он
 * основной, у рыночной — запасной: работает, только пока источники не дают
 * свежего курса.
 */
export const MANUAL_CURRENCIES = [
  ["XTR", "звёзды"],
  ["RUB", "рубль"],
  ["EUR", "евро"],
  ["GRAM", "Gram"],
  ["USDT", "USDT"],
] as const;

export const PLATFORM_CURRENCIES = ["XTR"] as const;

/** Рыночная валюта — у неё есть источники, и ручной курс запасной. */
export function isMarketCurrency(code: string): boolean {
  return !(PLATFORM_CURRENCIES as readonly string[]).includes(code);
}

/** Запасной курс — не дольше недели (`MARKET_MANUAL_MAX_DAYS` на сервере). */
export const MARKET_MANUAL_MAX_DAYS = 7;
export const MARKET_MANUAL_RULE = "У рыночной валюты ручной курс — запасной: в долларах и только для цен";

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

const refreshResultSchema = z.object({
  source: z.string(),
  ok: z.boolean(),
  error: z.string().nullable(),
  quotes: z.array(z.object({ currency: z.string(), usdPerUnit: z.string(), status: z.enum(["accepted", "rejected", "waiting"]) })),
  snapshotId: z.string(),
});

export type RefreshResult = z.infer<typeof refreshResultSchema>;

/** «Обновить сейчас»: источник спрашивается сразу; ответ — что он вернул и принят ли каждый курс. */
export function refreshSource(api: AdminApi, source: string): Promise<ApiResult<RefreshResult>> {
  return api.request(`/fx/sources/${encodeURIComponent(source)}/refresh`, { method: "POST", schema: refreshResultSchema });
}

const SOURCE_TITLES: Readonly<Record<string, string>> = {
  coingecko: "CoinGecko",
  coinmarketcap: "CoinMarketCap",
  cbr: "ЦБ РФ",
  ecb: "ЕЦБ",
  erapi: "ExchangeRate-API",
  forexrateapi: "ForexRateAPI",
  tonapi: "TonAPI",
  binance: "Binance",
};

const CURRENCY_TITLES: Readonly<Record<string, string>> = { GRAM: "Gram", USDT: "USDT", RUB: "рубль", EUR: "евро", XTR: "звезда" };

const QUOTE_STATUS_TITLES = { accepted: "принят", rejected: "отклонён", waiting: "ждёт других источников" } as const;

export function sourceTitle(source: string): string {
  return SOURCE_TITLES[source] ?? source;
}

/** Цена в долларах для человека: запятая, не меньше двух знаков после неё, остальные — как пришли. */
function dollars(usdPerUnit: string): string {
  const [whole = "0", fraction = ""] = usdPerUnit.split(".");
  return `${whole},${fraction.padEnd(2, "0")} $`;
}

/** Итог «Обновить сейчас» одной строкой: что ответил источник и принят ли каждый курс, либо причина сбоя. */
export function refreshSummary(result: RefreshResult): string {
  const title = sourceTitle(result.source);
  if (!result.ok) return `${title} не ответил: ${result.error ?? "причина неизвестна"}`;
  if (result.quotes.length === 0) return `${title} ответил, но курсов не прислал`;
  const quotes = result.quotes.map((quote) => `${CURRENCY_TITLES[quote.currency] ?? quote.currency} ${dollars(quote.usdPerUnit)} — ${QUOTE_STATUS_TITLES[quote.status]}`);
  return `${title} ответил: ${quotes.join(", ")}`;
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

/**
 * Доля в целых процентах вниз: 79,9% — это 79, чтобы «80%» всегда значило
 * предупреждение. Добавка — на ошибку двоичной дроби: 0,29 × 100 = 28,999…
 */
export function sharePercent(usedShare: number): number {
  return Math.floor(usedShare * 100 + 1e-9);
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

/** Число лимита в границах сервера. Причину окно проверяет само: у неё своё поле. */
export function limitValueProblem(perMonth: number | null): string | null {
  if (perMonth !== null && (!Number.isInteger(perMonth) || perMonth < 1 || perMonth > MAX_REQUESTS)) return `Лимит — целое от 1 до ${formatNumber(MAX_REQUESTS)} или «без лимита»`;
  return null;
}

export function usedValueProblem(used: number): string | null {
  if (!Number.isInteger(used) || used < 0 || used > MAX_REQUESTS) return `Счётчик — целое от 0 до ${formatNumber(MAX_REQUESTS)}`;
  return null;
}

/** Те же границы, что у сервера: не отправлять заведомо отклонённое. `null` — годно. */
export function limitProblem(input: LimitInput): string | null {
  return limitValueProblem(input.perMonth) ?? noteProblem(input.note);
}

export function usedProblem(input: UsedInput): string | null {
  return usedValueProblem(input.used) ?? noteProblem(input.note);
}

/** Те же границы, что у `manualRateSchema` на сервере: не отправлять заведомо отклонённое. `null` — годно. */
export function manualRateProblem(input: ManualRateInput): string | null {
  if (!/^\d{1,12}(\.\d{1,40})?$/.test(input.price)) return "Цена — число с точкой: 0.013";
  if (/^0+(\.0+)?$/.test(input.price)) return "Цена не может быть нулевой";
  const market = isMarketCurrency(input.currency);
  // Запасной курс рыночной валюты (Р90): те же границы, что у `manualRateSchema` на сервере.
  if (market && (input.quote !== "USD" || input.purpose !== "price")) return MARKET_MANUAL_RULE;
  const maxDays = market ? MARKET_MANUAL_MAX_DAYS : 90;
  if (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > maxDays) {
    return market ? `Срок запасного курса — от 1 до ${String(MARKET_MANUAL_MAX_DAYS)} дней: это запас на время сбоя` : "Срок — от 1 до 90 дней: заданный курс без срока устаревал бы молча";
  }
  const note = input.note.trim().length;
  if (note < 3 || note > 200) return "Причина — от 3 до 200 символов: она попадёт в аудит";
  return null;
}
