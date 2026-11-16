import { formatMinor } from "@bh/ledger";
import { currencySpec } from "../ledger-currencies.js";
import type { PeriodSnapshot } from "../periods/period-snapshot.js";
import { reportOf, type ReportView } from "../periods/period-view.js";
import { DAY_MS, currentConfirmation, payGate, type PayGate } from "./payout-rules.js";
import type { PayoutRecord, StoredConfirmation } from "./payout-types.js";

/**
 * Подтверждение отчёта и выплаты в ответах панели (docs/37-accounting.md §13, Р222, tasks/T-0469): суммы — десятичными
 * строками (`bigint` в JSON не ходит), рубли и доллары по правилам своей валюты. Чистые функции: снимок месяца,
 * подтверждения и выплаты приходят аргументами.
 */

const RUB = currencySpec("RUB");
const USD = currencySpec("USD");

export interface ConfirmationView {
  status: "confirmed" | "disputed";
  comment: string | null;
  decidedAt: string;
}

/** Можно ли платить и почему нет: для таблицы выплат владельца. */
export type GateView = { state: "free" } | { state: "wait"; reason: string; until: string } | { state: "override"; reason: string };

export interface ParticipantStatus {
  accountId: string;
  name: string;
  owedRub: string;
  paidRub: string;
  remainingRub: string;
  confirmation: ConfirmationView | null;
  gate: GateView;
  /** остаток есть и ждать нечего: платить можно (с причиной или без — `needsReason`) */
  canPay: boolean;
  /** молчит дольше срока или оспорил: нужна причина владельца */
  needsReason: boolean;
  /** почему нельзя или нужна причина; `null` — подтверждено */
  reason: string | null;
}

export interface PayoutRowView {
  operationId: string;
  payee: string;
  currency: string;
  amount: string;
  overrideReason: string | null;
  at: string;
}

export interface PayoutStatusView {
  period: string;
  closedAt: string;
  confirmDays: number;
  /** до какого момента участник может молчать: после — выплата с причиной владельца */
  confirmDeadlineAt: string;
  participants: ParticipantStatus[];
  tax: { owedRub: string; paidRub: string; remainingRub: string } | null;
  loans: { loanId: string; lender: string; currency: string; owed: string; paid: string; remaining: string }[];
  /** доля владельца в отчёте, доллары; `null` — делить было нечего */
  owner: { shareUsd: string } | null;
  payouts: PayoutRowView[];
}

/** Отчёт участника: водопад месяца из снимка и его строка — долг, выплачено, остаток и решение. */
export interface MyReportView {
  period: string;
  closedAt: string;
  deadlineAt: string;
  report: ReportView;
  mine: {
    accountId: string;
    name: string;
    owedRub: string;
    paidRub: string;
    remainingRub: string;
    confirmation: ConfirmationView | null;
    /** выплат ещё не было: решение можно поменять */
    canChange: boolean;
  };
}

const rub = (minor: bigint): string => formatMinor(minor, RUB);
const nonNegative = (value: bigint): bigint => (value > 0n ? value : 0n);

export function confirmationView(confirmation: StoredConfirmation | null, closedAt: Date): ConfirmationView | null {
  const current = currentConfirmation(confirmation, closedAt);
  return current === null ? null : { status: current.status, comment: current.comment, decidedAt: current.decidedAt.toISOString() };
}

function gateView(gate: PayGate): GateView {
  return gate.state === "wait" ? { state: "wait", reason: gate.reason, until: gate.until.toISOString() } : gate;
}

/** Сколько выплачено получателю за месяц (в валюте его обязательства). */
export function paidTo(records: readonly PayoutRecord[], payee: string): bigint {
  return records.filter((record) => record.payee === payee).reduce((sum, record) => sum + record.minor, 0n);
}

export function deadlineOf(closedAt: Date, confirmDays: number): Date {
  return new Date(closedAt.getTime() + confirmDays * DAY_MS);
}

