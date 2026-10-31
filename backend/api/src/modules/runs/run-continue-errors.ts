import { DomainError } from "../../common/domain-error.js";

/**
 * Отказы второго шанса за рекламу и самоцветы (docs/35-stage4-plan.md WP11,
 * Р162) — у каждого свой код: экран смерти говорит игроку разное. Коды
 * `run_unverified`, `continue_unavailable` и `elapsed_exceeds_clock` — те же,
 * что у покупки за звёзды: для клиента это одно и то же «старт не дошёл»,
 * «продолжать нечего» и «забег не мог длиться столько».
 */

/** Сервер не видел старта забега — чаще всего он ещё в очереди клиента. */
export class ContinueRunUnverifiedError extends DomainError {
  constructor() {
    super("run_unverified", "Сервер не знает этот забег", 409);
  }
}

/** Забег закончен или продолжений за забег больше не положено. */
export class ContinueUnavailableError extends DomainError {
  constructor(message: string) {
    super("continue_unavailable", message, 409);
  }
}

/** То же для продолжения за рекламу: отдельное имя — в тестах и логах видно, о каком способе речь. */
export class AdContinueUnavailableError extends ContinueUnavailableError {}

/** Заявлено больше секунд забега, чем прошло по часам сервера (Р5.2): цена по такой секунде занижена. */
export class ContinueElapsedExceedsClockError extends DomainError {
  constructor() {
    super("elapsed_exceeds_clock", "Забег не мог длиться столько", 400);
  }
}

/** Это продолжение уже взято — за звёзды, самоцветы или другой сессией показа. */
export class ContinueTakenError extends DomainError {
  constructor() {
    super("continue_taken", "Это продолжение уже взято", 409);
  }
}

/** Рекламных продолжений на сегодня больше нет (Р4, Р162) — остаются самоцветы и звёзды. */
export class AdContinueDailyCapError extends DomainError {
  constructor(message = "Продолжения за рекламу на сегодня закончились") {
    super("ad_continue_daily_cap", message, 409);
  }
}
