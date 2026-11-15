import { DomainError } from "../../common/domain-error.js";

/** В каталоге знаков нет такого id: его не было или знак выключен в панели. */
export class EmblemNotFoundError extends DomainError {
  constructor() {
    super("emblem_not_found", "Такого знака нет", 404);
  }
}

/** Знак есть, но игрок его не держит: выбрать можно только то, что получено. */
export class EmblemNotHeldError extends DomainError {
  constructor() {
    super("emblem_not_held", "Этот знак у тебя ещё не получен — выбрать можно только полученный", 409);
  }
}
