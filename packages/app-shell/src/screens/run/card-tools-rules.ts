import type { CardTools, UpgradeOption } from "@bh/shared-types";

/**
 * Ряд действий на выборе улучшения (tasks/T-0101): какие кнопки есть, какие
 * серые и что делает тап по карточке. Чистые функции — компонент только
 * рисует, а условия проверяет тест.
 */

export type ToolId = keyof CardTools;

export interface ToolButton {
  id: ToolId;
  /** зарядов осталось */
  left: number;
  disabled: boolean;
}

/** Порядок в ряду: от безобидного к необратимому. */
const ORDER: readonly ToolId[] = ["reroll", "skip", "banish"];

export interface ToolButtonsInput {
  left: CardTools;
  total: CardTools;
  canReroll: boolean;
  offers: readonly UpgradeOption[];
}

/** Лечение — запасной вариант без предмета: его нельзя ни изгнать, ни заменить переброской. */
function hasItemCards(offers: readonly UpgradeOption[]): boolean {
  return offers.some((offer) => offer.kind !== "heal");
}

/**
 * Кнопки ряда. Вида, которого нет за весь забег, в ряду нет вовсе: новичок
 * видит три карточки, как раньше. Кончившийся заряд — серая кнопка «0»,
 * чтобы ряд не прыгал при каждом использовании.
 */
export function toolButtons(input: ToolButtonsInput): ToolButton[] {
  const items = hasItemCards(input.offers);
  const buttons: ToolButton[] = [];
  for (const id of ORDER) {
    if (input.total[id] <= 0) continue;
    const left = input.left[id];
    let usable = left > 0;
    if (id === "reroll") usable = usable && input.canReroll && items;
    if (id === "banish") usable = usable && items;
    if (id === "skip") usable = usable && input.offers.length > 0;
    buttons.push({ id, left, disabled: !usable });
  }
  return buttons;
}

export type CardTapAction = "choose" | "banish" | "ignore";

/** Что делает тап по карточке: выбор, изгнание в режиме изгнания или ничего. */
export function cardTapAction(
  mode: "choose" | "banish",
  offer: UpgradeOption,
): CardTapAction {
  if (mode === "choose") return "choose";
  return offer.kind === "heal" ? "ignore" : "banish";
}
