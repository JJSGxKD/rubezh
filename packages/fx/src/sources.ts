import type { SourceTariffs } from "./budget.js";
import type { CurrencyCode } from "./currencies.js";
import type { Quote } from "./quote.js";

/**
 * Порт источника курсов (docs/35-stage4-plan.md, §3.12). Адаптер знает, куда
 * ходить и как разобрать ответ; ядро — что с котировками делать дальше.
 *
 * **Валюта сопоставляется по метке источника**, а не по тикеру: у CoinGecko
 * это идентификатор монеты, у ЦБ — буквенный код. Тикер GRAM носит и
 * посторонний жетон в сети TON (docs/08-web-and-identity.md §6), и поиск по
 * тикеру однажды взял бы его курс. У источника (`vpnsibcom_api`) так было
 * сделано для CoinMarketCap (`coinmarketcapUCID`) — это правильная часть,
 * и она переносится.
 */

export interface SourceCurrency {
  currency: CurrencyCode;
  /** как валюта называется у источника: `the-open-network`, `USD`, `R01235` */
  sourceId: string;
}

export interface RateSource {
  id: string;
  currencies: readonly SourceCurrency[];
  tariffs: SourceTariffs;
  /** имя переменной окружения с ключом платного тарифа; нет — ключа не бывает */
  keyEnv?: string;
  /**
   * Один опрос — все валюты источника одним запросом, если источник это
   * умеет. Бросает `SourceRateLimitedError` на `429` и
   * `SourceUnavailableError` на остальное: модуль продолжает с другими.
   */
  fetch(signal: AbortSignal): Promise<Quote[]>;
}

export class SourceRateLimitedError extends Error {
  constructor(
    readonly source: string,
    readonly retryAfterMs: number | null,
  ) {
    super(`${source}: лимит запросов`);
    this.name = "SourceRateLimitedError";
  }
}

export class SourceUnavailableError extends Error {
  constructor(
    readonly source: string,
    reason: string,
  ) {
    super(`${source}: ${reason}`);
    this.name = "SourceUnavailableError";
  }
}

/**
 * Из ответа источника — только валюты, которые у него настроены, и только по
 * его метке. Незнакомые метки молча пропускаются: источник отдаёт сотни
 * валют, а нам нужны шесть.
 */
export function matchBySourceId<T>(mapping: readonly SourceCurrency[], entries: Iterable<[sourceId: string, value: T]>): Map<CurrencyCode, T> {
  const bySourceId = new Map(mapping.map((entry) => [entry.sourceId, entry.currency]));
  const matched = new Map<CurrencyCode, T>();
  for (const [sourceId, value] of entries) {
    const code = bySourceId.get(sourceId);
    if (code !== undefined) matched.set(code, value);
  }
  return matched;
}
