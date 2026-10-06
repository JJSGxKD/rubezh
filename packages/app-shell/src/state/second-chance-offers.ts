import { useRun } from "./run";

/**
 * Чем можно продолжить забег на экране смерти — звёздами, рекламой — и
 * когда ждать больше нечего (docs/35-stage4-plan.md WP11). Забег закрывается
 * смертью, только когда отпали все предложения: отказ звёзд не закрывает
 * забег, пока можно продолжить за рекламу, и наоборот.
 *
 * Едет в чанке экрана смерти вместе с покупкой и рекламой.
 */

export type ContinueOffer = "stars" | "ad";

let open = new Set<ContinueOffer>();

/** Экран смерти открылся: какие предложения на нём есть. Ни одного — ждать нечего. */
export function expectOffers(offers: readonly ContinueOffer[]): void {
  open = new Set(offers);
  if (open.size === 0) decline();
}

/** Предложение отпало насовсем: купить нельзя, рекламы нет, лимит на сегодня. */
export function closeOffer(offer: ContinueOffer): void {
  if (!open.delete(offer)) return;
  if (open.size === 0) decline();
}

/**
 * Забег закрывается смертью сразу, и рекорд с местом появляются без
 * ожидания. Забег разработчика ждёт: у него есть бесплатное продолжение.
 */
function decline(): void {
  if (!useRun.getState().devRun) useRun.getState().declineContinue();
}
