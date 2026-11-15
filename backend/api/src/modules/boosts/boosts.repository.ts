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
 *
 * **Подарки пасса** (tasks/T-0312, `boost_credit`). Включение буста сначала берёт
 * подарок этого буста — `count − 1` условным `UPDATE … WHERE count > 0`, — и только
 * недостающее оплачивается из кошелька. Подарки, строка забега и списание — одна
 * транзакция: не хватило денег на остаток набора — откатывается и подарок. Два забега
 * разом за последний подарок расходятся на блокировке строки: второй видит ноль и платит.
 * Чем оплачен каждый буст, записано в стоимости забега (`paid_with`): возврат
 * несостоявшемуся забегу отдаёт подарок подарком, а деньги — деньгами. Подарки берутся и
 * возвращаются в порядке id и раньше кошелька — тот же порядок блокировок у активации и
 * возврата, взаимной блокировки двух забегов одного игрока нет.
 */

const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;

export type BoostCost = Partial<Record<BoostCurrency, number>>;

/** Чем оплачен буст: подарком пасса или ресурсом кошелька. */
export type PaidWith = "credit" | BoostCurrency;

/** Буст набора с ценой каталога. */
export interface BoostLine {
  boostId: string;
  resource: BoostCurrency;
  amount: number;
}

export interface RunBoostRow {
  runId: string;
  accountId: string;
  boosts: string[];
  /** сколько списано из кошелька: подарочные бусты в стоимость не входят */
  cost: BoostCost;
  /** чем оплачен каждый буст; у покупок до подарков пусто — они оплачены деньгами из `cost` */
  paidWith: Record<string, PaidWith>;
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
  /** `lines` — бусты набора с ценами каталога: что из них оплатят подарки, решает транзакция. */
  activate(input: { accountId: string; runId: string; boosts: readonly string[]; lines: readonly BoostLine[]; at: Date }): Promise<ActivateOutcome>;
  refund(accountId: string, runId: string, at: Date): Promise<RefundOutcome>;
  byRun(runId: string): Promise<RunBoostRow | null>;
  /** невозвращённые покупки старше `before`, у которых забег так и не начался */
  abandoned(before: Date, limit: number): Promise<{ runId: string; accountId: string }[]>;
}

const costSchema = z.object({
  coins: z.number().int().nonnegative().optional(),
  gems: z.number().int().nonnegative().optional(),
  paid_with: z.record(z.string(), z.enum(["credit", "coins", "gems"])).optional(),
});

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
  return { runId: raw.run_id, accountId: raw.account_id, boosts: raw.boosts, cost, paidWith: parsed.paid_with ?? {}, createdAt: raw.created_at, refundedAt: raw.refunded_at };
}

function linesOf(cost: BoostCost): LedgerLine[] {
  return (Object.entries(cost) as [BoostCurrency, number][]).filter(([, amount]) => amount > 0).map(([resource, amount]) => ({ resource, amount }));
}

/** Подарочные бусты строки, по порядку id: одинаковый порядок блокировок у всех транзакций игрока. */
function creditedIds(row: RunBoostRow): string[] {
  return Object.entries(row.paidWith)
    .filter(([, how]) => how === "credit")
    .map(([boostId]) => boostId)
    .sort();
}

@Injectable()
export class PrismaBoostsRepository implements BoostsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async activate(input: { accountId: string; runId: string; boosts: readonly string[]; lines: readonly BoostLine[]; at: Date }): Promise<ActivateOutcome> {
    return await this.prisma.$transaction(async (tx) => {
      const started = await tx.$queryRaw<{ one: number }[]>`SELECT 1 AS one FROM run WHERE run_id = ${input.runId}`;
      if (started.length > 0) return { status: "started" };

      // Строка забега — первой и с пустой стоимостью: она же замок повтора. Повторный запрос
      // того же забега упирается здесь и не доходит ни до подарков, ни до кошелька.
      const inserted = await tx.$queryRaw<RawRow[]>`
        INSERT INTO run_boost (run_id, account_id, boosts, cost, created_at)
        VALUES (${input.runId}, ${input.accountId}::uuid, ${[...input.boosts]}::text[], '{}'::jsonb, ${input.at})
        ON CONFLICT (run_id) DO NOTHING
        RETURNING run_id, account_id, boosts, cost, created_at, refunded_at
      `;
      if (inserted[0] === undefined) {
        const [existing] = await tx.$queryRaw<RawRow[]>`
          SELECT run_id, account_id, boosts, cost, created_at, refunded_at FROM run_boost WHERE run_id = ${input.runId}
        `;
        if (existing === undefined || existing.account_id !== input.accountId) return { status: "foreign" };
        return { status: "duplicate", row: toRow(existing) };
      }

      // Подарок есть — буст бесплатный, иначе платим; ноль строк обновления значит «подарка нет или он кончился».
      const paidWith: Record<string, PaidWith> = {};
      const cost: BoostCost = {};
      for (const line of [...input.lines].sort((a, b) => (a.boostId < b.boostId ? -1 : 1))) {
        const taken = await tx.$executeRaw`
          UPDATE boost_credit SET count = count - 1
          WHERE account_id = ${input.accountId}::uuid AND boost_id = ${line.boostId} AND count > 0
        `;
        if (taken > 0) {
          paidWith[line.boostId] = "credit";
        } else {
          paidWith[line.boostId] = line.resource;
          cost[line.resource] = (cost[line.resource] ?? 0) + line.amount;
        }
      }

      const [created] = await tx.$queryRaw<RawRow[]>`
        UPDATE run_boost SET cost = ${JSON.stringify({ ...cost, paid_with: paidWith })}::jsonb
        WHERE run_id = ${input.runId}
        RETURNING run_id, account_id, boosts, cost, created_at, refunded_at
      `;
      if (created === undefined) throw new Error("строка забега с бустами пропала внутри транзакции");

      const lines = linesOf(cost);
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

      const row = toRow(raw);
      // Подарки назад подарками и раньше денег — в том же порядке блокировок, что при включении.
      for (const boostId of creditedIds(row)) {
        await tx.$executeRaw`
          INSERT INTO boost_credit (account_id, boost_id, count) VALUES (${accountId}::uuid, ${boostId}, 1)
          ON CONFLICT (account_id, boost_id) DO UPDATE SET count = boost_credit.count + 1
        `;
      }
      for (const line of linesOf(row.cost)) {
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
