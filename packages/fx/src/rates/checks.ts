import { Decimal } from "../decimal.js";
import { RATE_SCALE } from "./rate.js";

/**
 * Проверки принимаемого курса (docs/35-stage4-plan.md §3.12, «Надёжность»).
 * Скачок больше порога без подтверждения вторым источником не принимается:
 * ошибка источника не должна переписать цены.
 */
export interface SpikeRules {
  /** Доля изменения относительно последнего принятого, выше которой нужен второй источник: 0.15 — 15 %. */
  maxJumpRatio: Decimal;
  /** Насколько близко должны сойтись независимые источники, чтобы подтвердить скачок: 0.03 — 3 %. */
  confirmWithinRatio: Decimal;
}

/** Рабочие значения (Р31): фиат за сутки на 15 % не ходит, у крипты порог тот же — и она через медиану. */
export const DEFAULT_SPIKE_RULES: SpikeRules = {
  maxJumpRatio: Decimal.of("0.15"),
  confirmWithinRatio: Decimal.of("0.03"),
};

export type SpikeVerdict =
  | { ok: true; jumpRatio: Decimal | null; confirmedBy: readonly string[] }
  | { ok: false; reason: "jump_unconfirmed"; jumpRatio: Decimal; confirmedBy: readonly string[] };

export interface IndependentQuote {
  sourceId: string;
  usdPerUnit: Decimal;
}

/** |a − b| / |b| — относительное изменение; при b = 0 — «бесконечность» как очень большое число. */
export function relativeChange(candidate: Decimal, previous: Decimal): Decimal {
  if (previous.isZero()) return candidate.isZero() ? Decimal.ZERO : Decimal.of("1e9");
  return candidate.sub(previous).abs().div(previous.abs(), RATE_SCALE);
}

/**
 * Скачок принимается, только если не меньше двух **разных** источников
 * сошлись около кандидата. Один источник с любым значением — не
 * подтверждение: именно он, вероятно, и ошибся.
 */
export function checkSpike(previous: Decimal | null, candidate: Decimal, quotes: readonly IndependentQuote[], rules: SpikeRules): SpikeVerdict {
  if (previous === null) return { ok: true, jumpRatio: null, confirmedBy: quotes.map((quote) => quote.sourceId) };

  const jumpRatio = relativeChange(candidate, previous);
  if (jumpRatio.lte(rules.maxJumpRatio)) return { ok: true, jumpRatio, confirmedBy: [] };

  const confirmedBy = [...new Set(quotes.filter((quote) => relativeChange(quote.usdPerUnit, candidate).lte(rules.confirmWithinRatio)).map((quote) => quote.sourceId))];
  if (confirmedBy.length >= 2) return { ok: true, jumpRatio, confirmedBy };
  return { ok: false, reason: "jump_unconfirmed", jumpRatio, confirmedBy };
}
