import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { AccountType, EntryLine } from "@bh/ledger";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { JournalCursor } from "./ledger-cursor.js";
import type { JournalFilterInput, LedgerMeta } from "./ledger-view.js";

export type { JournalCursor } from "./ledger-cursor.js";
export type JournalFilter = JournalFilterInput;

/**
 * Журнал учёта в базе (`ledger_account`, `ledger_entry`, `ledger_line`; docs/37-accounting.md, Р219,
 * tasks/T-0457). Проводки только добавляются: UPDATE и DELETE у таблиц журнала запрещает триггер миграции,
 * поэтому у репозитория нет ни правки, ни удаления.
 */

export interface StoredLedgerAccount {
  accountId: string;
  type: AccountType;
  currency: string;
  name: string;
  archivedAt: Date | null;
}

export type StoredLedgerLine = EntryLine;

export interface StoredLedgerEntry {
  entryId: string;
  sourceKey: string;
  at: Date;
  period: string;
  memo: string;
  /** ключ источника исходной проводки, если эта — сторно */
  reversalOf: string | null;
  /** JSON из базы: форму разбирает сервис, репозиторий ей не доверяет */
  meta: unknown;
  createdBy: string | null;
  createdAt: Date;
  lines: StoredLedgerLine[];
}

export interface NewLedgerEntry {
  entryId: string;
  sourceKey: string;
  at: Date;
  /** «ГГГГ-ММ» по UTC */
  period: string;
  memo: string;
  /** `entry_id` исходной проводки, если эта — сторно */
  reversalOfId: string | null;
  meta: LedgerMeta | null;
  createdBy: string | null;
}

/**
 * Что вышло со вставкой: записана; ключ источника уже занят (другой писатель успел раньше или это повтор);
 * исходная проводка уже сторнирована под другим ключом.
 */
export type InsertResult = "inserted" | "source_taken" | "already_reversed";

export const LEDGER_REPOSITORY = Symbol("LEDGER_REPOSITORY");

export interface LedgerRepository {
  /** Весь план счетов: типы по порядку объявления, внутри — по времени заведения. */
  accounts(): Promise<StoredLedgerAccount[]>;
  entryBySource(sourceKey: string): Promise<StoredLedgerEntry | null>;
  /** Проводка и её строки — одной транзакцией. */
  insertEntry(entry: NewLedgerEntry, lines: readonly StoredLedgerLine[]): Promise<InsertResult>;
  /** Сумма строк по счетам — одним запросом; счёта без строк в карте нет. */
  balances(): Promise<Map<string, bigint>>;
  /** Проводки новые сверху, строго после курсора `(at, entry_id)`; со строками. */
  journal(filter: JournalFilter, cursor: JournalCursor | null, limit: number): Promise<StoredLedgerEntry[]>;
}

/** Нарушение уникальности — код Prisma; внешний ключ и прочее — настоящая ошибка и идёт наверх. */
const UNIQUE_VIOLATION = "P2002";

type EntryRow = Prisma.LedgerEntryGetPayload<{ include: { lines: true; original: { select: { sourceKey: true } } } }>;

const WITH_LINES = { lines: true, original: { select: { sourceKey: true } } } satisfies Prisma.LedgerEntryInclude;

function toStored(row: EntryRow): StoredLedgerEntry {
  return {
    entryId: row.entryId,
    sourceKey: row.sourceKey,
    at: row.at,
    period: row.period,
    memo: row.memo,
    reversalOf: row.original?.sourceKey ?? null,
    meta: row.meta,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    // Дебет сверху, внутри — по счёту: порядок строк в ответе не зависит от того, как их отдала база.
    lines: row.lines
      .map((line) => ({ accountId: line.accountId, amount: line.amount }))
      .sort((a, b) => (a.amount === b.amount ? a.accountId.localeCompare(b.accountId) : a.amount > b.amount ? -1 : 1)),
  };
}

