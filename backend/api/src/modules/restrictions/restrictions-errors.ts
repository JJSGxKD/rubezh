import { DomainError } from "../../common/domain-error.js";

/**
 * Действие закрыто ограничением, и игрок о нём знает. Что именно, до какого
 * числа и почему — клиент берёт из `GET /api/v1/me/restrictions`: код один на
 * все виды, а вид понятен из того, куда игрок упёрся.
 */
export class AccountRestrictedError extends DomainError {
  constructor(message: string) {
    super("account_restricted", message, 403);
  }
}

/**
 * Молчаливое ограничение (О40): игрок видит нейтральный отказ, как от
 * временного сбоя, — без плашки и без причины.
 */
export class RestrictionSilentError extends DomainError {
  constructor() {
    super("temporarily_unavailable", "Сейчас недоступно — попробуйте позже", 503);
  }
}

export class RestrictionNotFoundError extends DomainError {
  constructor() {
    super("restriction_not_found", "Такого действующего ограничения нет — его уже сняли или срок вышел", 404);
  }
}

export class RestrictionAccountNotFoundError extends DomainError {
  constructor() {
    super("account_not_found", "Аккаунт не найден", 404);
  }
}
