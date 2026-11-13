import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../../generated/prisma/client.js";
import { PRISMA } from "../../../infra/database.js";
import { monthKey, shareAt, type ShareRecord } from "../../stakeholders/stakeholder-rules.js";
import { groupOf, type FactLine, type Receipt } from "./period-facts.js";
import { closePrefix, periodRange, reopenKey, yearStart, type PeriodStatus } from "./period-rules.js";
import { parseSnapshot } from "./period-snapshot.js";
import type { ClosePlan, CloseOutcome, MissingReceipt, MonthSource, OpenOperation, PeriodRow, PeriodsRepository, ReopenOutcome, ReopenPlan, ReviewOutcome, SourceLoan, SourceShare } from "./period-types.js";

/**
 * Месяцы учёта в базе (`ledger_period`; docs/37-accounting.md §13, Р222, tasks/T-0468). Читает журнал, операции,
 * покупки, займы и доли для сверки; закрытие и снятие закрытия пишет одной транзакцией под блокировкой строки
 * месяца (`SELECT … FOR UPDATE`): снимок, проводки и статус ложатся вместе или не ложатся вовсе, а из двух
 * одновременных вызовов проходит один. Проводки закрытия пишутся здесь же, мимо `LedgerService.post`: ему нужна
 * та же транзакция, а замок закрытого месяца не должен мешать самому закрытию и его снятию.
 */

/** Транзакция закрытия: проводки, счета и снимок — секунды, а не минуты; зависшую база отпустит сама. */
const CLOSE_TX = { maxWait: 5_000, timeout: 30_000 } as const;

/** Не больше этого числа неоплаченных покупок в ответе: остальные видны после того, как эти проведут. */
const UNPOSTED_LIMIT = 1_000;

const STATUSES: readonly PeriodStatus[] = ["open", "review", "closed"];

/** Что в транзакции доступно и клиенту базы, и клиенту внутри `$transaction`. */
type Db = Prisma.TransactionClient;

const count = z.number().int().min(0);

const receiptRow = z.object({
  entryId: z.string(),
  sourceKey: z.string(),
  at: z.coerce.date(),
  period: z.string(),
  payer: z.enum(["individual", "legal"]),
  number: z.string().nullable(),
  link: z.string().nullable(),
  // SUM по bigint — numeric: приводится к тексту в запросе, чтобы копейки не прошли через число с плавающей точкой
  amount: z.string().regex(/^\d+$/u),
});

const missingReceiptRow = z.object({ entryId: z.string(), sourceKey: z.string(), operationId: z.string().nullable() });
const operationRow = z.object({ operationId: z.string(), status: z.enum(["draft", "pending"]) });
const purchaseRow = z.object({ purchaseId: z.string() });
const loanRow = z.object({
  loanId: z.string(),
  lender: z.string(),
  currency: z.string(),
  principal: z.string().regex(/^\d+$/u),
  premium: z.string().regex(/^\d+$/u),
  repaymentBp: count,
  takenAt: z.coerce.date(),
});
const lockRow = z.object({ status: z.string(), reopenedCount: count });

function toStatus(value: string): PeriodStatus {
  const found = STATUSES.find((status) => status === value);
  if (found === undefined) throw new Error(`В базе у месяца учёта неизвестный статус «${value}»`);
  return found;
}

function toRow(row: Prisma.LedgerPeriodGetPayload<Record<string, never>>): PeriodRow {
  return {
    period: row.period,
    status: row.status,
    reviewAt: row.reviewAt,
    reviewBy: row.reviewBy,
    closedAt: row.closedAt,
    closedBy: row.closedBy,
    reopenedCount: row.reopenedCount,
    snapshot: row.snapshot,
    updatedAt: row.updatedAt,
  };
}

/** Отпечаток журнала месяца: сколько в нём проводок и когда записана последняя. Меняется от любой новой проводки. */
async function fingerprintOf(db: Db, period: string): Promise<string> {
  const total = await db.ledgerEntry.aggregate({ where: { period }, _count: { _all: true }, _max: { createdAt: true } });
  return `${String(total._count._all)}:${total._max.createdAt?.toISOString() ?? "-"}`;
}

/** Блокировка строки месяца до конца транзакции; `null` — строки нет (месяц «открыт»). */
async function lockPeriod(tx: Db, period: string): Promise<{ status: PeriodStatus; reopenedCount: number } | null> {
  const rows = await tx.$queryRaw<unknown[]>`SELECT status::text AS "status", reopened_count AS "reopenedCount" FROM ledger_period WHERE period = ${period} FOR UPDATE`;
  const first = rows[0];
  if (first === undefined) return null;
  const parsed = lockRow.parse(first);
  return { status: toStatus(parsed.status), reopenedCount: parsed.reopenedCount };
}

