import { DomainError } from "../../common/domain-error.js";

/** Строки журнала нет — удалили в соседней вкладке или id не тот. */
export class ChangelogEntryNotFoundError extends DomainError {
  constructor() {
    super("changelog_entry_not_found", "Записи журнала нет", 404);
  }
}
