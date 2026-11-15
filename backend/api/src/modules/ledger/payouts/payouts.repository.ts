import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { PRISMA } from "../../../infra/database.js";
import type { PayoutRecord, StoredConfirmation, StoredLoanAccount, StoredPeriod } from "./payout-types.js";

export type { ConfirmationStatus, PayoutRecord, StoredConfirmation, StoredLoanAccount, StoredPeriod } from "./payout-types.js";

/**
 * Подтверждения и выплаты месяца в базе (`ledger_confirmation`, `ledger_operation`, журнал; docs/37-accounting.md §13,
 * Р222, tasks/T-0469). Здесь только чтение журнала и подтверждений: проводки выплат пишет `OperationsService`, а
 * закрытие и снятие закрытия — `PeriodsService`. Сумма выплаты читается по строке журнала, а не по вводу операции:
 * ввод — слова человека, а деньги — то, что записано.
 */

export const PAYOUTS_REPOSITORY = Symbol("PAYOUTS_REPOSITORY");

export interface PayoutsRepository {
  /** Строка месяца; `null` — у месяца её нет (он открыт). */
  period(period: string): Promise<StoredPeriod | null>;
  confirmation(period: string, accountId: string): Promise<StoredConfirmation | null>;
  confirmations(period: string): Promise<StoredConfirmation[]>;
  /** Одно решение на участника и месяц: повторная запись заменяет прежнее. */
  saveConfirmation(confirmation: StoredConfirmation): Promise<void>;
  /** Стереть подтверждения месяца; сколько стёрто. */
  clearConfirmations(period: string): Promise<number>;
  /** Кредитовое сальдо счёта обязательства: сколько ещё записано долгом (минус сумма строк). */
  debtBalance(accountId: string): Promise<bigint>;
  /** Проведённые и не сторнированные выплаты месяца. */
  payoutsOf(period: string): Promise<PayoutRecord[]>;
  /** По месяцу была выплата: проведённая операция или проводка `op:<id>` в журнале (сбой между ними). */
  hasPayouts(period: string): Promise<boolean>;
  loan(loanId: string): Promise<StoredLoanAccount | null>;
  /** Участники, которым закрытие этого раза записало долг: по ключам проводок `close:<месяц>:r<N>:payout:<аккаунт>`. */
  closeRecipients(period: string, round: number): Promise<string[]>;
  names(accountIds: readonly string[]): Promise<Map<string, string>>;
}

const payoutRow = z.object({
  operationId: z.string(),
  period: z.string(),
  payee: z.string(),
  accountId: z.string(),
  currency: z.string(),
  // сумма — bigint, который через число с плавающей точкой пройти не должен
  minor: z.string().regex(/^\d+$/u),
  overrideReason: z.string().nullable(),
  at: z.coerce.date(),
});

const foundRow = z.object({ found: z.boolean() });

@Injectable()
export class PrismaPayoutsRepository implements PayoutsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async period(period: string): Promise<StoredPeriod | null> {
    const row = await this.prisma.ledgerPeriod.findUnique({ where: { period } });
    return row === null ? null : { period: row.period, status: row.status, closedAt: row.closedAt, reopenedCount: row.reopenedCount, snapshot: row.snapshot };
  }

  async confirmation(period: string, accountId: string): Promise<StoredConfirmation | null> {
    const row = await this.prisma.ledgerConfirmation.findUnique({ where: { period_accountId: { period, accountId } } });
    return row === null ? null : { period: row.period, accountId: row.accountId, status: row.status, comment: row.comment, decidedAt: row.decidedAt };
  }

  async confirmations(period: string): Promise<StoredConfirmation[]> {
    const rows = await this.prisma.ledgerConfirmation.findMany({ where: { period }, orderBy: { accountId: "asc" } });
    return rows.map((row) => ({ period: row.period, accountId: row.accountId, status: row.status, comment: row.comment, decidedAt: row.decidedAt }));
  }

  async saveConfirmation(confirmation: StoredConfirmation): Promise<void> {
    const data = { status: confirmation.status, comment: confirmation.comment, decidedAt: confirmation.decidedAt };
    await this.prisma.ledgerConfirmation.upsert({
      where: { period_accountId: { period: confirmation.period, accountId: confirmation.accountId } },
      create: { period: confirmation.period, accountId: confirmation.accountId, ...data },
      update: data,
    });
  }

  async clearConfirmations(period: string): Promise<number> {
    return (await this.prisma.ledgerConfirmation.deleteMany({ where: { period } })).count;
  }

  async debtBalance(accountId: string): Promise<bigint> {
    const total = await this.prisma.ledgerLine.aggregate({ where: { accountId }, _sum: { amount: true } });
    return -(total._sum.amount ?? 0n);
  }

  async payoutsOf(period: string): Promise<PayoutRecord[]> {
    // Строка выплаты на стороне обязательства (или «Выплат владельцу») — положительная; строка места — отрицательная.
    const rows = z.array(payoutRow).parse(
      await this.prisma.$queryRaw<unknown[]>`
        SELECT o.operation_id::text AS "operationId", o.payout_period AS "period", o.payee AS "payee", l.account_id AS "accountId",
               a.currency AS "currency", l.amount::text AS "minor", o.override_reason AS "overrideReason", e.at AS "at"
        FROM ledger_operation o
        JOIN ledger_entry e ON e.source_key = o.source_key
        JOIN ledger_line l ON l.entry_id = e.entry_id
        JOIN ledger_account a ON a.account_id = l.account_id
        WHERE o.kind = 'payout' AND o.status = 'posted' AND o.payout_period = ${period}
          AND l.amount > 0 AND a.type IN ('liability', 'equity')
          AND NOT EXISTS (SELECT 1 FROM ledger_entry r WHERE r.reversal_of = e.entry_id)
        ORDER BY e.at, o.operation_id`,
    );
    return rows.map((row) => ({ ...row, minor: BigInt(row.minor) }));
  }

  async hasPayouts(period: string): Promise<boolean> {
    const [row] = z.array(foundRow).parse(
      await this.prisma.$queryRaw<unknown[]>`
        SELECT EXISTS (
          SELECT 1 FROM ledger_operation o
          WHERE o.kind = 'payout' AND o.payout_period = ${period}
            AND (o.status = 'posted' OR EXISTS (SELECT 1 FROM ledger_entry e WHERE e.source_key = 'op:' || o.operation_id::text))
        ) AS "found"`,
    );
    return row?.found === true;
  }

  async loan(loanId: string): Promise<StoredLoanAccount | null> {
    const row = await this.prisma.ledgerLoan.findUnique({ where: { loanId }, select: { loanId: true, accountId: true, currency: true, lender: true } });
    return row;
  }

  async closeRecipients(period: string, round: number): Promise<string[]> {
    const prefix = `close:${period}:r${String(round)}:payout:`;
    const rows = await this.prisma.ledgerEntry.findMany({ where: { sourceKey: { startsWith: prefix } }, select: { sourceKey: true }, orderBy: { sourceKey: "asc" } });
    return rows.map((row) => row.sourceKey.slice(prefix.length));
  }

  async names(accountIds: readonly string[]): Promise<Map<string, string>> {
    if (accountIds.length === 0) return new Map();
    const rows = await this.prisma.account.findMany({ where: { accountId: { in: [...accountIds] } }, select: { accountId: true, displayName: true } });
    return new Map(rows.map((row) => [row.accountId, row.displayName]));
  }
}