@Injectable()
export class PrismaPeriodsRepository implements PeriodsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async row(period: string): Promise<PeriodRow | null> {
    const row = await this.prisma.ledgerPeriod.findUnique({ where: { period } });
    return row === null ? null : toRow(row);
  }

  async rows(): Promise<PeriodRow[]> {
    const rows = await this.prisma.ledgerPeriod.findMany({ orderBy: { period: "desc" } });
    return rows.map(toRow);
  }

  async firstEntryPeriod(): Promise<string | null> {
    const first = await this.prisma.ledgerEntry.aggregate({ _min: { period: true } });
    return first._min.period;
  }

  async startReview(period: string, by: string, at: Date): Promise<ReviewOutcome> {
    // Строка появляется при первом обращении: `skipDuplicates` — это `ON CONFLICT DO NOTHING`, гонка двух вызовов безопасна.
    await this.prisma.ledgerPeriod.createMany({ data: [{ period }], skipDuplicates: true });
    const started = await this.prisma.ledgerPeriod.updateMany({ where: { period, status: "open" }, data: { status: "review", reviewAt: at, reviewBy: by } });
    if (started.count > 0) return "started";
    const row = await this.prisma.ledgerPeriod.findUnique({ where: { period }, select: { status: true } });
    return row?.status === "closed" ? "closed" : "already";
  }

  async loadMonth(period: string): Promise<MonthSource> {
    const [lines, receipts, receiptsMissing, openOperations, unpostedPurchaseIds, loans, shares, fingerprint] = await Promise.all([
      this.lines(period),
      this.receipts(period),
      this.receiptsMissing(period),
      this.openOperations(period),
      this.unpostedPurchases(period),
      this.loans(period),
      this.shares(period),
      fingerprintOf(this.prisma, period),
    ]);
    return { lines, receipts: receipts.month, yearReceiptsMinor: receipts.yearMinor, receiptsMissing, openOperations, unpostedPurchaseIds, loans, shares, fingerprint };
  }

  async commitClose(plan: ClosePlan): Promise<CloseOutcome> {
    return await this.prisma.$transaction(async (tx): Promise<CloseOutcome> => {
      const locked = await lockPeriod(tx, plan.period);
      if (locked === null || locked.status !== "review") return { outcome: "not_review", status: locked?.status ?? "open" };
      // Закрытие считали по месяцу, каким он был: другой номер раза или новая проводка — считать заново.
      if (locked.reopenedCount !== plan.round || (await fingerprintOf(tx, plan.period)) !== plan.fingerprint) return { outcome: "changed" };

      if (plan.accounts.length > 0) {
        await tx.ledgerAccount.createMany({ data: plan.accounts.map((account) => ({ accountId: account.accountId, type: account.type, currency: account.currency, name: account.name })), skipDuplicates: true });
      }
      for (const entry of plan.entries) {
        await tx.ledgerEntry.create({
          data: {
            entryId: randomUUID(),
            sourceKey: entry.sourceKey,
            at: entry.at,
            period: entry.period,
            memo: entry.memo,
            meta: entry.meta,
            createdBy: plan.closedBy,
            lines: { create: entry.lines.map((line) => ({ lineId: randomUUID(), accountId: line.accountId, amount: line.amount })) },
          },
        });
      }
      await tx.ledgerPeriod.update({ where: { period: plan.period }, data: { status: "closed", closedAt: plan.closedAt, closedBy: plan.closedBy, snapshot: plan.snapshot } });
      return { outcome: "closed" };
    }, CLOSE_TX);
  }

  async commitReopen(plan: ReopenPlan): Promise<ReopenOutcome> {
    return await this.prisma.$transaction(async (tx): Promise<ReopenOutcome> => {
      const locked = await lockPeriod(tx, plan.period);
      if (locked === null || locked.status !== "closed") return { outcome: "not_closed", status: locked?.status ?? "open" };
      if (locked.reopenedCount !== plan.round) return { outcome: "changed" };

      // Проводки закрытия этого раза, у которых сторно ещё нет: у остальных (прежних раз) оно уже есть.
      const originals = await tx.ledgerEntry.findMany({ where: { sourceKey: { startsWith: closePrefix(plan.period, plan.round) }, reversal: { is: null } }, include: { lines: true }, orderBy: { sourceKey: "asc" } });
      for (const original of originals) {
        await tx.ledgerEntry.create({
          data: {
            entryId: randomUUID(),
            sourceKey: reopenKey(original.sourceKey),
            at: plan.at,
            // месяц у сторно тот же, что у закрытия: так сумма по месяцу возвращается к нулю
            period: plan.period,
            memo: `Снятие закрытия ${plan.period}: ${plan.reason}`.slice(0, 500),
            reversalOf: original.entryId,
            meta: { reopenPeriod: plan.period, reopenRound: plan.round },
            createdBy: plan.by,
            lines: { create: original.lines.map((line) => ({ lineId: randomUUID(), accountId: line.accountId, amount: -line.amount })) },
          },
        });
      }
      await tx.ledgerPeriod.update({
        where: { period: plan.period },
        data: { status: "review", reopenedCount: { increment: 1 }, closedAt: null, closedBy: null, snapshot: Prisma.DbNull },
      });
      return { outcome: "reopened", reversed: originals.length };
    }, CLOSE_TX);
  }

  /** Строки выручки, поступлений и расходов месяца: из них собирается водопад. */
  private async lines(period: string): Promise<FactLine[]> {
    const rows = await this.prisma.ledgerLine.findMany({
      where: { entry: { period }, account: { type: { in: ["revenue", "expense"] } } },
      select: { accountId: true, amount: true, account: { select: { type: true, currency: true, name: true } }, entry: { select: { at: true } } },
    });
    return rows
      .map((row) => ({ accountId: row.accountId, accountName: row.account.name, type: row.account.type, currency: row.account.currency, at: row.entry.at, minor: row.amount }))
      .filter((line) => groupOf(line.accountId, line.type) !== null);
  }

  /**
   * Чеки НПД: проводки с указанным плательщиком, у которых рублёвое место получило деньги. Сумма чека — зачисление
   * на место (транзит обмена и сторнированные проводки не считаются); за год по этот месяц — для лимита НПД.
   * Сторно в более позднем месяце чек этого месяца не отменяет: закрытый месяц не пересчитывается.
   */
  private async receipts(period: string): Promise<{ month: Receipt[]; yearMinor: bigint }> {
    const rows = z.array(receiptRow).parse(
      await this.prisma.$queryRaw<unknown[]>`
        SELECT e.entry_id::text AS "entryId", e.source_key AS "sourceKey", e.at AS "at", e.period AS "period",
               e.meta->>'receiptPayer' AS "payer", e.meta->>'receiptNumber' AS "number", e.meta->>'receiptLink' AS "link",
               SUM(l.amount)::text AS "amount"
        FROM ledger_entry e
        JOIN ledger_line l ON l.entry_id = e.entry_id
        JOIN ledger_account a ON a.account_id = l.account_id
        WHERE e.period >= ${yearStart(period)} AND e.period <= ${period}
          AND e.meta->>'receiptPayer' IN ('individual', 'legal')
          AND a.type = 'asset' AND a.currency = 'RUB' AND l.amount > 0 AND a.account_id NOT LIKE 'exchange.transit.%'
          AND NOT EXISTS (SELECT 1 FROM ledger_entry r WHERE r.reversal_of = e.entry_id AND r.period <= ${period})
        GROUP BY e.entry_id, e.source_key, e.at, e.period, e.meta
        ORDER BY e.at, e.entry_id`,
    );
    const all: Receipt[] = rows.map((row) => ({ entryId: row.entryId, sourceKey: row.sourceKey, at: row.at, period: row.period, payer: row.payer, rubMinor: BigInt(row.amount), number: row.number, link: row.link }));
    return { month: all.filter((receipt) => receipt.period === period), yearMinor: all.reduce((sum, receipt) => sum + receipt.rubMinor, 0n) };
  }

  /** Рублёвые поступления месяца без чека: операции «поступление» и «обмен» с зачислением в рубли и без плательщика. */
  private async receiptsMissing(period: string): Promise<MissingReceipt[]> {
    const rows = z.array(missingReceiptRow).parse(
      await this.prisma.$queryRaw<unknown[]>`
        SELECT e.entry_id::text AS "entryId", e.source_key AS "sourceKey", e.meta->>'operation' AS "operationId"
        FROM ledger_entry e
        WHERE e.period = ${period}
          AND e.meta->>'kind' IN ('income', 'exchange')
          AND e.meta->>'receiptPayer' IS NULL
          AND EXISTS (
            SELECT 1 FROM ledger_line l JOIN ledger_account a ON a.account_id = l.account_id
            WHERE l.entry_id = e.entry_id AND a.type = 'asset' AND a.currency = 'RUB' AND l.amount > 0 AND a.account_id NOT LIKE 'exchange.transit.%')
          AND NOT EXISTS (SELECT 1 FROM ledger_entry r WHERE r.reversal_of = e.entry_id AND r.period <= ${period})
        ORDER BY e.at, e.entry_id`,
    );
    return rows;
  }

  /**
   * Черновики и операции на подтверждении месяца. Месяц операции — «за какой месяц» у поступления, а иначе месяц
   * даты; черновик из шаблона расхода принадлежит месяцу шаблона.
   */
  private async openOperations(period: string): Promise<OpenOperation[]> {
    return z.array(operationRow).parse(
      await this.prisma.$queryRaw<unknown[]>`
        SELECT operation_id::text AS "operationId", status::text AS "status"
        FROM ledger_operation
        WHERE status IN ('draft', 'pending')
          AND (template_period = ${period} OR COALESCE(input->>'forMonth', SUBSTRING(input->>'at' FROM 1 FOR 7)) = ${period})
        ORDER BY created_at, operation_id`,
    );
  }

  /** Живые оплаты месяца без проводки оплаты: сверка платежей отстала (ключ — `purchase:<id>:paid`, T-0458). */
  private async unpostedPurchases(period: string): Promise<string[]> {
    const { from, to } = periodRange(period);
    const rows = z.array(purchaseRow).parse(
      await this.prisma.$queryRaw<unknown[]>`
        SELECT p.purchase_id::text AS "purchaseId"
        FROM purchase p
        WHERE p.mode = 'live' AND p.paid_at >= ${from} AND p.paid_at < ${to}
          AND NOT EXISTS (SELECT 1 FROM ledger_entry e WHERE e.source_key = 'purchase:' || p.purchase_id::text || ':paid')
        ORDER BY p.paid_at, p.purchase_id
        LIMIT ${UNPOSTED_LIMIT}`,
    );
    return rows.map((row) => row.purchaseId);
  }

  /**
   * Займы, полученные не позже конца месяца и не сторнированные, с остатком: сколько уже погасили транши закрытых
   * месяцев до этого (по их снимкам) — так остаток убывает сам.
   */
  private async loans(period: string): Promise<SourceLoan[]> {
    const { to } = periodRange(period);
    const rows = z.array(loanRow).parse(
      await this.prisma.$queryRaw<unknown[]>`
        SELECT l.loan_id::text AS "loanId", l.lender AS "lender", l.currency AS "currency", l.principal::text AS "principal",
               l.premium::text AS "premium", l.repayment_bp AS "repaymentBp", e.at AS "takenAt"
        FROM ledger_loan l
        JOIN ledger_operation o ON o.operation_id = l.operation_id
        JOIN ledger_entry e ON e.source_key = o.source_key
        WHERE e.at < ${to}
          AND NOT EXISTS (SELECT 1 FROM ledger_entry r WHERE r.reversal_of = e.entry_id AND r.period <= ${period})
        ORDER BY e.at, l.loan_id`,
    );
    if (rows.length === 0) return [];
    const repaid = new Map<string, bigint>();
    const closed = await this.prisma.ledgerPeriod.findMany({ where: { status: "closed", period: { lt: period } }, select: { snapshot: true } });
    for (const row of closed) {
      for (const loan of parseSnapshot(row.snapshot).loans) repaid.set(loan.loanId, (repaid.get(loan.loanId) ?? 0n) + BigInt(loan.trancheMinor));
    }
    return rows.map((row) => ({
      loanId: row.loanId,
      lender: row.lender,
      currency: row.currency,
      principalMinor: BigInt(row.principal),
      premiumMinor: BigInt(row.premium),
      repaidMinor: repaid.get(row.loanId) ?? 0n,
      repaymentBp: row.repaymentBp,
      takenAt: row.takenAt,
    }));
  }

  /** Доли участников на месяц: последняя запись истории не позже месяца у каждого аккаунта; нулевые не показываются. */
  protected async shares(period: string): Promise<SourceShare[]> {
    const rows = await this.prisma.stakeholderShare.findMany({ select: { accountId: true, fromMonth: true, shareBp: true, account: { select: { displayName: true } } } });
    const history = new Map<string, { name: string; records: ShareRecord[] }>();
    for (const row of rows) {
      const record: ShareRecord = { accountId: row.accountId, fromMonth: monthKey(row.fromMonth), shareBp: row.shareBp };
      const found = history.get(row.accountId);
      if (found === undefined) history.set(row.accountId, { name: row.account.displayName, records: [record] });
      else found.records.push(record);
    }
    return [...history]
      .map(([accountId, { name, records }]) => ({ accountId, name, bp: shareAt(records, period) }))
      .filter((share) => share.bp > 0)
      .sort((a, b) => a.name.localeCompare(b.name) || a.accountId.localeCompare(b.accountId));
  }
}
