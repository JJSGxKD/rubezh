import { DomainError } from "../../common/domain-error.js";

/**
 * Отказы второго шанса за рекламу (docs/35-stage4-plan.md WP11) — у каждого
 * свой код: экран смерти говорит игроку разное. Коды `run_unverified` и
 * `continue_unavailable` — те же, что у покупки за звёзды: для клиента это
 * одно и то же «старт не дошёл» и «продолжать нечего».
 */

/** Сервер не видел старта забега — чаще всего он ещё в очереди клиента. */
export class ContinueRunUnverifiedError extends DomainError {
  constructor() {
    super("run_unverified", "Сервер не знает этот забег", 409);
  }
}

/** Забег закончен или продолжений за забег больше не положено. */
export class AdContinueUnavailableError extends DomainError {
  constructor(message: string) {
    super("continue_unavailable", message, 409);
  }
}

/** Это продолжение уже взято — за звёзды или другой сессией показа. */
export class ContinueTakenError extends DomainError {
  constructor() {
    super("continue_taken", "Это продолжение уже взято", 409);
  }
}

/** Рекламных продолжений на сегодня больше нет (Р4) — остаются звёзды. */
export class AdContinueDailyCapError extends DomainError {
  constructor() {
    super("ad_continue_daily_cap", "Продолжения за рекламу на сегодня закончились", 409);
  }
}
