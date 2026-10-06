import type { CurrencyCode } from "../currencies.js";
import { Decimal, decimal, type DecimalInput } from "../decimal.js";

/**
 * Округление цены для игрока (docs/35-stage4-plan.md, §3.12, Р33). Всегда
 * **вверх**: цена после пересчёта не должна оказаться ниже базовой — иначе
 * каждая продажа через этот способ дешевле, чем задумано.
 *
 * - звёзды — целые: дробной звезды не бывает;
 * - рубли — «психологическая» цена: до тысячи — на девятку (87 → 89, 243 →
 *   249), от тысячи — на 99 (1 087 → 1 099);
 * - доллары и евро — на .99 (4.20 → 4.99);
 * - Gram и USDT — до сотых: у крипты «красивой» цены нет, а девять знаков
 *   Gram игроку не показывают.
 */

export type PriceRounding =
  | { kind: "integer" }
  | { kind: "charm_rub" }
  | { kind: "charm_cents" }
  | { kind: "step"; step: string };

export const PRICE_ROUNDING: Record<CurrencyCode, PriceRounding> = {
  XTR: { kind: "integer" },
  RUB: { kind: "charm_rub" },
  USD: { kind: "charm_cents" },
  EUR: { kind: "charm_cents" },
  GRAM: { kind: "step", step: "0.01" },
  USDT: { kind: "step", step: "0.01" },
};

export function roundPrice(amount: DecimalInput, code: CurrencyCode): Decimal {
  const value = decimal(amount);
  if (value.isNegative() || value.isZero()) throw new RangeError(`цена ${code} должна быть больше нуля`);
  const rule = PRICE_ROUNDING[code];
  switch (rule.kind) {
    case "integer":
      return value.ceil();
    case "charm_rub": {
      // Порог — по уже округлённому целому: 999.5 ₽ — это 1 000, и цена
      // 1 099, а не 1 009.
      const whole = value.ceil();
      return whole.lessThan(1000) ? upToEnding(whole, 10, 9) : upToEnding(whole, 100, 99);
    }
    case "charm_cents":
      // Ближайшее «x.99» не ниже цены: 4.20 → 4.99, 5.00 → 5.99.
      return value.plus("0.01").ceil().minus("0.01");
    case "step": {
      const step = new Decimal(rule.step);
      return value.div(step).ceil().mul(step);
    }
  }
}

/** Наименьшее целое не ниже `whole` с остатком `ending` при делении на `base`: 243 → 249 при (10, 9). */
function upToEnding(whole: Decimal, base: number, ending: number): Decimal {
  const rest = whole.mod(base).toNumber();
  return rest <= ending ? whole.plus(ending - rest) : whole.plus(base - rest + ending);
}
