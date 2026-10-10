/**
 * Правила листа «Перед забегом» (docs/35-stage4-plan.md, Р88) — чистые функции
 * без React: что показать вкладками, какая плитка буста приглушена, сколько
 * спишется и какой буст описывать под плитками.
 */

export type PreRunMode = "endless" | "dev" | "stress";

/** Цена буста из каталога сервера; других валют, кроме монет и самоцветов, в бустах нет. */
export interface BoostPriceEntry {
  id: string;
  resource: string;
  amount: number;
}

/** Вкладки режимов: только открытые; одна «Бесконечный» — вкладок нет вовсе (`[]`). */
export function preRunModes(access: { devMode: boolean; stressTest: boolean }): PreRunMode[] {
  if (!access.devMode && !access.stressTest) return [];
  return ["endless", ...(access.devMode ? (["dev"] as const) : []), ...(access.stressTest ? (["stress"] as const) : [])];
}

/** Сколько уже занято выбранными бустами в каждой валюте. */
function spentBy(selected: readonly string[], catalog: readonly BoostPriceEntry[]): { coins: number; gems: number } {
  const spent = { coins: 0, gems: 0 };
  for (const id of selected) {
    const entry = catalog.find((candidate) => candidate.id === id);
    if (entry?.resource === "coins" || entry?.resource === "gems") spent[entry.resource] += entry.amount;
  }
  return spent;
}

/**
 * Состояние плитки буста: выбрана, приглушена (не по карману или выбрано
 * максимум). Выбранную снять можно всегда. Кошелёк не загружен — баланс
 * нулевой, как и было у списка бустов.
 */
export function boostTileState(input: {
  id: string;
  selected: readonly string[];
  price: { resource: "coins" | "gems"; amount: number };
  catalog: readonly BoostPriceEntry[];
  balances: { coins: number; gems: number } | null;
  maxPerRun: number;
}): { chosen: boolean; disabled: boolean } {
  const chosen = input.selected.includes(input.id);
  const wallet = input.balances?.[input.price.resource] ?? 0;
  const affordable = chosen || wallet - spentBy(input.selected, input.catalog)[input.price.resource] >= input.price.amount;
  const full = !chosen && input.selected.length >= input.maxPerRun;
  return { chosen, disabled: !chosen && (!affordable || full) };
}

/** Что спишется за выбранные бусты — по валютам, нулевые не попадают. */
export function boostCost(selected: readonly string[], catalog: readonly BoostPriceEntry[]): { coins?: number; gems?: number } {
  const spent = spentBy(selected, catalog);
  return { ...(spent.coins > 0 ? { coins: spent.coins } : {}), ...(spent.gems > 0 ? { gems: spent.gems } : {}) };
}

/**
 * Какой буст описывать: последний тронутый — даже снятый с выбора, пока не
 * тронут другой; иначе последний выбранный; иначе никакой.
 */
export function boostToDescribe(touched: string | null, selected: readonly string[]): string | null {
  return touched ?? selected[selected.length - 1] ?? null;
}
