import type { CheckoutAnswer } from "../../platforms/ports/payment-provider.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { INVOICE_TTL_SEC } from "./payments-limits.js";
import type { CheckoutView } from "./purchases.repository.js";

/**
 * Предварительная проверка оплаты (docs/34-stage3-plan.md, WP5, п. 6):
 * последняя точка, где можно отказаться от денег, а не возвращать их.
 * Функция чистая — покупка, запрос площадки и часы приходят снаружи, —
 * поэтому каждый отказ проверяется отдельно.
 *
 * Отказ площадка показывает игроку текстом из ответа, поэтому текст — для
 * игрока: что случилось и что делать, без внутренних подробностей.
 */

export interface PreCheckout {
  platform: PlatformId;
  queryId: string;
  /** кто платит — идентификатор на площадке */
  payerId: string;
  currency: string;
  totalAmount: number;
  payload: string;
}

export type CheckoutRefusal =
  | "disabled"
  | "unknown_invoice"
  | "foreign_user"
  | "already_paid"
  | "price_mismatch"
  | "stale_invoice"
  | "run_finished"
  | "unavailable";

export type CheckoutDecision = { ok: true } | { ok: false; reason: CheckoutRefusal };

const MESSAGES: Record<CheckoutRefusal, string> = {
  disabled: "Оплата сейчас недоступна.",
  unknown_invoice: "Счёт не найден — откройте продолжение в игре заново.",
  foreign_user: "Этот счёт выставлен другому игроку.",
  already_paid: "Это продолжение уже оплачено — вернитесь в игру.",
  price_mismatch: "Цена изменилась — откройте продолжение в игре заново.",
  stale_invoice: "Счёт устарел — откройте продолжение в игре заново.",
  run_finished: "Забег уже закончен — продолжать нечего.",
  unavailable: "Оплата временно недоступна — попробуйте ещё раз.",
};

export function decideCheckout(view: CheckoutView | null, query: PreCheckout, nowMs: number, enabled: boolean): CheckoutDecision {
  if (!enabled) return refuse("disabled");
  if (view === null) return refuse("unknown_invoice");
  const { purchase } = view;
  // Счёт по пересланной ссылке оплачивает не тот, кому он выставлен: забег,
  // а значит и продолжение, — чужие.
  if (query.payerId !== view.platformUserId) return refuse("foreign_user");
  if (purchase.status !== "pending") return refuse("already_paid");
  // Сумма — та, на которую выставлен последний счёт. Старая ссылка после
  // повторного счёта с другой ценой сюда не пройдёт.
  if (query.currency !== "XTR" || query.totalAmount !== purchase.chargedStars) return refuse("price_mismatch");
  if (nowMs - purchase.invoicedAt.getTime() > INVOICE_TTL_SEC * 1000) return refuse("stale_invoice");
  if (view.runFinished) return refuse("run_finished");
  return { ok: true };
}

export function answerOf(decision: CheckoutDecision): CheckoutAnswer {
  return decision.ok ? { ok: true } : { ok: false, errorMessage: MESSAGES[decision.reason] };
}

export function refuse(reason: CheckoutRefusal): CheckoutDecision {
  return { ok: false, reason };
}
