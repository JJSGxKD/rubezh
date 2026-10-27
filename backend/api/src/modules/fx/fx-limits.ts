import type { Tariff } from "@bh/fx";

/**
 * Лимит источника курсов из панели (docs/35-stage4-plan.md, Р89, T-0062):
 * чистые функции, без базы и Redis. Тариф источника — в коде
 * (`packages/fx/src/sources/*`), панель вправе заменить в нём только месячный
 * лимит; лимит в минуту и минимальный интервал — защита поставщика, а не
 * тариф, и не правятся.
 */

/** Порог расхода месячного лимита, о котором пишем в чат команды. */
export type BudgetThreshold = 80 | 100;

const THRESHOLDS: readonly BudgetThreshold[] = [80, 100];

/** Лимит, заданный в панели; «без лимита» — `null`, тоже значение. */
export interface LimitOverride {
  perMonth: number | null;
}

/** Тариф с лимитом из панели; `override` — `undefined`, если строки нет. */
export function effectiveTariff(tariff: Tariff, override: LimitOverride | undefined): Tariff {
  return override === undefined ? tariff : { ...tariff, perMonth: override.perMonth };
}

/**
 * Какие пороги перешли между двумя значениями счётчика того же месяца.
 * Целые числа: 80% от 10 — это ровно 8, а не «0,7999…» от десятичной дроби.
 */
export function crossedThresholds(before: number, after: number, perMonth: number | null): BudgetThreshold[] {
  if (perMonth === null || after <= before) return [];
  return THRESHOLDS.filter((threshold) => before * 100 < perMonth * threshold && after * 100 >= perMonth * threshold);
}

/** Доля лимита, которую источник уже израсходовал; без лимита её нет. Больше единицы — счётчик за лимитом. */
export function usedShare(used: number, perMonth: number | null): number | null {
  return perMonth === null ? null : used / perMonth;
}

/**
 * Источники прохода с лимитами из панели. Подмена — новым объектом
 * `{ ...source, tariff }`: сам источник не меняется, у него нет `this` и
 * общего состояния. Нет строки в панели — тот же источник.
 */
export function applyLimits<T extends { id: string; tariff: Tariff }>(sources: readonly T[], limits: ReadonlyMap<string, LimitOverride>): T[] {
  return sources.map((source) => {
    const override = limits.get(source.id);
    return override === undefined ? source : { ...source, tariff: effectiveTariff(source.tariff, override) };
  });
}
