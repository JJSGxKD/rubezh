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
