import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { Prisma } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { debitWithin, InsufficientBalance, type Tx } from "./wallet-ledger.js";
import { emptyBalances, type ADMIN_REASON, type Balances, type GrantReason, type SpendReason, type WalletResource } from "./wallet-types.js";

/**
 * Журнал и балансы кошелька (docs/35-stage4-plan.md, Р12, §3.2).
 *
 * Каждая операция — одна транзакция: строка журнала с уникальным ключом
 * идемпотентности и, только если она вставилась, изменение баланса. Повтор с
 * тем же ключом упирается в индекс, а не в проверку в коде, — сто
 * параллельных одинаковых начислений дают одно. Списание проверяет остаток
 * условием в самом `UPDATE`, а база ещё и не даёт балансу уйти в минус
 * (`CHECK` в миграции).
 *
 * Внутри транзакции нет ничего, кроме SQL: сетевой вызов наружу держал бы
 * блокировку строки баланса, пока ждёт ответа.
 */

/** Интерактивная транзакция: сколько ждать соединения и сколько жить. */
const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;

export interface CreditInput {
  accountId: string;
  resource: WalletResource;
  amount: number;
  reason: GrantReason;
  /** на что ссылается начисление: забег, задание, покупка */
  source: string | null;
  idempotencyKey: string;
  /** суточный потолок источника; `null` — без потолка */
  dailyCap: number | null;
  at: Date;
}

export type CreditOutcome =
  /** `credited` меньше запрошенного — упёрлись в потолок; 0 — потолок уже выбран */
  | { status: "credited"; credited: number; balance: number }
  /** операция с этим ключом уже была — ничего не изменилось */
  | { status: "duplicate"; existing: ExistingEntry; balance: number };

export interface DebitLine {
  resource: WalletResource;
  amount: number;
}

export interface DebitInput {
  accountId: string;
  /** одна операция может тратить несколько ресурсов: улучшение — осколки и монеты */
  lines: readonly DebitLine[];
  reason: SpendReason | typeof ADMIN_REASON;
  source: string | null;
  idempotencyKey: string;
  at: Date;
}

export type DebitOutcome =
  | { status: "debited"; balances: Partial<Balances> }
  | { status: "duplicate"; existing: ExistingEntry }
  /** не хватило — ничего не списано, ни по одной строке */
  | { status: "insufficient"; resource: WalletResource; needed: number; balance: number };

export interface ExistingEntry {
  accountId: string;
  resource: WalletResource;
  reason: string;
  amount: number;
}

export interface WalletEntryRow {
  entryId: string;
  resource: WalletResource;
  amount: number;
  reason: string;
  source: string | null;
  createdAt: Date;
}

export const WALLET_REPOSITORY = Symbol("WALLET_REPOSITORY");

export interface WalletRepository {
  credit(input: CreditInput): Promise<CreditOutcome>;
  debit(input: DebitInput): Promise<DebitOutcome>;
  balances(accountId: string): Promise<Balances>;
  /** последние строки журнала, новые первыми */
  recentEntries(accountId: string, limit: number): Promise<WalletEntryRow[]>;
}

/** Ключ строки списания: у каждого ресурса своя строка журнала, а ключ уникален. */
export { debitLineKey } from "./wallet-ledger.js";

