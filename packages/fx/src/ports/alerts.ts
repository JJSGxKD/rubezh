import type { CurrencyCode } from "../currency.js";
import type { Decimal } from "../decimal.js";
import type { StaleReason } from "../rates/freshness.js";
import type { RatePurpose } from "../rates/rate.js";

/**
 * Алерты модуля курсов (docs/35-stage4-plan.md, WP9, «Аналитика»):
 * `rate_rejected` — скачок не принят, `rate_stale` — источник молчит или
 * заданный курс просрочен. Пакет их только порождает; куда они уходят — в
 * чат администраторов, в метрики, в события — решает модуль бэкенда.
 */
export interface RateRejectedAlert {
  kind: "rate_rejected";
  currency: CurrencyCode;
  previous: Decimal;
  candidate: Decimal;
  jumpRatio: Decimal;
  /** Кто дал кандидата и кто его подтвердил (подтвердивших меньше двух — потому и отклонён). */
  sources: readonly string[];
  confirmedBy: readonly string[];
  at: number;
}

export interface RateStaleAlert {
  kind: "rate_stale";
  currency: CurrencyCode;
  purpose: RatePurpose;
  reason: StaleReason;
  overdueMs: number;
  lastAcceptedAt: number;
  at: number;
}

export type FxAlert = RateRejectedAlert | RateStaleAlert;

export interface FxAlerts {
  emit(alert: FxAlert): void;
}

export const noAlerts: FxAlerts = { emit: () => undefined };

/** Копилка алертов для тестов. */
export class CollectingAlerts implements FxAlerts {
  readonly alerts: FxAlert[] = [];

  emit(alert: FxAlert): void {
    this.alerts.push(alert);
  }

  ofKind<K extends FxAlert["kind"]>(kind: K): Extract<FxAlert, { kind: K }>[] {
    return this.alerts.filter((alert): alert is Extract<FxAlert, { kind: K }> => alert.kind === kind);
  }
}
