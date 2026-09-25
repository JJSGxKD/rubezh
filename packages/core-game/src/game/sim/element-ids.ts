import { ELEMENTS, type ElementId } from "@bh/shared-types";

/**
 * Индексы стихий и коридор сопротивлений — отдельно от логики состояний
 * (`elements.ts`): их читает разбор контента, а он едет в первой загрузке
 * оболочки вместе с гайдбуком и выбором оружия. Сами состояния нужны только
 * забегу и едут с движком.
 */

export const ELEMENT_PHYSICAL = 0;
export const ELEMENT_FIRE = 1;
export const ELEMENT_COLD = 2;
export const ELEMENT_LIGHTNING = 3;
export const ELEMENT_POISON = 4;

export function elementIndex(element: ElementId | undefined): number {
  return element === undefined ? ELEMENT_PHYSICAL : ELEMENTS.indexOf(element);
}

/**
 * Сопротивление — доля гашения, и её коридор: больше 0.9 — иммунитет, в
 * который упёрлась бы любая сборка; меньше −1 — уязвимость больше двойной.
 * Проверяется тестом контента.
 */
export const MIN_RESIST = -1;
export const MAX_RESIST = 0.9;
