import type { CurrencyCode } from "../currency.js";
import { Decimal } from "../decimal.js";

/**
 * Правило округления цены — свойство валюты, а не товара
 * (docs/35-stage4-plan.md §3.12, Р33): звёзды — целые, рубли — на «…9» и
 * «…99», Gram — два знака. Округление всегда после пересчёта по курсу и до
 * проверки пределов способа.
 */
export type RoundingRule =
  /** Целое, не меньше `min`: дробной звезды не бывает, а меньше одной Telegram не принимает. */
  | { kind: "integer"; min: Decimal }
  /** `places` знаков после запятой, half_up. */
  | { kind: "decimals"; places: number }
  /** «Красивая» цена: до 100 — ближайшая на «…9», от 100 — на «…99»; не меньше 9. */
  | { kind: "charm" };

/** Рабочие значения (Р31): изменение правила — правка здесь, а не в товарах. */
export const DEFAULT_ROUNDING: Record<CurrencyCode, RoundingRule> = {
  XTR: { kind: "integer", min: Decimal.ONE },
  RUB: { kind: "charm" },
  USD: { kind: "decimals", places: 2 },
  EUR: { kind: "decimals", places: 2 },
  GRAM: { kind: "decimals", places: 2 },
  USDT: { kind: "decimals", places: 2 },
};

const CHARM_MIN = Decimal.of(9);

/** Ближайшее число вида k×step − 1: для step 10 — «…9», для 100 — «…99». */
function charm(amount: Decimal, step: number): Decimal {
  return amount.add(1).div(step, 0, "half_up").mul(step).sub(1);
}

export function roundPrice(amount: Decimal, rule: RoundingRule): Decimal {
  switch (rule.kind) {
    case "integer":
      return Decimal.max(amount.round(0, "half_up"), rule.min);
    case "decimals":
      return amount.round(rule.places, "half_up");
    case "charm": {
      const rounded = amount.lt(100) ? charm(amount, 10) : charm(amount, 100);
      return Decimal.max(rounded, CHARM_MIN);
    }
  }
}

export function findRoundingProblems(rules: Record<CurrencyCode, RoundingRule>): string[] {
  const problems: string[] = [];
  for (const [code, rule] of Object.entries(rules) as Array<[CurrencyCode, RoundingRule]>) {
    if (rule.kind === "integer" && !rule.min.isPositive()) problems.push(`округление ${code}: минимум должен быть больше нуля`);
    if (rule.kind === "decimals" && (!Number.isInteger(rule.places) || rule.places < 0 || rule.places > 18)) problems.push(`округление ${code}: число знаков вне 0..18`);
  }
  return problems;
}
