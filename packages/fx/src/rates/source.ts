import type { CurrencyCode } from "../currency.js";
import type { Decimal } from "../decimal.js";
import type { HttpClient } from "../ports/http.js";

/**
 * Источник курса — адаптер с приоритетом, тарифом и бюджетом запросов
 * (docs/35-stage4-plan.md §3.12, Р35). На старте только бесплатные тарифы;
 * платный включается ключом в окружении, а не кодом: адрес и лимиты платного
 * тарифа уже лежат в определении источника.
 */

export interface SourcePlanLimits {
  /** null — источник лимита не объявляет; частота тогда — из природного интервала данных */
  requestsPerMinute: number | null;
  requestsPerMonth: number | null;
}

export interface SourcePlan {
  name: "free" | "paid";
  baseUrl: string;
  limits: SourcePlanLimits;
  /** Заголовок, в котором источник ждёт ключ; у бесплатного тарифа его нет. */
  keyHeader?: string;
}

/** В чём источник котирует: биржи — в USDT, и такой курс пересчитывается через курс самого USDT. */
export type QuoteCurrency = "USD" | "USDT";

export interface SourceQuote {
  currency: CurrencyCode;
  /** Идентификатор валюты у источника — по нему сопоставляли; хранится в наблюдении для разбора. */
  sourceCurrencyId: string;
  price: Decimal;
  quotedIn: QuoteCurrency;
  observedAt: number;
}

export interface SourceFetchContext {
  http: HttpClient;
  plan: SourcePlan;
  apiKey: string | undefined;
  /** Какие валюты нужны — из тех, что источник умеет; остальные не спрашиваем и не разбираем. */
  currencies: readonly CurrencyCode[];
  timeoutMs: number;
  now: number;
}

export interface SourceDefinition {
  id: string;
  /**
   * Сопоставление наших кодов идентификаторам источника. У каждого
   * источника свой идентификатор, и валюта ищется по нему, а не по тикеру:
   * в сети TON есть посторонний жетон с тем же тикером GRAM
   * (docs/08-web-and-identity.md §6), и поиск по тикеру однажды взял бы его курс.
   */
  currencies: Partial<Record<CurrencyCode, string>>;
  /** Природная частота данных: курс ЦБ меняется раз в сутки — чаще спрашивать нечего. */
  naturalIntervalMs: number;
  quotedIn: QuoteCurrency;
  free: SourcePlan;
  paid?: SourcePlan;
  fetch(ctx: SourceFetchContext): Promise<SourceQuote[]>;
}

export type SourceErrorKind = "http" | "rate_limited" | "parse" | "missing";

export class SourceError extends Error {
  constructor(
    readonly sourceId: string,
    readonly kind: SourceErrorKind,
    message: string,
    readonly status: number | null = null,
  ) {
    super(`${sourceId}: ${message}`);
    this.name = "SourceError";
  }
}

/** Общий разбор статуса ответа: 429 — отдельный вид, на него источник ставится на паузу, остальное — обычная ошибка. */
export function assertHttpOk(sourceId: string, status: number): void {
  if (status === 429) throw new SourceError(sourceId, "rate_limited", "источник ограничил частоту", status);
  if (status < 200 || status >= 300) throw new SourceError(sourceId, "http", `ответ ${status}`, status);
}

/** Только те валюты из запрошенных, которые источник умеет, с их идентификаторами. */
export function wantedIds(definition: SourceDefinition, currencies: readonly CurrencyCode[]): Array<[CurrencyCode, string]> {
  const result: Array<[CurrencyCode, string]> = [];
  for (const code of currencies) {
    const id = definition.currencies[code];
    if (id !== undefined) result.push([code, id]);
  }
  return result;
}
