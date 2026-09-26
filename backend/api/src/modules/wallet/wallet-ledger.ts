import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { ADMIN_REASON, Balances, ExchangeReason, SpendReason, WalletResource } from "./wallet-types.js";

/**
 * Журнал кошелька внутри чужой транзакции (docs/35-stage4-plan.md, §3.2).
 *
 * Трата монет и осколков на предмет и изменение самого предмета — одна
 * операция: списали, а предмет не улучшился, — значит, игрок заплатил зря.
 * Поэтому модуль предметов открывает транзакцию сам и зовёт отсюда списание
 * и начисление — тем же SQL, что и кошелёк, а не своим.
 */

export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

export interface LedgerLine {
  resource: WalletResource;
  amount: number;
}

export interface LedgerDebit {
  accountId: string;
  /** одна операция может тратить несколько ресурсов: улучшение — осколки и монеты */
  lines: readonly LedgerLine[];
  reason: SpendReason | typeof ADMIN_REASON;
  source: string | null;
  idempotencyKey: string;
  at: Date;
}

export interface LedgerCredit {
  accountId: string;
  resource: WalletResource;
  amount: number;
  /**
   * Только обмен: ценность пришла из уже полученного, и суточный потолок ей
   * не нужен. Начисления «из ничего» идут через кошелёк с потолком.
   */
  reason: ExchangeReason;
  source: string | null;
  idempotencyKey: string;
  at: Date;
}

/**
 * Не хватило ресурса. Бросается изнутри транзакции, чтобы она откатилась
 * целиком — вместе со строками, уже списанными до этой.
 */
export class InsufficientBalance extends Error {
  constructor(
    readonly resource: WalletResource,
    readonly needed: number,
  ) {
    super("insufficient");
  }
}

export function debitLineKey(idempotencyKey: string, resource: WalletResource): string {
  return `${idempotencyKey}:${resource}`;
}

/**
 * Списать строки. `duplicate` — операция с этим ключом уже прошла целиком:
 * строки одной операции пишутся одной транзакцией, и занятый ключ первой
 * значит, что заняты все.
 *
 * Строки баланса блокируются в одном порядке у всех: две параллельные траты
 * одного игрока иначе могли бы взять их крест-накрест.
 */
export async function debitWithin(
  tx: Tx,
  input: LedgerDebit,
): Promise<{ status: "debited"; balances: Partial<Balances> } | { status: "duplicate"; firstKey: string }> {
  const lines = [...input.lines].sort((a, b) => a.resource.localeCompare(b.resource));
  const balances: Partial<Balances> = {};
  for (const [index, line] of lines.entries()) {
    const key = debitLineKey(input.idempotencyKey, line.resource);
    const inserted = await tx.$queryRaw<{ entry_id: string }[]>`
      INSERT INTO wallet_entry (entry_id, account_id, resource, amount, reason, source, idempotency_key, created_at)
      VALUES (${randomUUID()}::uuid, ${input.accountId}::uuid, ${line.resource}::"WalletResource", ${BigInt(-line.amount)},
              ${input.reason}, ${input.source}, ${key}, ${input.at})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING entry_id
    `;
    if (inserted.length === 0) {
      if (index === 0) return { status: "duplicate", firstKey: key };
      throw new Error(`ключ ${key} занят другой операцией`);
    }

    const [row] = await tx.$queryRaw<{ balance: bigint }[]>`
      UPDATE wallet_balance SET balance = balance - ${BigInt(line.amount)}, updated_at = ${input.at}
      WHERE account_id = ${input.accountId}::uuid AND resource = ${line.resource}::"WalletResource"
        AND balance >= ${BigInt(line.amount)}
      RETURNING balance
    `;
    if (row === undefined) throw new InsufficientBalance(line.resource, line.amount);
    balances[line.resource] = Number(row.balance);
  }
  return { status: "debited", balances };
}

/** Начислить обмен. `duplicate` — начисление с этим ключом уже было. */
export async function creditWithin(tx: Tx, input: LedgerCredit): Promise<{ status: "credited"; balance: number } | { status: "duplicate" }> {
  const [claimed] = await tx.$queryRaw<{ entry_id: string }[]>`
    INSERT INTO wallet_entry (entry_id, account_id, resource, amount, reason, source, idempotency_key, created_at)
    VALUES (${randomUUID()}::uuid, ${input.accountId}::uuid, ${input.resource}::"WalletResource", ${BigInt(input.amount)},
            ${input.reason}, ${input.source}, ${input.idempotencyKey}, ${input.at})
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING entry_id
  `;
  if (claimed === undefined) return { status: "duplicate" };

  const [row] = await tx.$queryRaw<{ balance: bigint }[]>`
    INSERT INTO wallet_balance (account_id, resource, balance, updated_at)
    VALUES (${input.accountId}::uuid, ${input.resource}::"WalletResource", ${BigInt(input.amount)}, ${input.at})
    ON CONFLICT (account_id, resource) DO UPDATE SET
      balance = wallet_balance.balance + EXCLUDED.balance,
      updated_at = EXCLUDED.updated_at
    RETURNING balance
  `;
  return { status: "credited", balance: Number(row?.balance ?? 0n) };
}
