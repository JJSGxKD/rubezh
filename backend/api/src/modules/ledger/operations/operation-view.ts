import { formatMinor } from "@bh/ledger";
import { z } from "zod";
import { currencySpec } from "../ledger-currencies.js";
import type { JournalEntryView } from "../ledger-view.js";
import { receiptMissingOf, type OperationsChart } from "./builders.js";
import { operationInputSchema, type OperationInput, type OperationKind, type OperationStatus } from "./operation-input.js";
import type { StoredLoan, StoredOperation, StoredOperationEntry } from "./operations.repository.js";

/** Ручные операции в ответах панели (Р220, tasks/T-0461): суммы — строками, `bigint` в JSON не ходит. */

export interface OperationLoanView {
  loanId: string;
  lender: string;
  accountId: string;
  currency: string;
  /** тело займа, десятичной строкой в единицах валюты */
  principal: string;
  premium: string;
  repaymentBp: number;
}

export interface OperationView {
  operationId: string;
  kind: OperationKind;
  status: OperationStatus;
  /** то, что ввёл человек, целиком: форма правки заполняется из него */
  input: OperationInput;
  /** оценка размера в долларах на момент ввода; `null` — курса не было */
  amountUsd: string | null;
  createdBy: string;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  templateId: string | null;
  templatePeriod: string | null;
  /** зачисление в рубли без чека НПД (Р221): операция проведена и без него, но налог по ней не посчитать */
  receiptMissing: boolean;
  /** проводка, собранная из операции; у черновика её нет */
  entry: JournalEntryView | null;
  loan: OperationLoanView | null;
}

export interface OperationPage {
  operations: OperationView[];
  /** курсор следующей страницы; `null` — это последняя */
  next: string | null;
}

/** `meta` приходит из базы как JSON: плоская запись или ничего. Неразборчивое показывать нельзя — `null`. */
const metaSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

/**
 * Ввод человека из строки базы: поля вида лежат в `input`, причина и ссылка — в своих колонках. Читается той же
 * схемой, что и тело запроса: строка, которая не сходится, — повреждённые данные, и показывать их нельзя.
 */
export function inputOf(row: StoredOperation): OperationInput {
  const fields = typeof row.input === "object" && row.input !== null && !Array.isArray(row.input) ? row.input : null;
  const parsed = operationInputSchema.safeParse({ ...fields, note: row.note, ...(row.link === null ? {} : { link: row.link }) });
  if (!parsed.success) throw new Error(`Операция «${row.operationId}»: сохранённый ввод не разбирается`);
  return parsed.data;
}

function entryView(entry: StoredOperationEntry): JournalEntryView {
  const meta = entry.meta === null || entry.meta === undefined ? null : metaSchema.safeParse(entry.meta);
  return {
    entryId: entry.entryId,
    sourceKey: entry.sourceKey,
    at: entry.at.toISOString(),
    period: entry.period,
    memo: entry.memo,
    reversalOf: entry.reversalOf,
    createdBy: entry.createdBy,
    meta: meta !== null && meta.success ? meta.data : null,
    lines: entry.lines.map((line) => ({ accountId: line.accountId, accountName: line.accountName, currency: line.currency, amount: formatMinor(line.amount, currencySpec(line.currency)) })),
  };
}

function loanView(loan: StoredLoan): OperationLoanView {
  const spec = currencySpec(loan.currency);
  return {
    loanId: loan.loanId,
    lender: loan.lender,
    accountId: loan.accountId,
    currency: loan.currency,
    principal: formatMinor(loan.principal, spec),
    premium: formatMinor(loan.premium, spec),
    repaymentBp: loan.repaymentBp,
  };
}

export function operationView(
  row: StoredOperation,
  chart: OperationsChart,
  entries: ReadonlyMap<string, StoredOperationEntry>,
  loans: ReadonlyMap<string, StoredLoan>,
): OperationView {
  const input = inputOf(row);
  const entry = row.sourceKey === null ? undefined : entries.get(row.sourceKey);
  const loan = loans.get(row.operationId);
  return {
    operationId: row.operationId,
    kind: row.kind,
    status: row.status,
    input,
    amountUsd: row.amountUsd,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    templateId: row.templateId,
    templatePeriod: row.templatePeriod,
    receiptMissing: receiptMissingOf(input, chart),
    entry: entry === undefined ? null : entryView(entry),
    loan: loan === undefined ? null : loanView(loan),
  };
}
