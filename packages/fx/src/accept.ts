import type { CurrencyCode } from "./currencies.js";
import type { Decimal } from "./decimal.js";
import type { Quote } from "./quote.js";
import type { Rate } from "./rates.js";

/**
 * Приём курса из котировок (docs/35-stage4-plan.md, §3.12, «Надёжность»):
 * ошибка одного источника не должна переписать цены.
 *
 * - несколько источников — медиана: один сошедший с ума источник её не
 *   сдвинет;
 * - два несогласных источника — не среднее, которое врёт у обоих: при
 *   прежнем курсе берётся ближний к нему, без прежнего — курс не принимается;
 * - скачок больше порога принимается, только если его подтверждает второй
 *   источник. Один источник, внезапно назвавший Gram вдвое дешевле, уходит в
 *   алерт `rate_rejected`, а цены стоят.
 */

export interface AcceptPolicy {
  /** котировка старше — не участвует: источник мог отдать кеш недельной давности */
  maxQuoteAgeMs: number;
  /** котировка из будущего дальше этого — сбой часов источника, а не курс */
  maxClockSkewMs: number;
  /** доля, на которую курс может сдвинуться без подтверждения вторым источником */
  jumpThreshold: Decimal;
  /** доля, в пределах которой две котировки считаются согласными */
  agreement: Decimal;
}

export type AcceptDecision =
  | { status: "accepted"; rate: Rate; confirmedJump: boolean }
  /** свежих котировок нет — прежний курс стоит, а свежесть решает `freshness.ts` */
  | { status: "no_quotes" }
  | { status: "rejected"; reason: "jump_unconfirmed" | "sources_disagree"; candidate: Decimal; previous: Decimal | null };

export function acceptQuotes(input: {
  currency: CurrencyCode;
  previous: Rate | null;
  quotes: readonly Quote[];
  now: Date;
  policy: AcceptPolicy;
}): AcceptDecision {
  const { policy, previous } = input;
  const fresh = latestPerSource(
    input.quotes.filter(
      (quote) =>
        quote.currency === input.currency &&
        input.now.getTime() - quote.observedAt.getTime() <= policy.maxQuoteAgeMs &&
        quote.observedAt.getTime() - input.now.getTime() <= policy.maxClockSkewMs,
    ),
  );
  if (fresh.length === 0) return { status: "no_quotes" };

  const candidate = candidateOf(fresh, previous, policy);
  if (candidate === null) {
    return { status: "rejected", reason: "sources_disagree", candidate: median(fresh.map((quote) => quote.usdPerUnit)), previous: previous?.usdPerUnit ?? null };
  }

  const supporters = fresh.filter((quote) => agrees(quote.usdPerUnit, candidate, policy.agreement));
  if (supporters.length === 0) {
    return { status: "rejected", reason: "sources_disagree", candidate, previous: previous?.usdPerUnit ?? null };
  }

  const jumped = previous !== null && deviation(candidate, previous.usdPerUnit).greaterThan(policy.jumpThreshold);
  if (jumped && supporters.length < 2) {
    return { status: "rejected", reason: "jump_unconfirmed", candidate, previous: previous.usdPerUnit };
  }

  return {
    status: "accepted",
    confirmedJump: jumped,
    rate: {
      currency: input.currency,
      usdPerUnit: candidate,
      sources: supporters.map((quote) => quote.source).sort(),
      // Самая старая из поддержавших: курс не свежее своей старейшей опоры.
      observedAt: new Date(Math.min(...supporters.map((quote) => quote.observedAt.getTime()))),
    },
  };
}

/** Относительное отклонение `|a / b − 1|`. */
export function deviation(value: Decimal, reference: Decimal): Decimal {
  return value.div(reference).minus(1).abs();
}

export function median(values: readonly Decimal[]): Decimal {
  if (values.length === 0) throw new RangeError("медиана пустого набора");
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] as Decimal;
  return sorted.length % 2 === 1 ? upper : (sorted[middle - 1] as Decimal).plus(upper).div(2);
}

function candidateOf(fresh: readonly Quote[], previous: Rate | null, policy: AcceptPolicy): Decimal | null {
  if (fresh.length !== 2) return median(fresh.map((quote) => quote.usdPerUnit));
  const [a, b] = fresh as [Quote, Quote];
  if (agrees(a.usdPerUnit, b.usdPerUnit, policy.agreement)) return median([a.usdPerUnit, b.usdPerUnit]);
  if (previous === null) return null;
  // Ближний к прежнему — и дальше он проходит проверку скачка один, без
  // подтверждения: второй источник с ним не согласен.
  return deviation(a.usdPerUnit, previous.usdPerUnit).lessThanOrEqualTo(deviation(b.usdPerUnit, previous.usdPerUnit)) ? a.usdPerUnit : b.usdPerUnit;
}

function agrees(value: Decimal, reference: Decimal, agreement: Decimal): boolean {
  return deviation(value, reference).lessThanOrEqualTo(agreement);
}

/** От источника — одна котировка, последняя: повтор опроса не удваивает его голос в медиане. */
function latestPerSource(quotes: readonly Quote[]): Quote[] {
  const bySource = new Map<string, Quote>();
  for (const quote of quotes) {
    const known = bySource.get(quote.source);
    if (known === undefined || known.observedAt < quote.observedAt) bySource.set(quote.source, quote);
  }
  return [...bySource.values()];
}
