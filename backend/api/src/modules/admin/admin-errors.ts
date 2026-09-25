import { DomainError } from "../../common/domain-error.js";

/** Игрока с таким идентификатором нет — 404, а не пустая карточка. */
export class AccountNotFoundError extends DomainError {
  constructor() {
    super("account_not_found", "Аккаунт не найден", 404);
  }
}

export class ReportNotFoundError extends DomainError {
  constructor() {
    super("report_not_found", "Отчёт не найден", 404);
  }
}

/** Изменяющий запрос без заголовка панели — подделка запроса или чужой клиент. */
export class CsrfRejectedError extends DomainError {
  constructor() {
    super("csrf_rejected", "Запрос не из панели", 403);
  }
}

/** Сессия панели есть, а прав на панель у аккаунта уже нет: роль отозвали или аккаунт заблокировали. */
export class PanelAccessError extends DomainError {
  constructor(message: string) {
    super("panel_forbidden", message, 403);
  }
}
