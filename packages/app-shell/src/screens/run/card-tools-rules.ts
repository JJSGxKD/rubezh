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

/**
 * Лечение и «Предел» — варианты без предмета: их нельзя ни изгнать, ни
 * заменить переброской. Изгонять нечего: предмета, который вернулся бы в
 * следующих выборах, у них нет.
 */
function isItemCard(offer: UpgradeOption): boolean {
  return offer.kind !== "heal" && offer.kind !== "limit";
}

function hasItemCards(offers: readonly UpgradeOption[]): boolean {
  return offers.some(isItemCard);
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

/**
 * Стадия кнопки переброса за рекламу — `AdRerollStage` из `state/ad-reroll.ts`: типом, а не
 * импортом, чтобы правила остались чистыми функциями без хранилища.
 */
export type AdRerollStageView =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ready"; pass: boolean }
  | { kind: "watching"; pass: boolean }
  | { kind: "gone" };

export interface AdRerollButtonInput {
  left: CardTools;
  /** сработает ли переброс за рекламу — по движку */
  canAdReroll: boolean;
  stage: AdRerollStageView;
  /** режим изгнания включён: в нём кнопок переброса нет */
  banishing: boolean;
}

/** `hidden` — кнопки нет; `ready` — можно нажать (`pass` — VIP, без ролика); `busy` — идёт ролик. */
export type AdRerollButtonState = { kind: "hidden" } | { kind: "ready"; pass: boolean } | { kind: "busy" };

/**
 * Кнопка «Перебросить за рекламу» (tasks/T-0199). Видна, только пока зарядов
 * переброса нет, движок обещает переброс, сервер сказал «можно» (стадия `ready`)
 * или ролик идёт (`watching`), и вне режима изгнания. Пока сервер отвечает
 * (`checking`), кнопки нет — она не мигает.
 */
export function adRerollButton(input: AdRerollButtonInput): AdRerollButtonState {
  if (input.left.reroll > 0 || !input.canAdReroll || input.banishing) return { kind: "hidden" };
  if (input.stage.kind === "ready") return { kind: "ready", pass: input.stage.pass };
  if (input.stage.kind === "watching") return { kind: "busy" };
  return { kind: "hidden" };
}

export type CardTapAction = "choose" | "banish" | "ignore";

/** Что делает тап по карточке: выбор, изгнание в режиме изгнания или ничего. */
export function cardTapAction(
  mode: "choose" | "banish",
  offer: UpgradeOption,
): CardTapAction {
  if (mode === "choose") return "choose";
  return isItemCard(offer) ? "banish" : "ignore";
}
