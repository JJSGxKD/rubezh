import { DomainError } from "../../common/domain-error.js";

/** Бот площадки не подключён или не настроен — ссылку с кодом выдать нечем. */
export class LinkUnavailableError extends DomainError {
  constructor() {
    super("link_unavailable", "Бот площадки сейчас недоступен — попробуй позже", 503);
  }
}