/**
 * Prisma строит `startsWith` как `LIKE 'текст%'` и подстановочные знаки внутри текста не экранирует: префикс
 * «purchase_» нашёл бы и «purchaseX». Ключи источника с «_» бывают, поэтому знаки шаблона экранируются
 * обратной косой — экранирующий знак `LIKE` по умолчанию.
 */
function escapeLike(prefix: string): string {
  return prefix.replace(/[\\%_]/gu, "\\$&");
}

@Injectable()
export class PrismaLedgerRepository implements LedgerRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async accounts(): Promise<StoredLedgerAccount[]> {
    const rows = await this.prisma.ledgerAccount.findMany({ orderBy: [{ type: "asc" }, { createdAt: "asc" }, { accountId: "asc" }] });
    return rows.map((row) => ({ accountId: row.accountId, type: row.type, currency: row.currency, name: row.name, archivedAt: row.archivedAt }));
  }

  async entryBySource(sourceKey: string): Promise<StoredLedgerEntry | null> {
    const row = await this.prisma.ledgerEntry.findUnique({ where: { sourceKey }, include: WITH_LINES });
    return row === null ? null : toStored(row);
  }

  async insertEntry(entry: NewLedgerEntry, lines: readonly StoredLedgerLine[]): Promise<InsertResult> {
    try {
      // Вложенное создание — одна транзакция: проводка без строк в журнал не попадёт.
      await this.prisma.ledgerEntry.create({
        data: {
          entryId: entry.entryId,
          sourceKey: entry.sourceKey,
          at: entry.at,
          period: entry.period,
          memo: entry.memo,
          reversalOf: entry.reversalOfId,
          ...(entry.meta === null ? {} : { meta: entry.meta }),
          createdBy: entry.createdBy,
          lines: { create: lines.map((line) => ({ lineId: randomUUID(), accountId: line.accountId, amount: line.amount })) },
        },
      });
      return "inserted";
    } catch (error: unknown) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== UNIQUE_VIOLATION) throw error;
      // Какой из двух уникальных ключей сработал, по тексту ошибки не гадаем: смотрим, занят ли ключ источника.
      const taken = await this.prisma.ledgerEntry.findUnique({ where: { sourceKey: entry.sourceKey }, select: { entryId: true } });
      return taken === null ? "already_reversed" : "source_taken";
    }
  }

  async balances(): Promise<Map<string, bigint>> {
    const rows = await this.prisma.ledgerLine.groupBy({ by: ["accountId"], _sum: { amount: true } });
    return new Map(rows.map((row) => [row.accountId, row._sum.amount ?? 0n]));
  }

  async journal(filter: JournalFilter, cursor: JournalCursor | null, limit: number): Promise<StoredLedgerEntry[]> {
    const conditions: Prisma.LedgerEntryWhereInput[] = [];
    if (filter.accountId !== undefined) conditions.push({ lines: { some: { accountId: filter.accountId } } });
    if (filter.currency !== undefined) conditions.push({ lines: { some: { account: { currency: filter.currency } } } });
    // «ГГГГ-ММ» сравнивается как строка: формат с ведущими нулями сортируется так же, как даты.
    if (filter.from !== undefined) conditions.push({ period: { gte: filter.from } });
    if (filter.to !== undefined) conditions.push({ period: { lte: filter.to } });
    if (filter.sourcePrefix !== undefined) conditions.push({ sourceKey: { startsWith: escapeLike(filter.sourcePrefix) } });
    if (cursor !== null) conditions.push({ OR: [{ at: { lt: cursor.at } }, { at: cursor.at, entryId: { lt: cursor.entryId } }] });

    const rows = await this.prisma.ledgerEntry.findMany({
      where: { AND: conditions },
      orderBy: [{ at: "desc" }, { entryId: "desc" }],
      take: limit,
      include: WITH_LINES,
    });
    return rows.map(toStored);
  }
}
