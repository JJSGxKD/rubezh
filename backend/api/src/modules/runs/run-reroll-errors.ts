import { DomainError } from "../../common/domain-error.js";

/**
 * Отказы переброса карточек за рекламу (tasks/T-0199, Р133). «Сервер не знает
 * забег» — тот же `ContinueRunUnverifiedError` (`run_unverified`), что у
 * второго шанса: клиент уже умеет его ждать — старт забега мог ещё лежать в
 * очереди.
 */

/** Забег закончен или рекламный переброс в нём уже взят — больше одного за забег не положено. */
export class AdRerollUnavailableError extends DomainError {
  constructor(message = "Переброс за рекламу в этом забеге недоступен") {
    super("reroll_unavailable", message, 409);
  }
}

/** Сессия показа уже потрачена на переброс в другом забеге. */
export class AdRerollTakenError extends DomainError {
  constructor() {
    super("reroll_taken", "Этот показ уже засчитан в другом забеге", 409);
  }
}
