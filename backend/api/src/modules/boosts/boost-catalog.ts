import type { WalletResource } from "../wallet/wallet-types.js";

/**
 * Цены бустов (docs/35-stage4-plan.md §3.5, Р39). Числа рабочие (Р31).
 *
 * Что буст делает в бою, знает движок (`core-game/src/content/boosts.ts`);
 * здесь — только цена и потолок. Список id обязан совпадать с контентом
 * движка — это проверяет тест: буст, который продаётся, но ничего не делает,
 * — это деньги игрока, списанные зря.
 *
 * Параметры и щит — за монеты: забег в 10–15 минут на буст (Р36). «Фора» и
 * «Чутьё» — за самоцветы: они сильнее меняют темп забега, чем прибавка.
 */

export type BoostCurrency = Extract<WalletResource, "coins" | "gems">;

export interface BoostPrice {
  resource: BoostCurrency;
  amount: number;
}

export const BOOST_PRICES: Readonly<Record<string, BoostPrice>> = {
  fury: { resource: "coins", amount: 150 },
  bulwark: { resource: "coins", amount: 150 },
  lure: { resource: "coins", amount: 100 },
  aegis: { resource: "coins", amount: 120 },
  head_start: { resource: "gems", amount: 4 },
  insight: { resource: "gems", amount: 6 },
};

/** Не больше бустов на забег — столько же, сколько применяет движок. */
export const MAX_BOOSTS_PER_RUN = 3;

export const BOOST_IDS: readonly string[] = Object.keys(BOOST_PRICES);

/** Цена набора по ресурсам; незнакомый id — `null`: такой набор не продаётся. */
export function priceOf(boosts: readonly string[]): Partial<Record<BoostCurrency, number>> | null {
  const cost: Partial<Record<BoostCurrency, number>> = {};
  for (const id of boosts) {
    const price = BOOST_PRICES[id];
    if (price === undefined) return null;
    cost[price.resource] = (cost[price.resource] ?? 0) + price.amount;
  }
  return cost;
}