@Injectable()
export class PrismaWalletRepository implements WalletRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async credit(input: CreditInput): Promise<CreditOutcome> {
    return await this.prisma.$transaction(async (tx) => {
      // Сначала ключ, потом потолок. Повторы ждут на уникальном индексе
      // только того, кто занял ключ, и расходятся разом, не трогая строку
      // суток; в обратном порядке сотня повторов выстроилась бы в очередь за
      // её блокировкой — каждый, хотя начислять им нечего.
      const [claimed] = await tx.$queryRaw<{ entry_id: string }[]>`
        INSERT INTO wallet_entry (entry_id, account_id, resource, amount, reason, source, idempotency_key, created_at)
        VALUES (${randomUUID()}::uuid, ${input.accountId}::uuid, ${input.resource}::"WalletResource", ${BigInt(input.amount)},
                ${input.reason}, ${input.source}, ${input.idempotencyKey}, ${input.at})
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING entry_id
      `;
      if (claimed === undefined) {
        const existing = await this.existing(tx, input.idempotencyKey);
        return { status: "duplicate", existing, balance: await this.balanceOf(tx, existing.accountId, existing.resource) };
      }

      const allowed = input.dailyCap === null ? input.amount : Math.min(input.amount, await this.capRoom(tx, input, input.dailyCap));
      // Строка остаётся и тогда, когда потолок выбран (сумма 0): ключ занят, и
      // повтор завтра, когда потолок обнулится, не начислит задним числом.
      if (allowed < input.amount) {
        await tx.$executeRaw`UPDATE wallet_entry SET amount = ${BigInt(allowed)} WHERE entry_id = ${claimed.entry_id}::uuid`;
      }
      if (allowed === 0) return { status: "credited", credited: 0, balance: await this.balanceOf(tx, input.accountId, input.resource) };

      if (input.dailyCap !== null) {
        await tx.$executeRaw`
          UPDATE wallet_daily SET granted = granted + ${BigInt(allowed)}
          WHERE account_id = ${input.accountId}::uuid AND resource = ${input.resource}::"WalletResource"
            AND reason = ${input.reason} AND day = ${gameDay(input.at)}
        `;
      }
      const [row] = await tx.$queryRaw<{ balance: bigint }[]>`
        INSERT INTO wallet_balance (account_id, resource, balance, updated_at)
        VALUES (${input.accountId}::uuid, ${input.resource}::"WalletResource", ${BigInt(allowed)}, ${input.at})
        ON CONFLICT (account_id, resource) DO UPDATE SET
          balance = wallet_balance.balance + EXCLUDED.balance,
          updated_at = EXCLUDED.updated_at
        RETURNING balance
      `;
      return { status: "credited", credited: allowed, balance: Number(row?.balance ?? 0n) };
    }, TX_OPTIONS);
  }

  async debit(input: DebitInput): Promise<DebitOutcome> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const outcome = await debitWithin(tx, input);
        if (outcome.status === "duplicate") return { status: "duplicate", existing: await this.existing(tx, outcome.firstKey) };
        return outcome;
      }, TX_OPTIONS);
    } catch (error: unknown) {
      if (!(error instanceof InsufficientBalance)) throw error;
      const balance = (await this.balances(input.accountId))[error.resource];
      return { status: "insufficient", resource: error.resource, needed: error.needed, balance };
    }
  }

  async balances(accountId: string): Promise<Balances> {
    const rows = await this.prisma.walletBalance.findMany({ where: { accountId }, select: { resource: true, balance: true } });
    const result = emptyBalances();
    for (const row of rows) result[row.resource] = Number(row.balance);
    return result;
  }

  async recentEntries(accountId: string, limit: number): Promise<WalletEntryRow[]> {
    const rows = await this.prisma.walletEntry.findMany({
      where: { accountId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { entryId: true, resource: true, amount: true, reason: true, source: true, createdAt: true },
    });
    return rows.map((row) => ({ ...row, amount: Number(row.amount) }));
  }

  /**
   * Сколько ещё можно начислить из источника сегодня. Строка суток
   * блокируется до конца транзакции: параллельные начисления из одного
   * источника встают в очередь и видят уже увеличенный счётчик, а не
   * прочитанный до соседа.
   */
  private async capRoom(tx: Tx, input: CreditInput, cap: number): Promise<number> {
    const day = gameDay(input.at);
    await tx.$executeRaw`
      INSERT INTO wallet_daily (account_id, resource, reason, day)
      VALUES (${input.accountId}::uuid, ${input.resource}::"WalletResource", ${input.reason}, ${day})
      ON CONFLICT DO NOTHING
    `;
    const [row] = await tx.$queryRaw<{ granted: bigint }[]>`
      SELECT granted FROM wallet_daily
      WHERE account_id = ${input.accountId}::uuid AND resource = ${input.resource}::"WalletResource"
        AND reason = ${input.reason} AND day = ${day}
      FOR UPDATE
    `;
    return Math.max(0, cap - Number(row?.granted ?? 0n));
  }

  private async existing(tx: Tx, idempotencyKey: string): Promise<ExistingEntry> {
    const entry = await tx.walletEntry.findUniqueOrThrow({
      where: { idempotencyKey },
      select: { accountId: true, resource: true, reason: true, amount: true },
    });
    return { ...entry, amount: Number(entry.amount) };
  }

  private async balanceOf(tx: Tx, accountId: string, resource: WalletResource): Promise<number> {
    const row = await tx.walletBalance.findUnique({ where: { accountId_resource: { accountId, resource } }, select: { balance: true } });
    return Number(row?.balance ?? 0n);
  }
}

/** Игровые сутки момента — выражением базы, чтобы граница была одна у всех реплик. */
function gameDay(at: Date): Prisma.Sql {
  return Prisma.sql`(${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date`;
}
