import { DomainError } from "../../common/domain-error.js";

/**
 * Ошибки контента на сервере (docs/19-content-admin.md §3, tasks/T-0303).
 * Тексты читает человек в панели, поэтому русские и называют путь до поля.
 */

/** Путь правки не разобрался или не ведёт к месту в снимке — черновик не меняется. */
export class ContentPathError extends DomainError {
  constructor(message: string) {
    super("content_path_invalid", message, 422);
  }
}

/** Значение не той формы по схеме снимка: в тексте — путь до поля и что не так. */
export class ContentValueError extends DomainError {
  constructor(message: string) {
    super("content_value_invalid", message, 422);
  }
}

/**
 * Схема снимка использует то, чего серверная проверка не знает. Тихо пропустить
 * такое значило бы принять неверное, поэтому — громкая ошибка: это вопрос к
 * разработчику, а не к человеку в панели.
 */
export class ContentSchemaError extends DomainError {
  constructor(keyword: string) {
    super("content_schema_unsupported", `Схема снимка использует «${keyword}» — серверная проверка этого не умеет`, 500);
  }
}

export class ContentVersionNotFoundError extends DomainError {
  constructor(message = "Версии контента с таким номером нет") {
    super("content_version_not_found", message, 404);
  }
}

export class ContentDraftNotFoundError extends DomainError {
  constructor() {
    super("content_draft_not_found", "Черновика с таким идентификатором нет", 404);
  }
}

/** Архивный черновик не правится и не проверяется: его вернуть можно только новым. */
export class ContentDraftArchivedError extends DomainError {
  constructor() {
    super("content_draft_archived", "Черновик в архиве — править и проверять его нельзя", 409);
  }
}

export class ContentDraftLimitError extends DomainError {
  constructor(limit: number) {
    super("content_draft_limit", `Открытых черновиков уже ${String(limit)} — отправьте ненужные в архив`, 409);
  }
}

export class ContentCheckNotFoundError extends DomainError {
  constructor() {
    super("content_check_not_found", "Проверки с таким идентификатором нет", 404);
  }
}

/** В очереди sim-worker уже ждёт предельное число заданий. Текст — тот же, что у воркера. */
export class ContentCheckBusyError extends DomainError {
  constructor() {
    super("content_check_busy", "Проверка уже идёт, дождитесь", 429);
  }
}
