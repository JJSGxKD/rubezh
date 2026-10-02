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

/** Такого ключа нет в каталоге настроек — поменять из панели можно только то, что знает код. */
export class SettingNotFoundError extends DomainError {
  constructor() {
    super("setting_not_found", "Настройки с таким ключом нет", 404);
  }
}

/** Такого ключа нет в каталоге ключей интеграций — задать из панели можно только то, что знает код. */
export class SecretNotFoundError extends DomainError {
  constructor() {
    super("secret_not_found", "Ключа интеграции с таким именем нет", 404);
  }
}

/** Проверять нечего: ключ не задан ни в панели, ни в окружении. */
export class SecretMissingError extends DomainError {
  constructor() {
    super("secret_missing", "Ключ не задан — проверять нечего", 409);
  }
}

/** Сервис не даёт способа проверить ключ — проверка покажет себя только в работе. */
export class SecretUncheckableError extends DomainError {
  constructor() {
    super("secret_uncheckable", "Этот сервис не даёт проверить ключ заранее", 409);
  }
}
