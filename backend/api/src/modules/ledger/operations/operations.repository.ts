import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type PrismaClient } from "../../../generated/prisma/client.js";
import { PRISMA } from "../../../infra/database.js";
import type { JournalCursor } from "../ledger-cursor.js";
import type { BuiltLoan, ServiceAccount } from "./builders.js";
import type { OperationKind, OperationStatus, StoredFields } from "./operation-input.js";

/**
 * Ручные операции учёта в базе (`ledger_operation`, `ledger_loan`; Р220, tasks/T-0461). Журнал проводок здесь
 * только читается — писать в него умеет `LedgerService`: операция хранит, что ввёл человек, а проводка `op:<id>`
 * появляется отдельно и идемпотентно.
 */

export interface StoredOperation {
  operationId: string;
  kind: OperationKind;
  status: OperationStatus;
  /** JSON из базы: форму разбирает сервис, репозиторий ей не доверяет */
  input: unknown;
  note: string;
  link: string | null;
  /** id картинки снимка чека в хранилище картинок панели */
  receiptImage: string | null;
  /** «1234.50» — десятичной строкой; пусто — курса не было */
  amountUsd: string | null;
  sourceKey: string | null;
  createdBy: string;
  createdAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  templateId: string | null;
  templatePeriod: string | null;
}

export interface NewOperation {
  operationId: string;
  kind: OperationKind;
  input: StoredFields;
  note: string;
  link: string | null;
  receiptImage: string | null;
  amountUsd: string | null;
  createdBy: string;
  templateId: string | null;
  templatePeriod: string | null;
}

/** Что меняется у черновика при правке; автор, шаблон и время создания остаются. */
export interface DraftPatch {
  kind: OperationKind;
  input: StoredFields;
  note: string;
  link: string | null;
  receiptImage: string | null;
  amountUsd: string | null;
}

/** Решение владельца по операции на подтверждении: кто решил и что написал (при отказе причина обязательна). */
export interface DecisionRecord {
  by: string;
  note: string | null;
}

export interface OperationFilter {
  status?: OperationStatus | undefined;
  kind?: OperationKind | undefined;
}

export interface NewLoan extends BuiltLoan {
  loanId: string;
}

export interface StoredLoan {
  loanId: string;
  lender: string;
  accountId: string;
  currency: string;
  principal: bigint;
  premium: bigint;
  repaymentBp: number;
  operationId: string;
}

export interface StoredEntryLine {
  accountId: string;
  accountName: string;
  currency: string;
  amount: bigint;
}

/** Проводка операции с названиями счетов: показ не должен ходить в справочник на каждую строку. */
export interface StoredOperationEntry {
  entryId: string;
  sourceKey: string;
  at: Date;
  period: string;
  memo: string;
  /** ключ источника исходной проводки, если эта — сторно */
  reversalOf: string | null;
  meta: unknown;
  createdBy: string | null;
  lines: StoredEntryLine[];
}

/** Вставка: записана или на период шаблона уже есть черновик (уникальный `(template_id, template_period)`). */
export type InsertOutcome = "inserted" | "template_taken";

/** Отметка «проведена»: сделана сейчас, уже была (другой вызов успел), либо строки уже нет — её удалили. */
export type PostedOutcome = "posted" | "already" | "missing";

export const OPERATIONS_REPOSITORY = Symbol("OPERATIONS_REPOSITORY");

