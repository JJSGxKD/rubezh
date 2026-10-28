import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { debitWithin, type Tx } from "../wallet/wallet-ledger.js";

/**
 * Второй шанс за самоцветы в базе (docs/35-stage4-plan.md Р162, tasks/T-0324).
 *
 * Покупка — строка `run_gem_continue` и списание самоцветов одной
 * транзакцией: заплатил — значит, продолжение записано, и наоборот. Не
 * хватило самоцветов — откатывается и строка. Ключ строки `(run_id,
 * continue_no)` и ключ списания `continue:<run_id>:<continue_no>` не дают
 * ни записать, ни списать дважды: повтор запроса, в том числе параллельный,
 * находит свою строку и не списывает ничего.
 *
 * Один номер продолжения двумя способами не берётся. Рекламная выдача и
 * покупка за самоцветы берут одну блокировку на аккаунт и смотрят в таблицу
 * друг друга внутри транзакции — между проверкой и записью номер не уйдёт.
 * Звёзды — отдельная таблица оплаты: их видит предварительная проверка
 * сервиса (`RunContinues.taken`).
 */

const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;

export interface GemContinueRow {
  runId: string;
  continueNo: number;
  accountId: string;
  /** секунда забега, по которой посчитана цена */
  elapsedSec: number;
  priceGems: number;
  grantedAt: Date;
}

export interface GemContinuePurchase {
  runId: string;
  continueNo: number;
  accountId: string;
  elapsedSec: number;
  priceGems: number;
  at: Date;
}

/**
 * `bought` — записано и списано; `repeat` — этот аккаунт уже купил это
 * продолжение, ответ дожимается прежней строкой; `taken` — номер уже выдан
 * рекламой.
 */
export type GemBuyOutcome = { status: "bought" | "repeat"; row: GemContinueRow } | { status: "taken" };

export const RUN_GEM_CONTINUES_REPOSITORY = Symbol("RUN_GEM_CONTINUES_REPOSITORY");

export interface RunGemContinuesRepository {
  /** строка продолжения; `null` — за самоцветы оно не куплено */
  find(runId: string, continueNo: number): Promise<GemContinueRow | null>;
  /** Покупка одной транзакцией; не хватило самоцветов — бросает `InsufficientBalance`, ничего не записано. */
  buy(purchase: GemContinuePurchase): Promise<GemBuyOutcome>;
  /** продолжения забега, купленные за самоцветы, с секундой, по которой посчитана цена */
  forRun(runId: string): Promise<{ continueNo: number; elapsedSec: number }[]>;
}

/**
 * Блокировка продолжений аккаунта до конца транзакции. Под ней рекламная
 * выдача считает суточный потолок и проверяет номер, а покупка за самоцветы
 * проверяет номер: две параллельные операции одного игрока идут по очереди.
 */
export async function lockContinues(tx: Tx, accountId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`run-continue:${accountId}`}))`;
}

@Injectable()
export class PrismaRunGemContinuesRepository implements RunGemContinuesRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async find(runId: string, continueNo: number): Promise<GemContinueRow | null> {
    return await this.prisma.runGemContinue.findUnique({ where: { runId_continueNo: { runId, continueNo } } });
  }

  async buy(purchase: GemContinuePurchase): Promise<GemBuyOutcome> {
    const { runId, continueNo, accountId } = purchase;
    return await this.prisma.$transaction(async (tx): Promise<GemBuyOutcome> => {
      await lockContinues(tx, accountId);

      const existing = await tx.runGemContinue.findUnique({ where: { runId_continueNo: { runId, continueNo } } });
      if (existing !== null) return existing.accountId === accountId ? { status: "repeat", row: existing } : { status: "taken" };
      const byAd = await tx.$queryRaw<{ one: number }[]>`SELECT 1 AS one FROM run_ad_continue WHERE run_id = ${runId} AND continue_no = ${continueNo}`;
      if (byAd.length > 0) return { status: "taken" };

      const row = await tx.runGemContinue.create({
        data: { runId, continueNo, accountId, elapsedSec: purchase.elapsedSec, priceGems: purchase.priceGems, grantedAt: purchase.at },
      });
      // Не хватило самоцветов — `InsufficientBalance`: транзакция откатывается вместе со
      // строкой. Занятый ключ списания при новой строке значит, что заплачено раньше, а
      // строки не было: второй раз не списываем, продолжение выдаётся (`duplicate`).
      await debitWithin(tx, {
        accountId,
        lines: [{ resource: "gems", amount: purchase.priceGems }],
        reason: "continue",
        // Колонка источника — 64 знака, а id забега до 64: хвост источнику не нужен.
        source: `run:${runId}`.slice(0, 64),
        idempotencyKey: `continue:${runId}:${String(continueNo)}`,
        at: purchase.at,
      });
      return { status: "bought", row };
    }, TX_OPTIONS);
  }

  async forRun(runId: string): Promise<{ continueNo: number; elapsedSec: number }[]> {
    return await this.prisma.runGemContinue.findMany({ where: { runId }, select: { continueNo: true, elapsedSec: true }, orderBy: { continueNo: "asc" } });
  }
}
