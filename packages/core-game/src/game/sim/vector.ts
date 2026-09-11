/**
 * Длина вектора без `Math.hypot`.
 *
 * `hypot`, как и тригонометрия, по спецификации ECMAScript приближённая:
 * V8 на Android и JavaScriptCore на iOS вправе расходиться в последних битах,
 * а за тысячи тиков это другой исход забега и неповторяемый баг-репорт
 * (docs/26-stage2-plan.md, WP4.5). `Math.sqrt` по IEEE 754 точный.
 */
export function vectorLength(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}
