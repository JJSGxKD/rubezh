import { DomainError } from "../../common/domain-error.js";
import { CHANGE_TTL_HOURS, type ChangeStatus } from "./change-request-types.js";

/**
 * Ошибки заявок на правку (docs/19-content-admin.md §6, tasks/T-0309). Тексты
 * читает человек в панели, поэтому русские и говорят, что делать дальше.
 */

export class ChangeRequestNotFoundError extends DomainError {
  constructor() {
    super("change_request_not_found", "Заявки с таким идентификатором нет", 404);
  }
}

/** Правка не прошла правила цели: в тексте — поле и предел словами. Заявка не заводится. */
export class ChangeRequestValueError extends DomainError {
  constructor(message: string) {
    super("change_request_value_invalid", message, 422);
  }
}

/** Вид заявок сервис пока не умеет: награды придут отдельной задачей. */
export class ChangeRequestUnsupportedKindError extends DomainError {
  constructor() {
    super("change_request_unsupported_kind", "Заявки этого вида пока не принимаются", 422);
  }
}

/** Решает другой участник: свою заявку автор может только отозвать. */
export class ChangeRequestOwnError extends DomainError {
  constructor() {
    super("change_request_own", "Свою заявку решить нельзя: её подтверждает или отклоняет другой участник с таким же правом. Автор может её отозвать", 403);
  }
}

export class ChangeRequestNotAuthorError extends DomainError {
  constructor() {
    super("change_request_not_author", "Отозвать заявку может только её автор", 403);
  }
}

const STATUS_WORDS: Record<ChangeStatus, string> = {
  pending: "ждёт решения",
  approved: "подтверждена",
  rejected: "отклонена или отозвана",
  expired: "истекла",
  superseded: "заменена новой",
};

/** Заявку уже решили, погасили или она истекла: повторное решение ничего не меняет. */
export class ChangeRequestClosedError extends DomainError {
  constructor(status: ChangeStatus) {
    super("change_request_closed", `Заявка уже закрыта: ${STATUS_WORDS[status]}`, 409);
  }
}

export class ChangeRequestExpiredError extends DomainError {
  constructor() {
    super("change_request_expired", `Заявка просрочена: прошло больше ${String(CHANGE_TTL_HOURS)} часов. Подайте новую`, 409);
  }
}

/** Значение изменилось после заявки: она описывала другое «было», и применять её нельзя. */
export class ChangeRequestStaleError extends DomainError {
  constructor() {
    super("change_request_stale", "Значение изменилось после заявки — заявка заменена. Подайте новую с актуальным «было»", 409);
  }
}
