import type { SourceUsage } from "./budget.js";
import type { CurrencyCode } from "./currencies.js";
import type { ManualRate, ManualRatePurpose } from "./manual.js";
import type { Quote } from "./quote.js";
import type { Rate, RatesSnapshot } from "./rates.js";

/**
 * Порт хранилища курсов (docs/35-stage4-plan.md, §3.12). Ядро не знает, где
 * лежат курсы: у бэкенда игры — Postgres, у будущего сервиса курсов — что
 * угодно, лишь бы проходил контрактный тест (`test/store-contract.ts`).
 *
 * История принятых курсов — только добавлением: по ней воспроизводится, по
 * какому курсу посчитана цена в прошлом месяце.
 */
export interface RateStore {
  /** последняя котировка каждого источника по валюте — голоса медианы */
  latestQuotes(currency: CurrencyCode): Promise<Quote[]>;
  /** котировка источника по валюте заменяет его прежнюю */
  saveQuotes(quotes: readonly Quote[]): Promise<void>;

  /** последний принятый курс — по нему считается свежесть */
  currentRate(currency: CurrencyCode): Promise<StoredRate | null>;
  /**
   * Принятый курс становится текущим — и тогда, когда он тот же: его
   * подтвердили, и он снова свежий. В историю пишется не каждый
   * (`refresh.ts`), поэтому текущий и история — два действия.
   */
  setCurrentRate(rate: Rate, acceptedAt: Date): Promise<void>;
  appendHistory(rate: Rate, acceptedAt: Date): Promise<void>;
  /** когда курс последний раз попал в историю — чтобы писать его не чаще раза в час */
  lastHistoryAt(currency: CurrencyCode): Promise<Date | null>;

  /** бюджет запросов источника и когда спрашивать его снова */
  sourceState(source: string): Promise<SourceState | null>;
  saveSourceState(source: string, state: SourceState): Promise<void>;

  /** действующий заданный курс: последний поставленный по валюте и цели */
  currentManual(currency: CurrencyCode, purpose: ManualRatePurpose): Promise<ManualRate | null>;
  appendManual(rate: ManualRate): Promise<void>;

  /** снимок неизменяем; идентификатор даёт хранилище */
  saveSnapshot(snapshot: Omit<RatesSnapshot, "id">): Promise<RatesSnapshot>;
  snapshot(id: string): Promise<RatesSnapshot | null>;
}

export interface StoredRate extends Rate {
  acceptedAt: Date;
}

export interface SourceState {
  usage: SourceUsage;
  nextPollAt: Date;
}
