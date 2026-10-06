import { useShell } from "./shell";

/**
 * Можно ли предложить игроку второй шанс. Модуль нарочно крошечный:
 * он нужен в первой загрузке — при старте забега решается, ждать ли на
 * экране смерти, — а сама оплата едет в чанке экрана смерти.
 *
 * Покупку предлагают, когда площадка умеет открыть окно оплаты, игра открыта
 * в ней, а не в браузере, и есть вход в аккаунт — покупка принадлежит ему. Что
 * оплата выключена на сервере, клиент узнаёт по первому ответу и дальше в
 * этом запуске её не предлагает.
 */

let paymentsOff = false;

export function canOfferPaidContinue(): boolean {
  if (paymentsOff) return false;
  const { adapter, capabilities } = useShell.getState();
  return adapter.openInvoice !== undefined && capabilities.platformAvailable && capabilities.auth !== undefined;
}

/**
 * Ждать ли на экране смерти: второй шанс можно купить или взять за рекламу
 * (WP11). Есть ли реклама сейчас, скажет сервер — не будет ни её, ни
 * покупки, забег закроется смертью сразу (`second-chance-offers.ts`).
 */
export function canOfferContinue(): boolean {
  const { adapter, capabilities } = useShell.getState();
  return canOfferPaidContinue() || (adapter.showAd !== undefined && capabilities.platformAvailable && capabilities.auth !== undefined);
}

/** Сервер ответил, что оплаты нет или этому аккаунту платить нечем. */
export function markPaymentsOff(): void {
  paymentsOff = true;
}

export function resetPaymentsAvailabilityForTests(): void {
  paymentsOff = false;
}
