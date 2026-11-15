import { DomainError } from "../../../common/domain-error.js";
import type { OperationStatus } from "./operation-input.js";

/** Ручные операции учёта (Р220, tasks/T-0461): отказы, которые видит тот, кто вносит и проводит операцию. */

/** Операцию нельзя собрать в проводку или принять: текст — что исправить, по-русски, как его видит человек. */
export class LedgerOperationInvalidError extends DomainError {
  constructor(reason: string) {
    super("ledger_operation_invalid", reason, 400);
  }
}

export class LedgerOperationNotFoundError extends DomainError {
  constructor(operationId: string) {
    super("ledger_operation_not_found", `Операции «${operationId}» нет`, 404);
  }
}

const STATUS_NAME: Readonly<Record<OperationStatus, string>> = {
  draft: "черновик",
  pending: "ждёт подтверждения",
  posted: "проведена",
  rejected: "отклонена",
};

/** Править и удалять можно только черновик: проведённое исправляется сторно, а не правкой. */
export class LedgerOperationNotDraftError extends DomainError {
  constructor(operationId: string, status: OperationStatus) {
    super("ledger_operation_not_draft", `Операция «${operationId}»: ${STATUS_NAME[status]} — править и удалять можно только черновик; проведённое исправляется сторно`, 409);
  }
}

/** Подтвердить и отклонить можно только операцию, которая ждёт подтверждения: решение по ней одно и окончательное (Р220, T-0462). */
export class LedgerOperationNotPendingError extends DomainError {
  constructor(operationId: string, status: OperationStatus) {
    super("ledger_operation_not_pending", `Операция «${operationId}»: ${STATUS_NAME[status]} — решение принимается только по операции, которая ждёт подтверждения`, 409);
  }
}

/** На период шаблона уже есть черновик: повторное действие не плодит дублей (T-0463). */
export class LedgerOperationTemplateTakenError extends DomainError {
  constructor(templateId: string, period: string) {
    super("ledger_operation_template_taken", `Черновик по шаблону «${templateId}» за ${period} уже создан`, 409);
  }
}

/** Проводка записана, а черновика уже нет: его удалили в тот же миг. Проводка остаётся в журнале — смотреть по ключу. */
export class LedgerOperationVanishedError extends DomainError {
  constructor(sourceKey: string) {
    super("ledger_operation_vanished", `Черновик удалили в тот же миг, когда его проводили: проводка записана в журнал под ключом «${sourceKey}», её нужно проверить там`, 409);
  }
}
