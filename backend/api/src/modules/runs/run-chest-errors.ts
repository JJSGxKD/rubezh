import { DomainError } from "../../common/domain-error.js";

/**
 * Отказы второго сундука клада за рекламу (tasks/T-0327, Р162). «Сервер не
 * знает забег» — тот же `ContinueRunUnverifiedError` (`run_unverified`), что у
 * второго шанса и рекламного переброса: клиент уже умеет его ждать — старт
 * забега мог ещё лежать в очереди.
 */

/** Забег закончен или второй сундук в нём уже взят — больше одного за забег не положено. */
export class AdChestUnavailableError extends DomainError {
  constructor(message = "Второй сундук в этом забеге недоступен") {
    super("chest_unavailable", message, 409);
  }
}

/** Сессия показа уже потрачена на второй сундук в другом забеге. */
export class AdChestTakenError extends DomainError {
  constructor() {
    super("chest_taken", "Этот показ уже засчитан в другом забеге", 409);
  }
}
