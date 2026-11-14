import type { AccountType, EntryLine } from "@bh/ledger";
import type { LedgerMeta } from "../ledger-view.js";
import type { FactLine, Receipt } from "./period-facts.js";
import type { PeriodSnapshot } from "./period-snapshot.js";
import type { PeriodStatus } from "./period-rules.js";

/** Месяцы учёта (Р222, tasks/T-0468): типы между сервисом и репозиторием — то, что читается из базы и что в неё пишется. */

/** Строка месяца: состояние, кто и когда ставил на сверку и закрывал, число снятий закрытия и снимок. */
export interface PeriodRow {
  period: string;
  status: PeriodStatus;
  reviewAt: Date | null;
  reviewBy: string | null;
  closedAt: Date | null;
  closedBy: string | null;
  reopenedCount: number;
  /** JSON из базы: форму разбирает `parseSnapshot`, репозиторий ей не доверяет */
  snapshot: unknown;
  updatedAt: Date;
}

/** Операция месяца, которая ещё не проведена. */
export interface OpenOperation {
  operationId: string;
  status: "draft" | "pending";
}

/** Рублёвое поступление без чека НПД: проводка и, если она из операции, операция. */
export interface MissingReceipt {
  entryId: string;
  sourceKey: string;
  operationId: string | null;
}

/** Заём, действующий на конец месяца: тело, премия, сколько уже погашено траншами закрытых месяцев и ставка. */
export interface SourceLoan {
  loanId: string;
  lender: string;
  currency: string;
  principalMinor: bigint;
  premiumMinor: bigint;
  /** сумма траншей по снимкам закрытых месяцев, в валюте займа */
  repaidMinor: bigint;
  repaymentBp: number;
  /** когда заём получен: по нему выстраивается очередь погашения */
  takenAt: Date;
}

/** Доля участника на месяц. */
export interface SourceShare {
  accountId: string;
  name: string;
  bp: number;
}

/**
 * Всё, что база знает о месяце для сверки и закрытия. `fingerprint` — отпечаток журнала месяца (число проводок и
 * время последней): закрытие пишет только если отпечаток тот же, что при расчёте.
 */
export interface MonthSource {
  lines: FactLine[];
  /** чеки месяца */
  receipts: Receipt[];
  /** сумма чеков года по этот месяц включительно, в копейках: для лимита НПД */
  yearReceiptsMinor: bigint;
  receiptsMissing: MissingReceipt[];
  openOperations: OpenOperation[];
  unpostedPurchaseIds: string[];
  loans: SourceLoan[];
  shares: SourceShare[];
  fingerprint: string;
}

/** Счёт, который закрытие заводит при первой проводке (`ON CONFLICT DO NOTHING`). */
export interface NewServiceAccount {
  accountId: string;
  type: AccountType;
  currency: string;
  name: string;
}

/** Проводка закрытия: дата — день закрытия, месяц — закрываемый. */
export interface CloseEntry {
  sourceKey: string;
  at: Date;
  period: string;
  memo: string;
  lines: EntryLine[];
  meta: LedgerMeta;
}

/** Что записывается закрытием одной транзакцией: снимок, проводки, счета для них и отпечаток, по которому считали. */
export interface ClosePlan {
  period: string;
  /** номер раза: сколько раз закрытие снимали до этого */
  round: number;
  closedAt: Date;
  closedBy: string;
  fingerprint: string;
  snapshot: PeriodSnapshot;
  accounts: NewServiceAccount[];
  entries: CloseEntry[];
}

export type CloseOutcome = { outcome: "closed" } | { outcome: "not_review"; status: PeriodStatus } | { outcome: "changed" };

export interface ReopenPlan {
  period: string;
  /** номер раза закрытия, которое снимается */
  round: number;
  at: Date;
  by: string;
  reason: string;
}

export type ReopenOutcome = { outcome: "reopened"; reversed: number } | { outcome: "not_closed"; status: PeriodStatus } | { outcome: "changed" };

/** Поставлен на сверку этим вызовом, уже был на сверке или закрыт. */
export type ReviewOutcome = "started" | "already" | "closed";

export const PERIODS_REPOSITORY = Symbol("PERIODS_REPOSITORY");

export interface PeriodsRepository {
  row(period: string): Promise<PeriodRow | null>;
  rows(): Promise<PeriodRow[]>;
  /** месяц самой ранней проводки журнала; `null` — журнал пуст */
  firstEntryPeriod(): Promise<string | null>;
  loadMonth(period: string): Promise<MonthSource>;
  /** `open → review` условным обновлением: из двух одновременных вызовов запись одна */
  startReview(period: string, by: string, at: Date): Promise<ReviewOutcome>;
  commitClose(plan: ClosePlan): Promise<CloseOutcome>;
  commitReopen(plan: ReopenPlan): Promise<ReopenOutcome>;
}
