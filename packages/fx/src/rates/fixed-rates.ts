import { isCurrencyCode, type CurrencyCode } from "../currency.js";
import { Decimal } from "../decimal.js";
import { rateKey, type AcceptedRate, type RatePurpose } from "./rate.js";

/**
 * Заданные курсы — у валют, у которых нет рынка: звёзды Telegram, голоса VK
 * (docs/35-stage4-plan.md §3.12). Правятся в панели с аудитом; у каждого —
 * срок годности: просроченный даёт алерт, а не молчаливое устаревание.
 */
export interface FixedRate {
  currency: CurrencyCode;
  purpose: RatePurpose;
  usdPerUnit: Decimal;
  /** мс UTC, включительно */
  validFrom: number;
  /** мс UTC; после — курс просрочен, но остаётся в силе до замены */
  validUntil: number;
  /** Кто задал — идентификатор администратора, а не имя: имена меняются. */
  setBy: string;
  reason: string;
}

/** Запись аудита: что было, что стало, кто и почему. Хранится рядом с курсом. */
export interface FixedRateAudit {
  currency: CurrencyCode;
  purpose: RatePurpose;
  previous: Decimal | null;
  next: Decimal;
  by: string;
  at: number;
  reason: string;
}

export function findFixedRateProblems(rates: readonly FixedRate[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, FixedRate>();

  for (const rate of rates) {
    const where = `заданный курс ${rate.currency} (${rate.purpose})`;
    if (!isCurrencyCode(rate.currency)) problems.push(`${where}: неизвестная валюта`);
    if (!rate.usdPerUnit.isPositive()) problems.push(`${where}: курс должен быть больше нуля`);
    if (rate.validUntil <= rate.validFrom) problems.push(`${where}: срок годности кончается раньше, чем начинается`);
    if (!rate.setBy) problems.push(`${where}: не указано, кто задал`);
    if (!rate.reason) problems.push(`${where}: не указана причина`);

    const key = rateKey(rate.currency, rate.purpose);
    const other = seen.get(key);
    if (other && rate.validFrom < other.validUntil && other.validFrom < rate.validUntil) {
      problems.push(`${where}: два курса действуют одновременно`);
    }
    seen.set(key, rate);
  }
  return problems;
}

/**
 * Какой заданный курс действует сейчас: начавшийся и самый поздний из них.
 * Просроченный остаётся в силе — до тех пор, пока его не заменят: цены
 * должны стоять, а не исчезать вместе со сроком.
 */
export function activeFixedRate(rates: readonly FixedRate[], currency: CurrencyCode, purpose: RatePurpose, now: number): FixedRate | null {
  let best: FixedRate | null = null;
  for (const rate of rates) {
    if (rate.currency !== currency || rate.purpose !== purpose || rate.validFrom > now) continue;
    if (!best || rate.validFrom > best.validFrom) best = rate;
  }
  return best;
}

/** Все действующие заданные курсы — как принятые, чтобы снимок собирался из одного списка. */
export function acceptedFromFixed(rates: readonly FixedRate[], now: number): AcceptedRate[] {
  const keys = new Set(rates.map((rate) => rateKey(rate.currency, rate.purpose)));
  const result: AcceptedRate[] = [];
  for (const key of keys) {
    const [currency, purpose] = key.split(":") as [CurrencyCode, RatePurpose];
    const active = activeFixedRate(rates, currency, purpose, now);
    if (!active) continue;
    result.push({
      currency,
      purpose,
      usdPerUnit: active.usdPerUnit,
      sources: ["fixed"],
      acceptedAt: active.validFrom,
      fixed: true,
      validUntil: active.validUntil,
    });
  }
  return result;
}

export function fixedRateAudit(previous: FixedRate | null, next: FixedRate, at: number): FixedRateAudit {
  return {
    currency: next.currency,
    purpose: next.purpose,
    previous: previous?.usdPerUnit ?? null,
    next: next.usdPerUnit,
    by: next.setBy,
    at,
    reason: next.reason,
  };
}

/** Строгий разбор курса из формы панели: строка, а не число, — иначе 0.013 приехало бы через float. */
export function parseFixedRateValue(text: string): Decimal {
  const value = Decimal.parse(text);
  if (!value.isPositive()) throw new Error("курс должен быть больше нуля");
  return value;
}
