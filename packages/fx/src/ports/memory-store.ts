import type { FixedRate, FixedRateAudit } from "../rates/fixed-rates.js";
import { rateKey, type AcceptedRate, type RateObservation } from "../rates/rate.js";
import type { RateSnapshot } from "../rates/snapshot.js";
import { cloneSnapshot } from "../rates/snapshot-codec.js";
import type { RateStore, SourceRequestLog, SourceState } from "./store.js";

/**
 * Хранилище в памяти: та же семантика, что у Postgres-адаптера, —
 * добавление в историю, замена принятого по ключу (валюта, назначение),
 * снимки по идентификатору. Значения копируются на границе, чтобы тест,
 * изменивший объект после записи, не менял «базу».
 */
export class MemoryRateStore implements RateStore {
  private readonly accepted = new Map<string, AcceptedRate>();
  private readonly history: RateObservation[] = [];
  private readonly requests: SourceRequestLog[] = [];
  private readonly states = new Map<string, SourceState>();
  private readonly snapshots = new Map<string, RateSnapshot>();
  private snapshotOrder: string[] = [];
  private readonly fixed = new Map<string, FixedRate>();
  private readonly audit: FixedRateAudit[] = [];

  async latestAccepted(): Promise<AcceptedRate[]> {
    return [...this.accepted.values()].map((rate) => ({ ...rate, sources: [...rate.sources] }));
  }

  async saveAccepted(rates: readonly AcceptedRate[]): Promise<void> {
    for (const rate of rates) this.accepted.set(rateKey(rate.currency, rate.purpose), { ...rate, sources: [...rate.sources] });
  }

  async appendObservations(observations: readonly RateObservation[]): Promise<void> {
    for (const observation of observations) this.history.push({ ...observation });
  }

  async observations(currency: RateObservation["currency"], sinceMs: number): Promise<RateObservation[]> {
    return this.history.filter((entry) => entry.currency === currency && entry.observedAt >= sinceMs).map((entry) => ({ ...entry }));
  }

  async logRequest(entry: SourceRequestLog): Promise<void> {
    this.requests.push({ ...entry });
  }

  async countRequests(sourceId: string, fromMs: number, toMs: number): Promise<number> {
    return this.requests.filter((entry) => entry.sourceId === sourceId && entry.at >= fromMs && entry.at < toMs).length;
  }

  async sourceState(sourceId: string): Promise<SourceState | null> {
    const state = this.states.get(sourceId);
    return state ? { ...state } : null;
  }

  async saveSourceState(state: SourceState): Promise<void> {
    this.states.set(state.sourceId, { ...state });
  }

  async saveSnapshot(snapshot: RateSnapshot): Promise<void> {
    if (!this.snapshots.has(snapshot.id)) this.snapshotOrder.push(snapshot.id);
    this.snapshots.set(snapshot.id, cloneSnapshot(snapshot));
  }

  async getSnapshot(id: string): Promise<RateSnapshot | null> {
    const snapshot = this.snapshots.get(id);
    return snapshot ? cloneSnapshot(snapshot) : null;
  }

  async latestSnapshot(): Promise<RateSnapshot | null> {
    let latest: RateSnapshot | null = null;
    for (const id of this.snapshotOrder) {
      const snapshot = this.snapshots.get(id)!;
      if (!latest || snapshot.at >= latest.at) latest = snapshot;
    }
    return latest ? cloneSnapshot(latest) : null;
  }

  async fixedRates(): Promise<FixedRate[]> {
    return [...this.fixed.values()].map((rate) => ({ ...rate }));
  }

  async saveFixedRate(rate: FixedRate, audit: FixedRateAudit): Promise<void> {
    this.fixed.set(`${rateKey(rate.currency, rate.purpose)}:${rate.validFrom}`, { ...rate });
    this.audit.push({ ...audit });
  }

  async fixedRateAudit(currency: FixedRate["currency"], purpose: FixedRate["purpose"]): Promise<FixedRateAudit[]> {
    return this.audit.filter((entry) => entry.currency === currency && entry.purpose === purpose).map((entry) => ({ ...entry }));
  }
}
