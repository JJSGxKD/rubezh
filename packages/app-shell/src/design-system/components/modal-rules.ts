export type ModalFooterPlacement = "none" | "scroll" | "pinned";

/**
 * Где живёт подвал модалки. Закреплять нечего без подвала, поэтому опция без
 * `footer` не снимает у тела нижний отступ. `scroll` — как у всех модалок
 * забега и листов: подвал прокручивается вместе с телом.
 */
export function modalFooterPlacement(input: { hasFooter: boolean; pinFooter: boolean }): ModalFooterPlacement {
  if (!input.hasFooter) return "none";
  return input.pinFooter ? "pinned" : "scroll";
}

export type ModalMount = "inline" | "wait" | "portal";

/**
 * Куда рисовать модалку. `undefined` — слоя модалок в дереве нет (витрина,
 * предпросмотр, серверный рендер тестов): рисуем на месте. `null` — слой
 * есть, но его узел ещё не создан: рисовать на месте нельзя, иначе окно
 * смонтируется дважды и проиграет анимацию и звук листа заново, поэтому
 * ждём. Узел есть — рисуем в него.
 */
export function modalMount<T extends object>(host: T | null | undefined): ModalMount {
  if (host === undefined) return "inline";
  return host === null ? "wait" : "portal";
}
