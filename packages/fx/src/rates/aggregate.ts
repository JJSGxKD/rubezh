import { Decimal } from "../decimal.js";
import { RATE_SCALE } from "./rate.js";

/**
 * Свод нескольких котировок в одно значение. У крипты — медиана: один
 * съехавший источник её не сдвигает. У фиата — приоритетный источник:
 * официальный курс ЦБ — это курс, а не одно из мнений.
 */
export type AggregationStrategy = "median" | "priority";

export interface Quote {
  sourceId: string;
  usdPerUnit: Decimal;
}

export function median(values: readonly Decimal[]): Decimal {
  if (values.length === 0) throw new Error("медиана пустого списка");
  const sorted = [...values].sort((a, b) => a.cmp(b));
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return sorted[middle - 1]!.add(sorted[middle]!).div(2, RATE_SCALE);
}

export interface Aggregated {
  usdPerUnit: Decimal;
  sources: readonly string[];
}

/**
 * `priority` — список идентификаторов источников от главного к запасному;
 * берётся первый, у которого есть котировка. Остальные в `sources` не
 * попадают: они не участвовали в значении, а только подтверждают скачок.
 */
export function aggregate(quotes: readonly Quote[], strategy: AggregationStrategy, priority: readonly string[]): Aggregated | null {
  if (quotes.length === 0) return null;

  if (strategy === "median") {
    return { usdPerUnit: median(quotes.map((quote) => quote.usdPerUnit)), sources: [...new Set(quotes.map((quote) => quote.sourceId))] };
  }

  for (const sourceId of priority) {
    const quote = quotes.find((entry) => entry.sourceId === sourceId);
    if (quote) return { usdPerUnit: quote.usdPerUnit, sources: [sourceId] };
  }
  // Источника из списка приоритетов нет — берём любой: лучше курс запасного, чем никакого.
  const first = quotes[0]!;
  return { usdPerUnit: first.usdPerUnit, sources: [first.sourceId] };
}
