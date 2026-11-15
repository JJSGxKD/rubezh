import { DomainError } from "../../common/domain-error.js";

/** В каталоге обликов нет такого id. */
export class AppearanceNotFoundError extends DomainError {
  constructor() {
    super("appearance_not_found", "Такого облика нет", 404);
  }
}

/** Облик есть, но игрок им не владеет: выбрать можно только полученный. */
export class AppearanceLockedError extends DomainError {
  constructor() {
    super("appearance_locked", "Этот облик у тебя ещё не получен — выбрать можно только полученный", 409);
  }
}
