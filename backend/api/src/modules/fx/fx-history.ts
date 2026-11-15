import { BASE_CURRENCY, CURRENCIES, Decimal, type CurrencyCode, type ManualRatePurpose } from "@bh/fx";

/**
 * Курс на прошлую дату (docs/35-stage4-plan.md, §3.12 «Курс на дату», Р219,
 * Р222): закрытие месяца оценивает каждую проводку по курсу её дня, а ядро
 * курсов отвечает только «на сейчас».
 *
 * - рыночные валюты — последняя запись истории принятых курсов не позже даты;
 * - звезда (валюта площадки) — последний заданный курс **выплаты** не позже
 *   даты; цена в рублях пересчитывается через рубль **на ту же дату**, а не
 *   на сегодня;
 * - курс старше недели до даты, а у звезды — с истёкшим на дату сроком, —
 *   отдаётся с `stale`: закрытие предупредит, а не возьмёт старое молча;
 * - курса нет совсем — `null`: это блокер закрытия, а не повод гадать.
 *
 * Модуль не знает ни Nest, ни Prisma: хранилище приходит портом.
 */

const DAY_MS = 86_400_000;

/** Рыночный курс старше этого срока до даты проводки считается устаревшим. */
export const STALE_AFTER_MS = 7 * DAY_MS;

/** Запись истории принятых курсов: цена единицы в долларах и когда курс принят. */
export interface HistoryRow {
  usdPerUnit: Decimal;
  at: Date;
}

/** Заданный курс валюты площадки: цена единицы в валюте котировки и срок годности. */
export interface ManualRow {
  price: Decimal;
  quote: CurrencyCode;
  setAt: Date;
  expiresAt: Date;
}

/**
 * Что нужно истории от хранилища. «На дату» — одна строка по индексу, без
 * выборки всей истории; «на сутки» — строки одних суток UTC вместе с
 * действовавшей на их начало: одним обращением на валюту и сутки.
 */
export interface FxHistoryStore {
  /** последняя запись с `accepted_at ≤ at` */
  historyAt(currency: CurrencyCode, at: Date): Promise<HistoryRow | null>;
  /** действовавшая на `from` (`≤ from`), затем все записи в `(from, to)`; по возрастанию */
  historySpan(currency: CurrencyCode, from: Date, to: Date): Promise<HistoryRow[]>;
  /** последняя строка с `set_at ≤ at` */
  manualAt(currency: CurrencyCode, purpose: ManualRatePurpose, at: Date): Promise<ManualRow | null>;
  /** то же, что `historySpan`, для заданных курсов */
  manualSpan(currency: CurrencyCode, purpose: ManualRatePurpose, from: Date, to: Date): Promise<ManualRow[]>;
}

export interface RateOnDate {
  /** цена одной единицы в долларах */
  usdPerUnit: Decimal;
  /** когда курс принят или задан; у доллара — сама дата */
  at: Date;
  stale: boolean;
  source: "market" | "manual";
}

export interface RateQuery {
  currency: CurrencyCode;
  at: Date;
}

/** Откуда берутся строки: напрямую по дате или из загруженных суток. */
interface Lookup {
  market(currency: CurrencyCode, at: Date): Promise<HistoryRow | null>;
  payout(currency: CurrencyCode, at: Date): Promise<ManualRow | null>;
}

/** Курс одной валюты на дату; нет курса — `null`. */
export async function rateAt(store: FxHistoryStore, currency: CurrencyCode, at: Date): Promise<RateOnDate | null> {
  assertDate(at);
  return await resolve(directLookup(store), currency, at);
}

/**
 * Курсы на много дат: ответы идут в порядке запросов. Закрытие оценивает
 * сотни проводок, поэтому в базу — одно обращение на валюту и сутки UTC (и на
 * рубль под ценой звезды), с кэшем в пределах вызова; в цикле по проводкам
 * обращений нет.
 */
