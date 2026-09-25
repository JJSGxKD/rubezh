import { DomainError } from "../../common/domain-error.js";

/**
 * Отказы оплаты — у каждого свой код: клиент ветвится по нему
 * (docs/15-engineering-standards.md §2.3). «Старт не дошёл» и «продолжения
 * кончились» игрок видит по-разному: первое лечится повтором, второе — нет.
 */

/** Аккаунт не из Telegram — например, вход разработчика: платить за него нечем. */
export class PaymentsUnsupportedError extends DomainError {
  constructor() {
    super("payments_unsupported", "Оплата звёздами — только в Telegram", 409);
  }
}

/** Забег закончен или продолжений за забег больше не положено. */
export class ContinueUnavailableError extends DomainError {
  constructor(message: string) {
    super("continue_unavailable", message, 409);
  }
}

/**
 * Сервер не знает, когда начался забег, и не может посчитать минуты по своим
 * часам (Р5.2). Чаще всего старт ещё лежит в очереди клиента: клиент досылает
 * её и спрашивает снова.
 */
export class RunUnverifiedError extends DomainError {
  constructor() {
    super("run_unverified", "Сервер не знает, когда начался забег", 409);
  }
}

/** Заявлено больше секунд забега, чем прошло по часам сервера (Р5.2). */
export class ElapsedExceedsClockError extends DomainError {
  constructor() {
    super("elapsed_exceeds_clock", "Забег не мог длиться столько", 400);
  }
}

export class PurchaseNotFoundError extends DomainError {
  constructor() {
    super("purchase_not_found", "Покупка не найдена", 404);
  }
}

/** Telegram не выставил счёт: сеть или сам Bot API. Повтор безопасен. */
export class PaymentsUnavailableError extends DomainError {
  constructor() {
    super("payments_unavailable", "Оплата временно недоступна — попробуйте ещё раз", 503);
  }
}
