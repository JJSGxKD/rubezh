import { DomainError } from "../../common/domain-error.js";

/**
 * Ошибки публикации контента (docs/19-content-admin.md §4.3–§4.5, tasks/T-0306).
 * Тексты читает человек в панели: они русские и называют, что делать дальше.
 */

/** Проверка не годится для публикации: в тексте — причина («запустите проверку», «метрика вне коридора»). */
export class ContentCheckRequiredError extends DomainError {
  constructor(reason: string) {
    super("content_check_required", reason, 409);
  }
}

/** Публикация или откат уже идут: замок держит другой запрос или другая реплика. */
export class ContentPublishBusyError extends DomainError {
  constructor() {
    super("content_publish_busy", "Публикация или откат уже идут — повторите через несколько секунд", 409);
  }
}

/** Версия не годится целью отката: её не было в игре, а у «Всем» — нечего откатывать. */
export class ContentRollbackInvalidError extends DomainError {
  constructor(message: string) {
    super("content_rollback_invalid", message, 409);
  }
}

/** Форму снимка (`schemaVersion`) меняет код, а не панель: иначе старые клиенты потеряли бы версию. */
export class ContentSchemaChangedError extends DomainError {
  constructor() {
    super("content_schema_changed", "Версия формы снимка отличается от версии-основы — её меняет только код, публиковать такой черновик нельзя", 409);
  }
}

/** «Взять из кода» просит версию, которая не из кода: её поля уже принадлежат панели. */
export class ContentMergeSourceError extends DomainError {
  constructor(message: string) {
    super("content_merge_invalid", message, 409);
  }
}
