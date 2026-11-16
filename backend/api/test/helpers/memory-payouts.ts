import type { PeriodStatus } from "../../src/modules/ledger/periods/period-rules.js";
import { snapshotSchema, type PeriodSnapshot } from "../../src/modules/ledger/periods/period-snapshot.js";
import type { PayoutRecord, PayoutsRepository, StoredConfirmation, StoredLoanAccount, StoredPeriod } from "../../src/modules/ledger/payouts/payouts.repository.js";

/**
 * Данные месяца для выплат в памяти — для тестов модуля выплат и маршрутов (Р222, tasks/T-0469). Смысл тот же, что у
 * реализации на Prisma: подтверждение одно на участника и месяц, повторная запись его заменяет; выплаты и сальдо тест
 * задаёт сам.
 */
export class MemoryPayoutsRepository implements PayoutsRepository {
  readonly periods = new Map<string, StoredPeriod>();
  readonly confirmationRows = new Map<string, StoredConfirmation>();
  readonly payoutRows: PayoutRecord[] = [];
  readonly loans = new Map<string, StoredLoanAccount>();
  readonly balances = new Map<string, bigint>();
  readonly accountNames = new Map<string, string>();
  /** получатели закрытия по ключам `close:<месяц>:r<N>:payout:<аккаунт>`: журнал хранит их и после снятия закрытия */
  readonly closeKeys: { period: string; round: number; accountId: string }[] = [];
  /** «проводка выплаты есть в журнале, а отметки «проведена» ещё нет» — сбой между ними */
  readonly journaledPayouts = new Set<string>();
  /** `true` — запись или чтение подтверждений падает: проверка «сбой не ломает ответ» */
  failClear = false;

  private key(period: string, accountId: string): string {
    return `${period}|${accountId}`;
  }

  /** Закрыть месяц в памяти: статус, время закрытия и снимок. */
  close(period: string, snapshot: unknown, closedAt: Date, reopenedCount = 0): void {
    this.periods.set(period, { period, status: "closed", closedAt, reopenedCount, snapshot });
  }

  setStatus(period: string, status: PeriodStatus): void {
    const row = this.periods.get(period);
    if (row === undefined) this.periods.set(period, { period, status, closedAt: null, reopenedCount: 0, snapshot: null });
    else this.periods.set(period, { ...row, status, closedAt: status === "closed" ? row.closedAt : null, snapshot: status === "closed" ? row.snapshot : null });
  }

  async period(period: string): Promise<StoredPeriod | null> {
    return this.periods.get(period) ?? null;
  }

  async confirmation(period: string, accountId: string): Promise<StoredConfirmation | null> {
    return this.confirmationRows.get(this.key(period, accountId)) ?? null;
  }

  async confirmations(period: string): Promise<StoredConfirmation[]> {
    return [...this.confirmationRows.values()].filter((row) => row.period === period);
  }

  async saveConfirmation(confirmation: StoredConfirmation): Promise<void> {
    this.confirmationRows.set(this.key(confirmation.period, confirmation.accountId), confirmation);
  }

  async clearConfirmations(period: string): Promise<number> {
    if (this.failClear) throw new Error("база недоступна");
    let removed = 0;
    for (const [key, row] of [...this.confirmationRows]) {
      if (row.period !== period) continue;
      this.confirmationRows.delete(key);
      removed += 1;
    }
    return removed;
  }

  async debtBalance(accountId: string): Promise<bigint> {
    return this.balances.get(accountId) ?? 0n;
  }

  async payoutsOf(period: string): Promise<PayoutRecord[]> {
    return this.payoutRows.filter((row) => row.period === period);
  }

  async hasPayouts(period: string): Promise<boolean> {
    return this.payoutRows.some((row) => row.period === period) || [...this.journaledPayouts].some((key) => key.startsWith(`${period}|`));
  }

  async loan(loanId: string): Promise<StoredLoanAccount | null> {
    return this.loans.get(loanId) ?? null;
  }

  async closeRecipients(period: string, round: number): Promise<string[]> {
    return this.closeKeys.filter((row) => row.period === period && row.round === round).map((row) => row.accountId);
  }

  async names(accountIds: readonly string[]): Promise<Map<string, string>> {
    return new Map(accountIds.flatMap((accountId) => (this.accountNames.has(accountId) ? [[accountId, this.accountNames.get(accountId) ?? accountId] as const] : [])));
  }
}

export interface SnapshotInput {
  period: string;
  closedAt: Date;
  /** долги участникам в рублях: сумма в копейках; название — для отчёта */
  payouts?: { accountId: string; rubMinor: bigint; name?: string }[];
  taxMinor?: bigint;
  loans?: { loanId: string; lender: string; currency: string; trancheMinor: bigint }[];
  ownerUsdCents?: bigint;
  round?: number;
}

/** Снимок закрытого месяца ровно в той форме, что хранит база: проходит ту же схему, что и чтение из `ledger_period.snapshot`. */
export function closedSnapshot(input: SnapshotInput): PeriodSnapshot {
  const payouts = input.payouts ?? [];
  const text = (value: bigint) => value.toString();
  return snapshotSchema.parse({
    version: 1,
    period: input.period,
    closedAt: input.closedAt.toISOString(),
    round: input.round ?? 0,
    settings: { npdRateIndividualBp: 400, npdRateLegalBp: 600, npdYearLimitRub: 2_400_000, npdWarnPercent: 80 },
    rubRate: { usdPerUnit: "0.0125", at: input.closedAt.toISOString(), stale: false },
    accounts: Object.fromEntries(payouts.map((payout) => [payout.accountId, payout.name ?? payout.accountId])),
    buckets: [],
    receipts: [],
    tax: { byPayer: [], taxMinor: text(input.taxMinor ?? 0n), usdCents: "0" },
    loans: (input.loans ?? []).map((loan) => ({
      loanId: loan.loanId,
      lender: loan.lender,
      currency: loan.currency,
      usdPerUnit: "1",
      remainingMinor: text(loan.trancheMinor),
      remainingUsdCents: "0",
      repaymentBp: 1_000,
      trancheUsdCents: "0",
      trancheMinor: text(loan.trancheMinor),
    })),
    shares: payouts.map((payout) => ({ accountId: payout.accountId, bp: 2_500 })),
    waterfall: {
      revenue: [],
      otherIncome: [],
      expenses: [],
      grossRevenue: "0",
      totalExpenses: "0",
      profitBeforeTax: "0",
      tax: "0",
      netProfit: "0",
      tranches: [],
      toDistribute: "0",
      payouts: payouts.map((payout) => ({ accountId: payout.accountId, bp: 2_500, amount: "0" })),
      ownerAmount: text(input.ownerUsdCents ?? 0n),
      noDistribution: false,
    },
    rub: {
      taxMinor: text(input.taxMinor ?? 0n),
      payouts: payouts.map((payout) => ({ accountId: payout.accountId, bp: 2_500, usdCents: "0", rubMinor: text(payout.rubMinor) })),
      ownerUsdCents: text(input.ownerUsdCents ?? 0n),
    },
    entries: [],
    warnings: [],
  });
}