export interface OperationsRepository {
  insert(operation: NewOperation): Promise<InsertOutcome>;
  byId(operationId: string): Promise<StoredOperation | null>;
  /** Только черновик; `false` — такой операции в статусе «черновик» нет. */
  updateDraft(operationId: string, patch: DraftPatch): Promise<boolean>;
  /** Только черновик; `false` — такой операции в статусе «черновик» нет. */
  deleteDraft(operationId: string): Promise<boolean>;
  /** Новые сверху, строго после курсора `(created_at, operation_id)`. */
  list(filter: OperationFilter, cursor: JournalCursor | null, limit: number): Promise<StoredOperation[]>;
  /** Проводка с этим ключом уже есть в журнале. */
  entryExists(sourceKey: string): Promise<boolean>;
  /** Черновик → «на подтверждении» (второй ключ, Р220). `false` — черновика с таким id нет: уже ждёт, проведён или удалён. */
  markPending(operationId: string): Promise<boolean>;
  /**
   * «Проведена» и, для займа, строка условий — одной транзакцией. Строка займа создаётся только вместе с отметкой.
   * Без `decision` — черновик проводит его автор; с ним — владелец подтверждает операцию на подтверждении, и в той же
   * записи остаются решивший, время и комментарий. Условие по статусу держит гонку: из двух решений отметку ставит одно.
   */
  markPosted(operationId: string, sourceKey: string, loan: NewLoan | null, decision?: DecisionRecord): Promise<PostedOutcome>;
  /** «На подтверждении» → «отклонена» с решением. `false` — такой операции в этом статусе нет: уже решена или не найдена. */
  reject(operationId: string, decision: DecisionRecord & { note: string }): Promise<boolean>;
  /** `INSERT … ON CONFLICT DO NOTHING`: параллельные вызовы создают счёт один раз. `true` — создан этим вызовом. */
  ensureAccount(account: ServiceAccount): Promise<boolean>;
  /** Проводки по ключам источника; ключа без проводки в карте нет. */
  entriesBySource(sourceKeys: readonly string[]): Promise<Map<string, StoredOperationEntry>>;
  /** Условия займов по операциям; у операции без займа записи нет. */
  loansOf(operationIds: readonly string[]): Promise<Map<string, StoredLoan>>;
}

/** Нарушение уникальности — код Prisma; внешний ключ и прочее — настоящая ошибка и идёт наверх. */
const UNIQUE_VIOLATION = "P2002";

const toJson = (value: StoredFields): Prisma.InputJsonObject => value as Prisma.InputJsonObject;

function toStored(row: Prisma.LedgerOperationGetPayload<Record<string, never>>): StoredOperation {
  return {
    operationId: row.operationId,
    kind: row.kind,
    status: row.status,
    input: row.input,
    note: row.note,
    link: row.link,
    receiptImage: row.receiptImage,
    amountUsd: row.amountUsd === null ? null : row.amountUsd.toFixed(2),
    sourceKey: row.sourceKey,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    decisionNote: row.decisionNote,
    templateId: row.templateId,
    templatePeriod: row.templatePeriod,
  };
}

