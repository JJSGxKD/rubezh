import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { creditWithin, debitWithin, type LedgerLine } from "../wallet/wallet-ledger.js";
import type { BoostCurrency } from "./boost-catalog.js";

/**
 * Бусты, купленные на забег (docs/35-stage4-plan.md §3.5, Р39).
 *
 * Покупка — строка `run_boost` и списание из кошелька одной транзакцией:
 * заплатил — значит, бусты за забегом числятся, и наоборот. Строка на забег
 * одна, ключ списания — забег: повтор покупки после обрыва связи находит свою
 * строку и ничего не списывает.
 *
 * Возврат — только забегу, который так и не начался: бусты — расходник, и
 * за начатый забег они уже потрачены.
 */

const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;

export type BoostCost = Partial<Record<BoostCurrency, number>>;

export interface RunBoostRow {
  runId: string;
  accountId: string;
  boosts: string[];
  cost: BoostCost;
  createdAt: Date;
  refundedAt: Date | null;
}

export type ActivateOutcome =
  | { status: "created" | "duplicate"; row: RunBoostRow }
  /** забег чужой — его runId уже занят другим аккаунтом */
  | { status: "foreign" }
  /** забег уже начался — покупать на него поздно */
  | { status: "started" };

export type RefundOutcome = "refunded" | "missing" | "already" | "started";

export const BOOSTS_REPOSITORY = Symbol("BOOSTS_REPOSITORY");

export interface BoostsRepository {
  activate(input: { accountId: string; runId: string; boosts: readonly string[]; cost: BoostCost; at: Date }): Promise<ActivateOutcome>;
  refund(accountId: string, runId: string, at: Date): Promise<RefundOutcome>;
  byRun(runId: string): Promise<RunBoostRow | null>;
  /** невозвращённые покупки старше `before`, у которых забег так и не начался */
  abandoned(before: Date, limit: number): Promise<{ runId: string; accountId: string }[]>;
}

const costSchema = z.object({ coins: z.number().int().nonnegative().optional(), gems: z.number().int().nonnegative().optional() });

interface RawRow {
  run_id: string;
  account_id: string;
  boosts: string[];
  cost: unknown;
  created_at: Date;
  refunded_at: Date | null;
}

/** JSON из базы — через схему, а не приведением. */
function toRow(raw: RawRow): RunBoostRow {
  const parsed = costSchema.parse(raw.cost);
  const cost: BoostCost = {};
  if (parsed.coins !== undefined) cost.coins = parsed.coins;
  if (parsed.gems !== undefined) cost.gems = parsed.gems;
  return { runId: raw.run_id, accountId: raw.account_id, boosts: raw.boosts, cost, createdAt: raw.created_at, refundedAt: raw.refunded_at };
}

function linesOf(cost: BoostCost): LedgerLine[] {
  return (Object.entries(cost) as [BoostCurrency, number][]).filter(([, amount]) => amount > 0).map(([resource, amount]) => ({ resource, amount }));
}

@Injectable()
export class PrismaBoostsRepository implements BoostsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async activate(input: { accountId: string; runId: string; boosts: readonly string[]; cost: BoostCost; at: Date }): Promise<ActivateOutcome> {
    return await this.prisma.$transaction(async (tx) => {
      const started = await tx.$queryRaw<{ one: number }[]>`SELECT 1 AS one FROM run WHERE run_id = ${input.runId}`;
      if (started.length > 0) return { status: "started" };

      const inserted = await tx.$queryRaw<RawRow[]>`
        INSERT INTO run_boost (run_id, account_id, boosts, cost, created_at)
        VALUES (${input.runId}, ${input.accountId}::uuid, ${[...input.boosts]}::text[], ${JSON.stringify(input.cost)}::jsonb, ${input.at})
        ON CONFLICT (run_id) DO NOTHING
        RETURNING run_id, account_id, boosts, cost, created_at, refunded_at
      `;
      const created = inserted[0];
      if (created === undefined) {
        const [existing] = await tx.$queryRaw<RawRow[]>`
          SELECT run_id, account_id, boosts, cost, created_at, refunded_at FROM run_boost WHERE run_id = ${input.runId}
        `;
        if (existing === undefined || existing.account_id !== input.accountId) return { status: "foreign" };
        return { status: "duplicate", row: toRow(existing) };
      }

      const lines = linesOf(input.cost);
      if (lines.length > 0) {
        await debitWithin(tx, {
          accountId: input.accountId,
          lines,
          reason: "boost",
          source: `run:${input.runId}`,
          idempotencyKey: `boost:${input.runId}`,
          at: input.at,
        });
      }
      return { status: "created", row: toRow(created) };
    }, TX_OPTIONS);
  }

  async refund(accountId: string, runId: string, at: Date): Promise<RefundOutcome> {
    return await this.prisma.$transaction(async (tx) => {
      const [raw] = await tx.$queryRaw<RawRow[]>`
        SELECT run_id, account_id, boosts, cost, created_at, refunded_at FROM run_boost WHERE run_id = ${runId} FOR UPDATE
      `;
      if (raw === undefined || raw.account_id !== accountId) return "missing";
      if (raw.refunded_at !== null) return "already";
      const started = await tx.$queryRaw<{ one: number }[]>`SELECT 1 AS one FROM run WHERE run_id = ${runId}`;
      if (started.length > 0) return "started";

      for (const line of linesOf(toRow(raw).cost)) {
        await creditWithin(tx, {
          accountId,
          resource: line.resource,
          amount: line.amount,
          reason: "boost_refund",
          source: `run:${runId}`,
          idempotencyKey: `boost:${runId}:refund:${line.resource}`,
          at,
        });
      }
      await tx.$executeRaw`UPDATE run_boost SET refunded_at = ${at} WHERE run_id = ${runId}`;
      return "refunded";
    }, TX_OPTIONS);
  }

  async byRun(runId: string): Promise<RunBoostRow | null> {
    const [raw] = await this.prisma.$queryRaw<RawRow[]>`
      SELECT run_id, account_id, boosts, cost, created_at, refunded_at FROM run_boost WHERE run_id = ${runId}
    `;
    return raw === undefined ? null : toRow(raw);
  }

  async abandoned(before: Date, limit: number): Promise<{ runId: string; accountId: string }[]> {
    const rows = await this.prisma.$queryRaw<{ run_id: string; account_id: string }[]>`
      SELECT b.run_id, b.account_id FROM run_boost b
      WHERE b.refunded_at IS NULL AND b.created_at < ${before}
        AND NOT EXISTS (SELECT 1 FROM run r WHERE r.run_id = b.run_id)
      ORDER BY b.created_at
      LIMIT ${limit}
    `;
    return rows.map((row) => ({ runId: row.run_id, accountId: row.account_id }));
  }
}
