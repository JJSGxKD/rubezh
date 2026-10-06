/**
 * Свежесть курса (docs/35-stage4-plan.md, §3.12). Упали все источники —
 * остаётся последний курс с пометкой, и потребитель решает сам: цены стоят,
 * а продавать по устаревшему можно не дольше срока.
 *
 * - `fresh` — всё в порядке;
 * - `stale` — источники молчат дольше обычного: алерт `rate_stale`, но цены
 *   и продажи идут;
 * - `expired` — продавать по этому курсу нельзя.
 */

export type Freshness = "fresh" | "stale" | "expired";

export interface FreshnessPolicy {
  /** сколько курс считается свежим после того, как его видели у источника */
  staleAfterMs: number;
  /** сколько ещё после устаревания по нему можно продавать */
  sellableForMs: number;
}

/**
 * `since` — когда курс видели у источника; у заданного руками курса —
 * конец его срока годности, и `staleAfterMs` у него ноль: просрочен —
 * значит, устарел сразу.
 */
export function freshness(since: Date, now: Date, policy: FreshnessPolicy): Freshness {
  const age = now.getTime() - since.getTime();
  if (age <= policy.staleAfterMs) return "fresh";
  return age <= policy.staleAfterMs + policy.sellableForMs ? "stale" : "expired";
}
