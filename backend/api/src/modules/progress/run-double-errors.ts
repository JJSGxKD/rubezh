import { DomainError } from "../../common/domain-error.js";

/**
 * Удваивать нечего или уже поздно: награда ещё считается, забег без
 * награды, монеты не легли (суточный потолок) или окно после забега прошло.
 * Клиент прячет кнопку; досмотренная сессия при этом не тратится —
 * проверка идёт до её забора.
 */
export class RunDoubleUnavailableError extends DomainError {
  constructor(readonly reason: "pending" | "no_reward" | "nothing" | "expired") {
    super("run_double_unavailable", "Эту награду уже не удвоить", 409);
  }
}

/** Забег уже удвоен другой сессией показа — второй раз за один забег не удваивают. */
export class RunAlreadyDoubledError extends DomainError {
  constructor() {
    super("run_already_doubled", "Награда за этот забег уже удвоена", 409);
  }
}
