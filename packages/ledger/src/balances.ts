import { normalSign, type LedgerAccount } from "./accounts.js";
import type { EntryLine } from "./entries.js";

function accountOf(accounts: ReadonlyMap<string, LedgerAccount>, accountId: string): LedgerAccount {
  const account = accounts.get(accountId);
  if (account === undefined) {
    // Строка журнала без счёта — повреждённые данные; молча пропустить её
    // значило бы показать остатки, которые не сходятся с журналом.
    throw new Error(`В журнале строка по неизвестному счёту «${accountId}»`);
  }
  return account;
}

/**
 * Остатки счетов: сумма строк со знаком нормальной стороны. Для актива и
 * расхода — сумма строк, для выручки, обязательства и капитала — с обратным
 * знаком. У каждого счёта справочника есть запись, без строк — `0n`.
 */
export function balances(lines: Iterable<EntryLine>, accounts: ReadonlyMap<string, LedgerAccount>): Map<string, bigint> {
  const raw = new Map<string, bigint>();
  for (const account of accounts.values()) {
    raw.set(account.id, 0n);
  }
  for (const line of lines) {
    accountOf(accounts, line.accountId);
    raw.set(line.accountId, (raw.get(line.accountId) ?? 0n) + line.amount);
  }
  const result = new Map<string, bigint>();
  for (const [accountId, sum] of raw) {
    result.set(accountId, sum * normalSign(accountOf(accounts, accountId).type));
  }
  return result;
}

/**
 * Суммы строк по валютам, без знака нормальной стороны. В целом журнале в
 * каждой валюте должен быть ноль: это проверка целостности, а не отчёт —
 * ненулевая валюта значит, что в журнал попала несбалансированная проводка.
 */
export function trialBalance(lines: Iterable<EntryLine>, accounts: ReadonlyMap<string, LedgerAccount>): Map<string, bigint> {
  const result = new Map<string, bigint>();
  for (const account of accounts.values()) {
    result.set(account.currency, 0n);
  }
  for (const line of lines) {
    const { currency } = accountOf(accounts, line.accountId);
    result.set(currency, (result.get(currency) ?? 0n) + line.amount);
  }
  return result;
}
