import type { FixedRate, FixedRateAudit } from "../rates/fixed-rates.js";
import type { AcceptedRate, RateObservation } from "../rates/rate.js";
import type { RateSnapshot } from "../rates/snapshot.js";

/**
 * Хранилище курсов — порт. В бэкенде его реализует Postgres (история только
 * добавлением, по месяцам), здесь — память для тестов. Пакет не знает про
 * Prisma: контрактный тест (`test/contracts/rate-store.contract.ts`) гоняется
 * и по памяти, и потом по настоящему адаптеру.
 */

/** Состояние источника между циклами сбора: пауза после отказа и счётчик отказов подряд. */
export interface SourceState {
  sourceId: string;
  /** мс UTC; до этого момента источник не опрашивается */
  pausedUntil: number | null;
  consecutiveRateLimits: number;
  lastPolledAt: number | null;
  lastSucceededAt: number | null;
}

export interface SourceRequestLog {
  sourceId: string;
  at: number;
  ok: boolean;
  /** HTTP-статус, если ответ был; таймаут и обрыв — без него */
  status: number | null;
}

export interface RateStore {
  latestAccepted(): Promise<AcceptedRate[]>;
  saveAccepted(rates: readonly AcceptedRate[]): Promise<void>;

  appendObservations(observations: readonly RateObservation[]): Promise<void>;
  /** История наблюдений по валюте с момента — для разбора и графика в панели. */
  observations(currency: RateObservation["currency"], sinceMs: number): Promise<RateObservation[]>;

  /** Журнал запросов к источнику — из него считается бюджет месяца; Redis для этого не годится, счётчик там теряется. */
  logRequest(entry: SourceRequestLog): Promise<void>;
  countRequests(sourceId: string, fromMs: number, toMs: number): Promise<number>;

  sourceState(sourceId: string): Promise<SourceState | null>;
  saveSourceState(state: SourceState): Promise<void>;

  saveSnapshot(snapshot: RateSnapshot): Promise<void>;
  getSnapshot(id: string): Promise<RateSnapshot | null>;
  latestSnapshot(): Promise<RateSnapshot | null>;

  fixedRates(): Promise<FixedRate[]>;
  saveFixedRate(rate: FixedRate, audit: FixedRateAudit): Promise<void>;
  fixedRateAudit(currency: FixedRate["currency"], purpose: FixedRate["purpose"]): Promise<FixedRateAudit[]>;
}
