import type { CurrencyCode } from "./currencies.js";
import type { ManualRate, ManualRatePurpose } from "./manual.js";
import type { Quote } from "./quote.js";
import type { Rate, RatesSnapshot } from "./rates.js";
import type { RateStore, SourceState, StoredRate } from "./store.js";

/**
 * Хранилище курсов в памяти процесса — для тестов и для сервиса курсов в
 * одном экземпляре. Смысл тот же, что у Postgres: история только
 * добавляется, у источника по валюте — одна последняя котировка, снимок
 * неизменяем. Проверяется тем же контрактным тестом.
 */
export class MemoryRateStore implements RateStore {
  private readonly quotes = new Map<string, Quote>();
  private readonly current = new Map<CurrencyCode, StoredRate>();
  private readonly history: StoredRate[] = [];
  private readonly sources = new Map<string, SourceState>();
  private readonly manual: ManualRate[] = [];
  private readonly snapshots = new Map<string, RatesSnapshot>();
  private sequence = 0;

  async latestQuotes(currency: CurrencyCode): Promise<Quote[]> {
    return [...this.quotes.values()].filter((quote) => quote.currency === currency);
  }

  async saveQuotes(quotes: readonly Quote[]): Promise<void> {
    for (const quote of quotes) this.quotes.set(`${quote.source}:${quote.currency}`, quote);
  }

  async currentRate(currency: CurrencyCode): Promise<StoredRate | null> {
    return this.current.get(currency) ?? null;
  }

  async setCurrentRate(rate: Rate, acceptedAt: Date): Promise<void> {
    this.current.set(rate.currency, { ...rate, acceptedAt });
  }

  async appendHistory(rate: Rate, acceptedAt: Date): Promise<void> {
    this.history.push({ ...rate, acceptedAt });
  }

  async lastHistoryAt(currency: CurrencyCode): Promise<Date | null> {
    const entries = this.history.filter((entry) => entry.currency === currency);
    return entries.at(-1)?.acceptedAt ?? null;
  }

  async sourceState(source: string): Promise<SourceState | null> {
    return this.sources.get(source) ?? null;
  }

  async saveSourceState(source: string, state: SourceState): Promise<void> {
    this.sources.set(source, state);
  }

  async currentManual(currency: CurrencyCode, purpose: ManualRatePurpose): Promise<ManualRate | null> {
    const entries = this.manual.filter((rate) => rate.currency === currency && rate.purpose === purpose);
    return entries.reduce<ManualRate | null>((latest, rate) => (latest === null || rate.setAt >= latest.setAt ? rate : latest), null);
  }

  async appendManual(rate: ManualRate): Promise<void> {
    this.manual.push(rate);
  }

  async saveSnapshot(snapshot: Omit<RatesSnapshot, "id">): Promise<RatesSnapshot> {
    const saved: RatesSnapshot = { ...snapshot, id: `memory-${++this.sequence}`, rates: new Map(snapshot.rates), payout: new Map(snapshot.payout) };
    this.snapshots.set(saved.id, saved);
    return saved;
  }

  async snapshot(id: string): Promise<RatesSnapshot | null> {
    return this.snapshots.get(id) ?? null;
  }

  /** история — для тестов: что и сколько раз попало */
  historyOf(currency: CurrencyCode): readonly StoredRate[] {
    return this.history.filter((entry) => entry.currency === currency);
  }
}
