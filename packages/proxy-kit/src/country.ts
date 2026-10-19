/**
 * Страна узла по названию: пара региональных индикаторов (флаг) в любом месте
 * либо `[DE]` / `(DE)` в начале. Существование страны не проверяется — это
 * подсказка для выбора узла, а не справочник.
 */
const REGIONAL_A = 0x1f1e6;
const REGIONAL_Z = 0x1f1ff;
const PREFIX = /^\s*[[(]([A-Za-z]{2})[\])]/;

export function countryOfName(name: string): string | null {
  const points = [...name].map((symbol) => symbol.codePointAt(0) ?? 0);
  for (let i = 0; i + 1 < points.length; i++) {
    const first = points[i] ?? 0;
    const second = points[i + 1] ?? 0;
    if (first >= REGIONAL_A && first <= REGIONAL_Z && second >= REGIONAL_A && second <= REGIONAL_Z) {
      return String.fromCharCode(65 + first - REGIONAL_A, 65 + second - REGIONAL_A);
    }
  }
  const match = PREFIX.exec(name);
  return match?.[1] === undefined ? null : match[1].toUpperCase();
}
