import { DomainError } from "../../common/domain-error.js";

/** Правило не по правилам: категория, вид, длина или опасная регулярка — текст называет причину. */
export class NameRuleInvalidError extends DomainError {
  constructor(message: string) {
    super("name_rule_invalid", message, 400);
  }
}

/** Правила с таким идентификатором нет — панель перечитывает список. */
export class NameRuleNotFoundError extends DomainError {
  constructor() {
    super("name_rule_not_found", "Правило не найдено", 404);
  }
}

/** Такое правило уже есть или правил слишком много. */
export class NameRuleConflictError extends DomainError {
  constructor(message: string) {
    super("name_rule_conflict", message, 409);
  }
}
