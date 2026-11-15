import type { AccountType } from "@bh/ledger";

/** Журнал учёта в ответах панели (Р219, tasks/T-0457): суммы — строками, `bigint` в JSON не ходит. */

/** Примечание проводки для разбора: id покупки, способ оплаты. Только плоский JSON — в журнале это поле `meta`. */
export type LedgerMeta = Readonly<Record<string, string | number | boolean | null>>;

/** Остаток счёта по нормальной стороне: у актива и расхода — сумма строк, у остальных — с обратным знаком. */
export interface AccountBalanceView {
  accountId: string;
  name: string;
  type: AccountType;
  currency: string;
  /** десятичная строка по знакам валюты счёта: «50», «0.00», «9007199.254740993» */
  balance: string;
}

/** Строка проводки: дебет — плюс, кредит — минус. */
export interface JournalLineView {
  accountId: string;
  accountName: string;
  currency: string;
  amount: string;
}

export interface JournalEntryView {
  entryId: string;
  sourceKey: string;
  /** ISO-время события */
  at: string;
  /** «ГГГГ-ММ» по UTC */
  period: string;
  memo: string;
  /** ключ источника исходной проводки, если эта — сторно */
  reversalOf: string | null;
  /** аккаунт записавшего; `null` — сервер */
  createdBy: string | null;
  meta: LedgerMeta | null;
  lines: JournalLineView[];
}

/** Фильтры журнала: счёт, валюта, период по месяцам («ГГГГ-ММ», границы включаются), ключ источника по префиксу. */
export interface JournalFilterInput {
  accountId?: string | undefined;
  currency?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  sourcePrefix?: string | undefined;
}

export interface JournalPage {
  entries: JournalEntryView[];
  /** курсор следующей страницы; `null` — это последняя */
  next: string | null;
}
