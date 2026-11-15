import type { LedgerAccount } from "./accounts.js";

/** Строка проводки: дебет — плюс, кредит — минус, в минимальных единицах валюты счёта. */
export interface EntryLine {
  accountId: string;
  amount: bigint;
}

export interface EntryDraft {
  /** ключ идемпотентности: «purchase:<id>:paid» — повторная запись той же проводки не создаёт вторую */
  sourceKey: string;
  /** когда случилось: по этому моменту определяется период */
  at: Date;
  memo: string;
  lines: EntryLine[];
  /**
   * Месяц, за который проводка («YYYY-MM»), если он отличается от месяца `at`:
   * расход за ноябрь, оплаченный 2 декабря. Раньше месяца `at` — можно, позже — нет.
   */
  period?: string;
  /** sourceKey исходной проводки, если эта — сторно */
  reversalOf?: string;
}

export type EntryProblem =
  | { kind: "empty_source_key" }
  | { kind: "source_key_too_long" }
  | { kind: "too_few_lines" }
  | { kind: "zero_line"; accountId: string }
  | { kind: "unknown_account"; accountId: string }
  | { kind: "duplicate_account"; accountId: string }
  | { kind: "unbalanced"; currency: string; sum: bigint }
  | { kind: "bad_period"; period: string };

export const MAX_SOURCE_KEY_LENGTH = 128;

const PERIOD_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

/**
 * Всё, что мешает записать проводку. Пустой список — проводку можно писать.
 * Баланс считается в каждой валюте отдельно: обмен затрагивает две валюты, и
 * каждая обязана сойтись сама, иначе «курс» спрятал бы ошибку.
 */
export function findEntryProblems(draft: EntryDraft, accounts: ReadonlyMap<string, LedgerAccount>): EntryProblem[] {
  const problems: EntryProblem[] = [];
  if (draft.sourceKey.trim() === "") {
    problems.push({ kind: "empty_source_key" });
  } else if (draft.sourceKey.length > MAX_SOURCE_KEY_LENGTH) {
    problems.push({ kind: "source_key_too_long" });
  }
  if (draft.lines.length < 2) {
    problems.push({ kind: "too_few_lines" });
  }
  if (draft.period !== undefined && !isValidPeriodFor(draft.period, draft.at)) {
    problems.push({ kind: "bad_period", period: draft.period });
  }

  const seen = new Set<string>();
  const reportedDuplicates = new Set<string>();
  const sums = new Map<string, bigint>();
  let hasUnknown = false;
  for (const line of draft.lines) {
    if (line.amount === 0n) {
      problems.push({ kind: "zero_line", accountId: line.accountId });
    }
    const account = accounts.get(line.accountId);
    if (account === undefined) {
      hasUnknown = true;
      problems.push({ kind: "unknown_account", accountId: line.accountId });
    } else {
      sums.set(account.currency, (sums.get(account.currency) ?? 0n) + line.amount);
    }
    if (seen.has(line.accountId) && !reportedDuplicates.has(line.accountId)) {
      reportedDuplicates.add(line.accountId);
      problems.push({ kind: "duplicate_account", accountId: line.accountId });
    }
    seen.add(line.accountId);
  }

  // С неизвестным счётом валюта строки неизвестна, и баланс по ней был бы
  // выдумкой: сначала чинится счёт, потом считается сумма.
  if (!hasUnknown) {
    for (const [currency, sum] of sums) {
      if (sum !== 0n) {
        problems.push({ kind: "unbalanced", currency, sum });
      }
    }
  }
  return problems;
}

/**
 * «YYYY-MM» и не позже месяца даты проводки. Строки «YYYY-MM» сравниваются
 * как строки: при четырёх цифрах года и двух цифрах месяца порядок тот же, что
 * у времени. Дата, которую не разобрать, сравнение пропускает: её ошибка — не
 * ошибка месяца, а `periodOf` на ней бросит исключение, как и раньше.
 */
function isValidPeriodFor(period: string, at: Date): boolean {
  if (!PERIOD_RE.test(period)) {
    return false;
  }
  if (Number.isNaN(at.getTime())) {
    return true;
  }
  return period <= periodOf(at);
}

/** Месяц проводки в отчёте: «за какой месяц», а если не указан — месяц даты. */
export function periodOfEntry(draft: Pick<EntryDraft, "at" | "period">): string {
  return draft.period ?? periodOf(draft.at);
}

/**
 * Обратная проводка: знаки всех строк меняются, `reversalOf` ведёт к исходной.
 * Проводки не правятся и не удаляются (docs/37-accounting.md, §2). Сторно сторно —
 * обычная проводка, отдельного запрета нет: бывает, что возврат отменяют.
 */
export function reverse(original: EntryDraft, sourceKey: string, at: Date, memo: string): EntryDraft {
  return {
    sourceKey,
    at,
    memo,
    lines: original.lines.map((line) => ({ accountId: line.accountId, amount: -line.amount })),
    reversalOf: original.sourceKey,
  };
}

/** Период проводки — календарный месяц по UTC, «YYYY-MM»: по часовому поясу сервера сутки в отчёте поехали бы. */
export function periodOf(at: Date): string {
  if (Number.isNaN(at.getTime())) {
    throw new RangeError("Дата проводки не определена");
  }
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${String(at.getUTCFullYear()).padStart(4, "0")}-${month}`;
}
