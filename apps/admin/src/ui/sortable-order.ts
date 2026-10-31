/**
 * Порядок списка в панели (tasks/T-0167): чистые функции переноса и тексты для
 * экранного диктора. Без React и без перетаскивания — компонент
 * `sortable-list.tsx` поверх dnd-kit тонкий, а всё, что можно сломать
 * незаметно, лежит здесь и проверяется тестом.
 */

/** Перенести `id` на место `overId`; неизвестный id или место — копия без изменений. */
export function moveItem(ids: readonly string[], id: string, overId: string): string[] {
  const from = ids.indexOf(id);
  const to = ids.indexOf(overId);
  const next = [...ids];
  if (from < 0 || to < 0 || from === to) return next;
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Элементы в порядке `ids`. Не названные в `ids` идут в конец в прежнем порядке,
 * лишние id пропускаются: список мог измениться, пока порядок был в пути.
 */
export function applyOrder<T>(items: readonly T[], ids: readonly string[], idOf: (item: T) => string): T[] {
  const byId = new Map(items.map((item) => [idOf(item), item]));
  const named = ids.flatMap((id) => {
    const item = byId.get(id);
    return item === undefined ? [] : [item];
  });
  const listed = new Set(ids);
  return [...named, ...items.filter((item) => !listed.has(idOf(item)))];
}

export const INSTRUCTIONS = "Чтобы переставить, нажмите пробел или Enter. Стрелки двигают элемент, пробел или Enter кладёт на место, Escape отменяет.";

export function pickUpText(label: string, place: number, total: number): string {
  return `Взяли «${label}», место ${String(place)} из ${String(total)}.`;
}

export function moveText(label: string, place: number, total: number): string {
  return `«${label}»: место ${String(place)} из ${String(total)}.`;
}

export function dropText(label: string, place: number, total: number, moved: boolean): string {
  return moved ? `«${label}» положили на место ${String(place)} из ${String(total)}.` : `«${label}» осталось на месте ${String(place)} из ${String(total)}.`;
}

export function cancelText(label: string, place: number, total: number): string {
  return `Перестановка «${label}» отменена, место ${String(place)} из ${String(total)}.`;
}
