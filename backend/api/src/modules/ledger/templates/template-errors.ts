import { DomainError } from "../../../common/domain-error.js";

/** Шаблоны повторяющихся расходов (Р220, tasks/T-0463): отказы, которые видит тот, кто их заводит и запускает. */

/** Шаблон или период нельзя принять: текст — что исправить, по-русски, как его видит человек. */
export class LedgerTemplateInvalidError extends DomainError {
  constructor(reason: string) {
    super("ledger_template_invalid", reason, 400);
  }
}

export class LedgerTemplateNotFoundError extends DomainError {
  constructor(templateId: string) {
    super("ledger_template_not_found", `Шаблона «${templateId}» нет`, 404);
  }
}

/** Архивный шаблон не правится: нужен новый — архив нужен, чтобы шаблон перестал создавать черновики. */
export class LedgerTemplateArchivedError extends DomainError {
  constructor(templateId: string) {
    super("ledger_template_archived", `Шаблон «${templateId}» в архиве — править нельзя, нужен новый шаблон`, 409);
  }
}
