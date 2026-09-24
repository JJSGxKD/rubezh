/**
 * Цена второго шанса (docs/34-stage3-plan.md, Р5.1): звёзды за каждую начатую
 * минуту забега, не меньше одной — меньше Telegram не принимает — и не больше
 * потолка из конфигурации.
 *
 * Функции чистые и живут отдельно от сервиса: по ним же итог забега
 * сверяется с покупкой — не заплатил ли игрок за меньшее время, чем прошло
 * на самом деле (Р5.2).
 */

export interface ContinuePriceRules {
  starsPerMinute: number;
  maxStars: number;
}

/**
 * Сколько минут забега начато к этой секунде. Время округляется до
 * миллисекунды раньше деления: секунды забега — сумма тиков по 1/60, и
 * «120» в них бывает «120.00000000000001» — лишняя звезда за шум плавающей
 * точки.
 */
export function startedMinutes(elapsedSec: number): number {
  const ms = Math.round(Math.max(elapsedSec, 0) * 1000);
  return Math.max(1, Math.ceil(ms / 60_000));
}

export function continuePrice(elapsedSec: number, rules: ContinuePriceRules): number {
  return Math.min(rules.maxStars, startedMinutes(elapsedSec) * rules.starsPerMinute);
}