@Injectable()
export class PrismaOperationsRepository implements OperationsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async insert(operation: NewOperation): Promise<InsertOutcome> {
    try {
      await this.prisma.ledgerOperation.create({
        data: {
          operationId: operation.operationId,
          kind: operation.kind,
          input: toJson(operation.input),
          note: operation.note,
          link: operation.link,
          receiptImage: operation.receiptImage,
          amountUsd: operation.amountUsd,
          createdBy: operation.createdBy,
          templateId: operation.templateId,
          templatePeriod: operation.templatePeriod,
        },
      });
      return "inserted";
    } catch (error: unknown) {
      // Ключ операции — случайный uuid, ключа проводки при вставке ещё нет: уникальным остаётся только шаблон с периодом.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) return "template_taken";
      throw error;
    }
  }

  async byId(operationId: string): Promise<StoredOperation | null> {
    const row = await this.prisma.ledgerOperation.findUnique({ where: { operationId } });
    return row === null ? null : toStored(row);
  }

  async updateDraft(operationId: string, patch: DraftPatch): Promise<boolean> {
    const result = await this.prisma.ledgerOperation.updateMany({
      where: { operationId, status: "draft" },
      data: { kind: patch.kind, input: toJson(patch.input), note: patch.note, link: patch.link, receiptImage: patch.receiptImage, amountUsd: patch.amountUsd },
    });
    return result.count > 0;
  }

  async deleteDraft(operationId: string): Promise<boolean> {
    const result = await this.prisma.ledgerOperation.deleteMany({ where: { operationId, status: "draft" } });
    return result.count > 0;
  }

  async list(filter: OperationFilter, cursor: JournalCursor | null, limit: number): Promise<StoredOperation[]> {
    const conditions: Prisma.LedgerOperationWhereInput[] = [];
    if (filter.status !== undefined) conditions.push({ status: filter.status });
    if (filter.kind !== undefined) conditions.push({ kind: filter.kind });
    if (cursor !== null) conditions.push({ OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, operationId: { lt: cursor.entryId } }] });
    const rows = await this.prisma.ledgerOperation.findMany({
      where: { AND: conditions },
      orderBy: [{ createdAt: "desc" }, { operationId: "desc" }],
      take: limit,
    });
    return rows.map(toStored);
  }

  async entryExists(sourceKey: string): Promise<boolean> {
    return (await this.prisma.ledgerEntry.count({ where: { sourceKey } })) > 0;
  }

  async markPending(operationId: string): Promise<boolean> {
    const moved = await this.prisma.ledgerOperation.updateMany({ where: { operationId, status: "draft" }, data: { status: "pending" } });
    return moved.count > 0;
  }

  async reject(operationId: string, decision: DecisionRecord & { note: string }): Promise<boolean> {
    const moved = await this.prisma.ledgerOperation.updateMany({
      where: { operationId, status: "pending" },
      data: { status: "rejected", decidedBy: decision.by, decidedAt: new Date(), decisionNote: decision.note },
    });
    return moved.count > 0;
  }

  async markPosted(operationId: string, sourceKey: string, loan: NewLoan | null, decision?: DecisionRecord): Promise<PostedOutcome> {
    return await this.prisma.$transaction(async (tx) => {
      // Условие по статусу держит гонку: из двух одновременных проведений отметку ставит одно, второе видит ноль строк.
      // Черновик проводит автор, операцию на подтверждении — только решение владельца.
      const moved = await tx.ledgerOperation.updateMany({
        where: { operationId, status: decision === undefined ? "draft" : "pending" },
        data: { status: "posted", sourceKey, ...(decision === undefined ? {} : { decidedBy: decision.by, decidedAt: new Date(), decisionNote: decision.note }) },
      });
      if (moved.count === 0) {
        const row = await tx.ledgerOperation.findUnique({ where: { operationId }, select: { operationId: true } });
        return row === null ? "missing" : "already";
      }
      if (loan !== null) {
        await tx.ledgerLoan.create({
          data: {
            loanId: loan.loanId,
            lender: loan.lender,
            accountId: loan.accountId,
            currency: loan.currency,
            principal: loan.principal,
            premium: loan.premium,
            repaymentBp: loan.repaymentBp,
            operationId,
          },
        });
      }
      return "posted";
    });
  }

  async ensureAccount(account: ServiceAccount): Promise<boolean> {
    const result = await this.prisma.ledgerAccount.createMany({
      data: [{ accountId: account.accountId, type: account.type, currency: account.currency, name: account.name }],
      skipDuplicates: true,
    });
    return result.count > 0;
  }

  async entriesBySource(sourceKeys: readonly string[]): Promise<Map<string, StoredOperationEntry>> {
    if (sourceKeys.length === 0) return new Map();
    const rows = await this.prisma.ledgerEntry.findMany({
      where: { sourceKey: { in: [...sourceKeys] } },
      include: { lines: { include: { account: { select: { name: true, currency: true } } } }, original: { select: { sourceKey: true } } },
    });
    return new Map(
      rows.map((row) => [
        row.sourceKey,
        {
          entryId: row.entryId,
          sourceKey: row.sourceKey,
          at: row.at,
          period: row.period,
          memo: row.memo,
          reversalOf: row.original?.sourceKey ?? null,
          meta: row.meta,
          createdBy: row.createdBy,
          // Дебет сверху, внутри — по счёту: порядок строк не зависит от того, как их отдала база.
          lines: row.lines
            .map((line) => ({ accountId: line.accountId, accountName: line.account.name, currency: line.account.currency, amount: line.amount }))
            .sort((a, b) => (a.amount === b.amount ? a.accountId.localeCompare(b.accountId) : a.amount > b.amount ? -1 : 1)),
        },
      ]),
    );
  }

  async loansOf(operationIds: readonly string[]): Promise<Map<string, StoredLoan>> {
    if (operationIds.length === 0) return new Map();
    const rows = await this.prisma.ledgerLoan.findMany({ where: { operationId: { in: [...operationIds] } } });
    return new Map(
      rows.map((row) => [
        row.operationId,
        {
          loanId: row.loanId,
          lender: row.lender,
          accountId: row.accountId,
          currency: row.currency,
          principal: row.principal,
          premium: row.premium,
          repaymentBp: row.repaymentBp,
          operationId: row.operationId,
        },
      ]),
    );
  }
}