export function myReportOf(args: { snapshot: PeriodSnapshot; closedAt: Date; accountId: string; name: string; records: readonly PayoutRecord[]; confirmation: StoredConfirmation | null; confirmDays: number }): MyReportView {
  const owed = BigInt(args.snapshot.rub.payouts.find((payout) => payout.accountId === args.accountId)?.rubMinor ?? "0");
  const paid = paidTo(args.records, `stakeholder:${args.accountId}`);
  return {
    period: args.snapshot.period,
    closedAt: args.closedAt.toISOString(),
    deadlineAt: deadlineOf(args.closedAt, args.confirmDays).toISOString(),
    report: reportOf(args.snapshot),
    mine: { accountId: args.accountId, name: args.name, owedRub: rub(owed), paidRub: rub(paid), remainingRub: rub(nonNegative(owed - paid)), confirmation: confirmationView(args.confirmation, args.closedAt), canChange: paid === 0n },
  };
}

export function statusOf(args: {
  snapshot: PeriodSnapshot;
  closedAt: Date;
  now: Date;
  confirmDays: number;
  records: readonly PayoutRecord[];
  confirmations: readonly StoredConfirmation[];
  names: ReadonlyMap<string, string>;
}): PayoutStatusView {
  const { snapshot, closedAt, records } = args;
  const decisions = new Map(args.confirmations.map((confirmation) => [confirmation.accountId, confirmation]));

  const participants = snapshot.rub.payouts
    .filter((payout) => BigInt(payout.rubMinor) > 0n)
    .map((payout): ParticipantStatus => {
      const owed = BigInt(payout.rubMinor);
      const paid = paidTo(records, `stakeholder:${payout.accountId}`);
      const remaining = nonNegative(owed - paid);
      const confirmation = currentConfirmation(decisions.get(payout.accountId) ?? null, closedAt);
      const gate = payGate("stakeholder", { closedAt, confirmation, now: args.now, confirmDays: args.confirmDays });
      return {
        accountId: payout.accountId,
        name: snapshot.accounts[payout.accountId] ?? args.names.get(payout.accountId) ?? payout.accountId,
        owedRub: rub(owed),
        paidRub: rub(paid),
        remainingRub: rub(remaining),
        confirmation: confirmationView(confirmation, closedAt),
        gate: gateView(gate),
        canPay: remaining > 0n && gate.state !== "wait",
        needsReason: gate.state === "override",
        reason: gate.state === "free" ? null : gate.reason,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "ru") || a.accountId.localeCompare(b.accountId));

  const taxOwed = BigInt(snapshot.rub.taxMinor);
  const taxPaid = paidTo(records, "tax");
  const loans = snapshot.loans
    .filter((loan) => BigInt(loan.trancheMinor) > 0n)
    .map((loan) => {
      const spec = currencySpec(loan.currency);
      const owed = BigInt(loan.trancheMinor);
      const paid = paidTo(records, `loan:${loan.loanId}`);
      return { loanId: loan.loanId, lender: loan.lender, currency: loan.currency, owed: formatMinor(owed, spec), paid: formatMinor(paid, spec), remaining: formatMinor(nonNegative(owed - paid), spec) };
    });
  const ownerShare = BigInt(snapshot.rub.ownerUsdCents);

  return {
    period: snapshot.period,
    closedAt: closedAt.toISOString(),
    confirmDays: args.confirmDays,
    confirmDeadlineAt: deadlineOf(closedAt, args.confirmDays).toISOString(),
    participants,
    tax: taxOwed > 0n ? { owedRub: rub(taxOwed), paidRub: rub(taxPaid), remainingRub: rub(nonNegative(taxOwed - taxPaid)) } : null,
    loans,
    owner: ownerShare > 0n ? { shareUsd: formatMinor(ownerShare, USD) } : null,
    payouts: records.map((record) => ({ operationId: record.operationId, payee: record.payee, currency: record.currency, amount: formatMinor(record.minor, currencySpec(record.currency)), overrideReason: record.overrideReason, at: record.at.toISOString() })),
  };
}
