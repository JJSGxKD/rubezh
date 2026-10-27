/**
 * Готовые суммы доната (docs/35-stage4-plan.md, Р109): строка из панели —
 * «50, 100, 250» — и то, что из неё остаётся для способа оплаты площадки.
 *
 * Правило живёт здесь, а схема ключа каталога (`settings/setting-catalog.ts`)
 * и панель (`apps/admin/src/api/settings.ts`, там копия) проверяют по нему же:
 * пакетов между бэкендом и панелью нет.
 */

/** Одна готовая сумма — не больше: свыше предела любого способа оплаты, но не мусор из лишних нулей. */
export const AMOUNT_MAX = 100_000;

/** Больше восьми кнопок на листе не помещается, и до последних не доходят. */
export const AMOUNTS_MAX_COUNT = 8;

export const AMOUNTS_PROBLEM = "от одной до восьми сумм через запятую, например 50, 100, 250";

const DIGITS = /^\d{1,6}$/;

/**
 * Суммы из строки в порядке записи; `null` — строка не годится: пусто, не целое,
 * нуль, больше `AMOUNT_MAX`, пустой элемент между запятыми или больше восьми сумм.
 */
export function parseAmounts(value: string): number[] | null {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length > AMOUNTS_MAX_COUNT) return null;
  const amounts: number[] = [];
  for (const part of parts) {
    if (!DIGITS.test(part)) return null;
    const amount = Number(part);
    if (amount < 1 || amount > AMOUNT_MAX) return null;
    amounts.push(amount);
  }
  return amounts;
}

/**
 * Что показать кнопками: суммы в пределах способа оплаты, без повторов, по
 * возрастанию. Негодная строка не роняет лист доната — готовых сумм просто нет,
 * игрок вводит свою.
 */
export function presetsFor(raw: string, min: number, max: number): number[] {
  const inRange = (parseAmounts(raw) ?? []).filter((amount) => amount >= min && amount <= max);
  return [...new Set(inRange)].sort((a, b) => a - b);
}