export async function ratesAt(store: FxHistoryStore, queries: readonly RateQuery[]): Promise<(RateOnDate | null)[]> {
  for (const query of queries) assertDate(query.at);
  const cache = new SpanCache(store);
  // Сутки, которые понадобятся, известны заранее: грузим их параллельно, а не
  // по одним, пока идёт разбор проводок.
  await Promise.all(queries.filter((query) => query.currency !== BASE_CURRENCY).map((query) => cache.warm(query)));
  const lookup = cache.lookup();
  // Рубль под ценой звезды: котировку знаем только по загруженной строке.
  await Promise.all(
    queries.map(async (query) => {
      if (!isPlatform(query.currency)) return;
      const row = await lookup.payout(query.currency, query.at);
      if (row !== null && row.quote !== BASE_CURRENCY && !isPlatform(row.quote)) await cache.warm({ currency: row.quote, at: query.at });
    }),
  );
  const results: (RateOnDate | null)[] = [];
  for (const query of queries) results.push(await resolve(lookup, query.currency, query.at));
  return results;
}

async function resolve(lookup: Lookup, currency: CurrencyCode, at: Date): Promise<RateOnDate | null> {
  if (currency === BASE_CURRENCY) return { usdPerUnit: new Decimal(1), at, stale: false, source: "market" };

  if (!isPlatform(currency)) {
    const row = await lookup.market(currency, at);
    if (row === null) return null;
    return { usdPerUnit: row.usdPerUnit, at: row.at, stale: at.getTime() - row.at.getTime() > STALE_AFTER_MS, source: "market" };
  }

  // Валюта площадки: рынка нет, считается курс выплаты (О46) — по нему и
  // оценивается выручка в звёздах.
  const row = await lookup.payout(currency, at);
  if (row === null) return null;
  const expired = row.expiresAt.getTime() < at.getTime();
  if (row.quote === BASE_CURRENCY) return { usdPerUnit: row.price, at: row.setAt, stale: expired, source: "manual" };
  // Котировка в валюте площадки замкнула бы курс на другой заданный: строку
  // писали мимо ядра, и доверять ей нельзя.
  if (isPlatform(row.quote)) return null;
  const quote = await resolve(lookup, row.quote, at);
  if (quote === null) return null;
  return { usdPerUnit: row.price.mul(quote.usdPerUnit), at: row.setAt, stale: expired || quote.stale, source: "manual" };
}

function directLookup(store: FxHistoryStore): Lookup {
  return {
    market: (currency, at) => store.historyAt(currency, at),
    payout: (currency, at) => store.manualAt(currency, "payout", at),
  };
}

/** Сутки UTC, в которые попадает дата: `[from, to)`. */
function dayOf(at: Date): { from: Date; to: Date } {
  const from = Math.floor(at.getTime() / DAY_MS) * DAY_MS;
  return { from: new Date(from), to: new Date(from + DAY_MS) };
}

/** Строки суток, загруженные один раз на валюту: повтор — из кэша, а не из базы. */
class SpanCache {
  private readonly market = new Map<string, Promise<HistoryRow[]>>();
  private readonly payout = new Map<string, Promise<ManualRow[]>>();

  constructor(private readonly store: FxHistoryStore) {}

  async warm(query: RateQuery): Promise<void> {
    if (isPlatform(query.currency)) await this.payoutDay(query.currency, query.at);
    else await this.marketDay(query.currency, query.at);
  }

  lookup(): Lookup {
    return {
      market: async (currency, at) => lastNotAfter(await this.marketDay(currency, at), (row) => row.at, at),
      payout: async (currency, at) => lastNotAfter(await this.payoutDay(currency, at), (row) => row.setAt, at),
    };
  }

  private marketDay(currency: CurrencyCode, at: Date): Promise<HistoryRow[]> {
    const { from, to } = dayOf(at);
    return memo(this.market, `${currency}|${String(from.getTime())}`, () => this.store.historySpan(currency, from, to));
  }

  private payoutDay(currency: CurrencyCode, at: Date): Promise<ManualRow[]> {
    const { from, to } = dayOf(at);
    return memo(this.payout, `${currency}|${String(from.getTime())}`, () => this.store.manualSpan(currency, "payout", from, to));
  }
}

function memo<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const loading = load();
  cache.set(key, loading);
  return loading;
}

/** Строки по возрастанию времени; нужна последняя не позже даты. */
function lastNotAfter<T>(rows: readonly T[], timeOf: (row: T) => Date, at: Date): T | null {
  let found: T | null = null;
  for (const row of rows) {
    if (timeOf(row).getTime() > at.getTime()) break;
    found = row;
  }
  return found;
}

function isPlatform(currency: CurrencyCode): boolean {
  return CURRENCIES[currency].kind === "platform";
}

function assertDate(at: Date): void {
  if (Number.isNaN(at.getTime())) throw new RangeError("дата курса: не дата");
}
