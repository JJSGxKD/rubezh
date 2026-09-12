import type { SafeAreaInsets } from "@bh/shared-types";

/**
 * Отступы безопасной зоны Telegram складываются из двух: системной (вырез
 * камеры, полоса жестов) и контентной (кнопки Telegram поверх приложения в
 * полноэкранном режиме).
 *
 * Сложение — осознанно консервативный выбор: ничего не окажется ни под
 * вырезом, ни под кнопками. Поведение клиентов разных версий расходится, и
 * окончательное решение — «складывать или брать большую» — принимается по
 * итогам QA на устройствах (docs/27-design-system-and-app-shell.md §5.1).
 * Пока это одна функция, менять решение придётся в одном месте.
 */
export function sumInsets(
  system: Readonly<SafeAreaInsets>,
  content: Readonly<SafeAreaInsets>,
): SafeAreaInsets {
  return {
    top: safe(system.top) + safe(content.top),
    right: safe(system.right) + safe(content.right),
    bottom: safe(system.bottom) + safe(content.bottom),
    left: safe(system.left) + safe(content.left),
  };
}

export function sameInsets(
  left: Readonly<SafeAreaInsets>,
  right: Readonly<SafeAreaInsets>,
): boolean {
  return (
    left.top === right.top &&
    left.right === right.right &&
    left.bottom === right.bottom &&
    left.left === right.left
  );
}

/**
 * Площадка присылает числа, а не гарантии: отрицательный или нечисловой
 * отступ сдвинул бы интерфейс под вырез вместо того, чтобы отодвинуть от него.
 */
function safe(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
