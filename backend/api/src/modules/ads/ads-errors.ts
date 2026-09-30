import { DomainError } from "../../common/domain-error.js";

/**
 * Сессии показа нет, она чужая, истекла или этот шаг для неё уже невозможен:
 * досмотр после отказа, досмотр там, где успех — клик. Клиент отчёт не
 * повторяет — шаг воронки просто не записался.
 */
export class AdSessionClosedError extends DomainError {
  constructor() {
    super("ad_session_closed", "Показ рекламы уже завершён", 409);
  }
}

/** Условие успеха не выполнено или окно забора прошло — награды за этот показ нет. */
export class AdNotCompletedError extends DomainError {
  constructor() {
    super("ad_not_completed", "Реклама не досмотрена — награды нет", 409);
  }
}

/** Награда в этом месте уже была недавно — следующая после паузы. */
export class AdCooldownError extends DomainError {
  constructor(readonly retryAt: Date) {
    super("ad_cooldown", "Награда за рекламу здесь уже была — загляните позже", 409);
  }
}
