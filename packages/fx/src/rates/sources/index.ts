import type { SourceDefinition } from "../source.js";
import { binanceSource } from "./binance.js";
import { cbrSource } from "./cbr.js";
import { coingeckoSource } from "./coingecko.js";
import { ecbSource } from "./ecb.js";
import { openErApiSource } from "./open-er-api.js";
import { tonapiSource } from "./tonapi.js";

/**
 * Источники старта (docs/35-stage4-plan.md §3.12, таблица источников) в
 * порядке приоритета: у фиата первым идёт официальный курс, у крипты порядок
 * не важен — там медиана. Новый источник — файл рядом и строка здесь.
 */
export const DEFAULT_SOURCES: readonly SourceDefinition[] = [cbrSource, ecbSource, openErApiSource, coingeckoSource, tonapiSource, binanceSource];

export { binanceSource, cbrSource, coingeckoSource, ecbSource, openErApiSource, tonapiSource };

export function findSourceProblems(sources: readonly SourceDefinition[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) problems.push(`источник ${source.id}: идентификатор повторяется`);
    ids.add(source.id);
    if (Object.keys(source.currencies).length === 0) problems.push(`источник ${source.id}: не умеет ни одной валюты`);
    if (source.naturalIntervalMs <= 0) problems.push(`источник ${source.id}: природный интервал должен быть больше нуля`);
    for (const plan of [source.free, source.paid]) {
      if (!plan) continue;
      if (!/^https:\/\//.test(plan.baseUrl)) problems.push(`источник ${source.id}: адрес тарифа ${plan.name} не https`);
      if (plan.limits.requestsPerMinute !== null && plan.limits.requestsPerMinute <= 0) problems.push(`источник ${source.id}: лимит в минуту тарифа ${plan.name} не положителен`);
      if (plan.limits.requestsPerMonth !== null && plan.limits.requestsPerMonth <= 0) problems.push(`источник ${source.id}: лимит в месяц тарифа ${plan.name} не положителен`);
    }
    if (source.paid && !source.paid.keyHeader) problems.push(`источник ${source.id}: у платного тарифа не указан заголовок ключа`);
  }
  return problems;
}
