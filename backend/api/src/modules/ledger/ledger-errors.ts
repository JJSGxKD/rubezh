import { DomainError } from "../../common/domain-error.js";

/** Журнал учёта (Р219, tasks/T-0457): отказы, которые видит тот, кто пишет проводку или смотрит журнал. */

/** Проводку нельзя записать: текст — первая найденная проблема, по-русски. */
export class LedgerEntryInvalidError extends DomainError {
  constructor(reason: string) {
    super("ledger_entry_invalid", reason, 400);
  }
}

/** Ключ источника уже занят проводкой с другими строками: тихая перезапись скрыла бы ошибку источника. */
export class LedgerSourceConflictError extends DomainError {
  constructor(sourceKey: string) {
    super("ledger_source_conflict", `Ключ источника «${sourceKey}» уже занят проводкой с другими строками`, 409);
  }
}

/** У проводки не больше одного сторно: исправление не повторяется под другим ключом. */
export class LedgerAlreadyReversedError extends DomainError {
  constructor(sourceKey: string) {
    super("ledger_already_reversed", `Проводка «${sourceKey}» уже сторнирована`, 409);
  }
}

export class LedgerEntryNotFoundError extends DomainError {
  constructor(sourceKey: string) {
    super("ledger_entry_not_found", `Проводки «${sourceKey}» в журнале нет`, 404);
  }
}

export class LedgerCursorInvalidError extends DomainError {
  constructor() {
    super("ledger_cursor_invalid", "Страница журнала не распознана: начните просмотр заново", 400);
  }
}
