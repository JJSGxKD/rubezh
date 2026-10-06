import { DomainError } from "../../common/domain-error.js";
import type { WalletResource } from "./wallet-types.js";

/** Не хватило на трату. Клиент ветвится по коду: показывает, чего и сколько не хватает. */
export class InsufficientFundsError extends DomainError {
  constructor(
    readonly resource: WalletResource,
    readonly needed: number,
    readonly balance: number,
  ) {
    super("insufficient_funds", "Недостаточно средств", 409);
  }
}

/**
 * Ключ идемпотентности уже занят другой операцией — другим игроком, ресурсом
 * или причиной. Это ошибка того, кто собирает ключ, и молча считать её
 * повтором нельзя: иначе начисление одному игроку «уже было» у другого.
 */
export class IdempotencyConflictError extends DomainError {
  constructor() {
    super("idempotency_conflict", "Ключ операции уже использован другой операцией", 409);
  }
}
