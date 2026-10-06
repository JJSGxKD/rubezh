import type { PrismaClient } from "../../generated/prisma/client.js";
import { Prisma } from "../../generated/prisma/client.js";
import type { WalletResource } from "./wallet-types.js";

/**
 * Сверка балансов с журналом (docs/35-stage4-plan.md, WP3): баланс —
 * проекция журнала, и сумма строк обязана с ним совпасть. Расхождение значит
 * одно — кто-то писал баланс в обход журнала, — и искать его надо сразу, а
 * не когда игрок напишет «пропали монеты».
 *
 * Запрос читает весь журнал: он для команды и ночной проверки, а не для
 * запроса игрока. Когда журнал вырастет, сверка пойдёт по аккаунтам,
 * изменившимся за сутки (WP20).
 */

export interface WalletMismatch {
  accountId: string;
  resource: WalletResource;
  balance: number;
  ledger: number;
}

export async function walletMismatches(prisma: PrismaClient, accountId?: string, limit = 100): Promise<WalletMismatch[]> {
  const only = (column: string) => (accountId === undefined ? Prisma.empty : Prisma.sql`WHERE ${Prisma.raw(column)} = ${accountId}::uuid`);
  const rows = await prisma.$queryRaw<{ account_id: string; resource: WalletResource; balance: bigint; ledger: bigint }[]>`
    WITH ledger AS (
      SELECT account_id, resource, SUM(amount) AS total FROM wallet_entry ${only("account_id")} GROUP BY account_id, resource
    ), balance AS (
      SELECT account_id, resource, balance FROM wallet_balance ${only("account_id")}
    )
    SELECT COALESCE(b.account_id, l.account_id) AS account_id, COALESCE(b.resource, l.resource) AS resource,
           COALESCE(b.balance, 0)::bigint AS balance, COALESCE(l.total, 0)::bigint AS ledger
    FROM balance b FULL JOIN ledger l ON l.account_id = b.account_id AND l.resource = b.resource
    WHERE COALESCE(b.balance, 0) <> COALESCE(l.total, 0)
    LIMIT ${limit}
  `;
  return rows.map((row) => ({ accountId: row.account_id, resource: row.resource, balance: Number(row.balance), ledger: Number(row.ledger) }));
}
