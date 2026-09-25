/**
 * Сравнение версий клиента площадки (docs/34-stage3-plan.md, Р11).
 *
 * Метод, которого нет в клиенте игрока, либо молча ничего не делает, либо
 * бросает ошибку: код правильный, а функция у части игроков не работает
 * (docs/33-telegram-mini-app-pitfalls.md §4). Там, где поведение при этом
 * просто беднее, адаптер обходится запасным вариантом. Там, где игра
 * становится сломанной, нужен честный экран «обновите приложение».
 *
 * Версии площадок выглядят как «7.7» или «8.0» — числа через точку. Поэтому
 * сравнение по частям, а не строками: «7.10» строкой меньше «7.7».
 */

/**
 * Дотягивает ли версия до минимума.
 *
 * **Неизвестная версия не блокирует.** Вне клиента площадки её нет вовсе —
 * так игру открывают в браузере при разработке и на стенде, — и запирать
 * такую сборку не за что: площадки, чьи методы понадобились бы, там тоже нет.
 */
export function isVersionAtLeast(version: string | null | undefined, minimum: string): boolean {
  if (version === null || version === undefined || version === "") return true;

  const actual = parseVersion(version);
  const required = parseVersion(minimum);
  if (actual === null || required === null) return true;

  const length = Math.max(actual.length, required.length);
  for (let index = 0; index < length; index++) {
    const left = actual[index] ?? 0;
    const right = required[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/** `null` — строка не похожа на версию: блокировать по ней нельзя. */
function parseVersion(value: string): number[] | null {
  const parts = value.trim().split(".");
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part) => !Number.isInteger(part) || part < 0)) return null;
  return numbers;
}
