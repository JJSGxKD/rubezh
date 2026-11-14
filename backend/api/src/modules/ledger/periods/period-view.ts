import { formatMinor } from "@bh/ledger";
import { currencySpec } from "../ledger-currencies.js";
import type { ChecklistItem } from "./checklist.js";
import type { PeriodStatus } from "./period-rules.js";
import type { PeriodSnapshot } from "./period-snapshot.js";
import type { PeriodRow } from "./period-types.js";

/**
 * Месяцы учёта в ответах панели (Р222, tasks/T-0468): суммы — десятичными строками (`bigint` в JSON не ходит),
 * отчёт строится из снимка — и у закрытого месяца, и у черновика, поэтому цифры в них читаются одинаково.
 */

const USD = { code: "USD", decimals: 2 } as const;
const RUB = { code: "RUB", decimals: 2 } as const;

export interface PeriodListItem {
  period: string;
  status: PeriodStatus;
  reopenedCount: number;
  reviewAt: string | null;
  closedAt: string | null;
}

export interface ReportLine {
  key: string;
  name: string;
  /** доллары, «246.54» */
  amount: string;
}

export interface ReportView {
  currency: "USD";
  /** цена рубля в долларах на день закрытия; `null` — рубли не понадобились */
  rubRate: string | null;
  revenue: ReportLine[];
  otherIncome: ReportLine[];
  expenses: ReportLine[];
  grossRevenue: string;
  totalExpenses: string;
  profitBeforeTax: string;
  tax: {
    rub: string;
    usd: string;
    byPayer: { payer: "individual" | "legal"; receiptsRub: string; ratePercent: string; taxRub: string }[];
  };
  netProfit: string;
  tranches: { loanId: string; lender: string; usd: string; inLoanCurrency: string; currency: string; remainingAfterUsd: string }[];
  toDistribute: string;
  payouts: { accountId: string; name: string; percent: string; usd: string; rub: string }[];
  ownerAmount: string;
  noDistribution: boolean;
}

export interface PeriodReportView {
  period: string;
  status: PeriodStatus;
  reopenedCount: number;
  reviewAt: string | null;
  closedAt: string | null;
  checklist: ChecklistItem[];
  /** чек-лист без блокеров, месяц на сверке и отчёт посчитан */
  canClose: boolean;
  /** `true` — отчёт посчитан сейчас, до закрытия; `false` — это снимок закрытия */
  reportIsDraft: boolean;
  /** `null` — считать не из чего: нет курса на дату проводки */
  report: ReportView | null;
}

export function listItemOf(row: Pick<PeriodRow, "period" | "status" | "reopenedCount" | "reviewAt" | "closedAt">): PeriodListItem {
  return { period: row.period, status: row.status, reopenedCount: row.reopenedCount, reviewAt: row.reviewAt?.toISOString() ?? null, closedAt: row.closedAt?.toISOString() ?? null };
}

const usd = (cents: string): string => formatMinor(BigInt(cents), USD);
const rub = (kopecks: string): string => formatMinor(BigInt(kopecks), RUB);
/** Сотые доли процента процентами: 2 500 — «25.00». */
const percent = (bp: number): string => formatMinor(BigInt(bp), { code: "%", decimals: 2 });

/** Название строки водопада: счёт по справочнику снимка; строка «контра» — перенесённый минус другого счёта. */
function nameOf(snapshot: PeriodSnapshot, key: string): string {
  if (key.startsWith("contra:")) {
    const accountId = key.slice("contra:".length);
    return `Возвраты и сторно: ${snapshot.accounts[accountId] ?? accountId}`;
  }
  return snapshot.accounts[key] ?? key;
}

/** Отчёт месяца из снимка закрытия или из черновика закрытия — одним и тем же кодом. */
export function reportOf(snapshot: PeriodSnapshot): ReportView {
  const { waterfall } = snapshot;
  const lines = (list: { key: string; amount: string }[]): ReportLine[] => list.map((entry) => ({ key: entry.key, name: nameOf(snapshot, entry.key), amount: usd(entry.amount) }));
  const loanOf = (loanId: string) => snapshot.loans.find((loan) => loan.loanId === loanId);
  const rubPayout = (accountId: string) => snapshot.rub.payouts.find((payout) => payout.accountId === accountId);
  return {
    currency: "USD",
    rubRate: snapshot.rubRate?.usdPerUnit ?? null,
    revenue: lines(waterfall.revenue),
    otherIncome: lines(waterfall.otherIncome),
    expenses: lines(waterfall.expenses),
    grossRevenue: usd(waterfall.grossRevenue),
    totalExpenses: usd(waterfall.totalExpenses),
    profitBeforeTax: usd(waterfall.profitBeforeTax),
    tax: {
      rub: rub(snapshot.tax.taxMinor),
      usd: usd(snapshot.tax.usdCents),
      byPayer: snapshot.tax.byPayer.map((line) => ({ payer: line.payer, receiptsRub: rub(line.rubMinor), ratePercent: percent(line.bp), taxRub: rub(line.taxMinor) })),
    },
    netProfit: usd(waterfall.netProfit),
    tranches: waterfall.tranches.map((tranche) => {
      const loan = loanOf(tranche.loanId);
      const currency = loan?.currency ?? "";
      return {
        loanId: tranche.loanId,
        lender: loan?.lender ?? tranche.loanId,
        usd: usd(tranche.amount),
        inLoanCurrency: loan === undefined ? "0" : formatMinor(BigInt(loan.trancheMinor), currencySpec(currency)),
        currency,
        remainingAfterUsd: usd(tranche.remainingAfter),
      };
    }),
    toDistribute: usd(waterfall.toDistribute),
    payouts: waterfall.payouts.map((payout) => ({
      accountId: payout.accountId,
      name: snapshot.accounts[payout.accountId] ?? payout.accountId,
      percent: percent(payout.bp),
      usd: usd(payout.amount),
      rub: rub(rubPayout(payout.accountId)?.rubMinor ?? "0"),
    })),
    ownerAmount: usd(waterfall.ownerAmount),
    noDistribution: waterfall.noDistribution,
  };
}
