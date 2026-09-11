/**
 * Доменная ошибка: сервис не знает об HTTP и бросает её, а фильтр переводит
 * в код ответа (docs/15-engineering-standards.md §2.3).
 *
 * `code` — стабильный машиночитаемый идентификатор на английском, клиент
 * ветвится по нему. `message` — русский текст для человека.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super("validation_failed", message, 400);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message: string) {
    super("unauthorized", message, 401);
  }
}

export class RateLimitedError extends DomainError {
  constructor(message: string) {
    super("rate_limited", message, 429);
  }
}

export class DisabledError extends DomainError {
  constructor(message: string) {
    super("endpoint_disabled", message, 404);
  }
}
