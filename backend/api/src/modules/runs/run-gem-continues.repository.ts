import { Inject, Injectable, Logger } from "@nestjs/common";
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
 * находит свою строку и не списывает ничего. Ключ списания занят, а строки
 * нет, — это не повтор, а расхождение журнала и таблицы (забеги почистили без
 * журнала): продолжение не выдаётся, как занятый номер, и пишется
 * предупреждение.
 *
 * Один номер продолжения двумя способами не берётся. Рекламная выдача и
 * покупка за самоцветы берут одну блокировку на аккаунт и смотрят в таблицу
 * друг друга внутри транзакции — между проверкой и записью номер не уйдёт.
 * Звёзды — отдельная таблица оплаты: их видит предварительная проверка
 * сервиса (`RunContinues.taken`).
 */

const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;

/**
 * Ключ списания занят при новой строке продолжения. Бросается внутри
 * транзакции, чтобы откатилась и строка; снаружи её ловит `buy` и отвечает
 * «занято».
 */
class GemContinueKeyConflict extends Error {
  constructor(readonly key: string) {
    super(`ключ списания ${key} занят, а строки продолжения нет`);
  }
}

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
 * рекламой или чужим аккаунтом, либо ключ списания занят без строки.
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
  private readonly logger = new Logger("runs");

  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async find(runId: string, continueNo: number): Promise<GemContinueRow | null> {
    return await this.prisma.runGemContinue.findUnique({ where: { runId_continueNo: { runId, continueNo } } });
  }

  async buy(purchase: GemContinuePurchase): Promise<GemBuyOutcome> {
    try {
      return await this.prisma.$transaction((tx) => this.buyWithin(tx, purchase), TX_OPTIONS);
    } catch (error: unknown) {
      if (!(error instanceof GemContinueKeyConflict)) throw error;
      // Строка откатилась вместе с транзакцией; игрок видит то же, что на занятый номер.
      const { runId, continueNo, accountId } = purchase;
      this.logger.warn(JSON.stringify({ module: "runs", event: "gem_continue_key_conflict", runId, continueNo, accountId }));
      return { status: "taken" };
    }
  }

  private async buyWithin(tx: Tx, purchase: GemContinuePurchase): Promise<GemBuyOutcome> {
    const { runId, continueNo, accountId } = purchase;
    await lockContinues(tx, accountId);

    const existing = await tx.runGemContinue.findUnique({ where: { runId_continueNo: { runId, continueNo } } });
    if (existing !== null) return existing.accountId === accountId ? { status: "repeat", row: existing } : { status: "taken" };
    const byAd = await tx.$queryRaw<{ one: number }[]>`SELECT 1 AS one FROM run_ad_continue WHERE run_id = ${runId} AND continue_no = ${continueNo}`;
    if (byAd.length > 0) return { status: "taken" };

    const row = await tx.runGemContinue.create({
      data: { runId, continueNo, accountId, elapsedSec: purchase.elapsedSec, priceGems: purchase.priceGems, grantedAt: purchase.at },
    });
    // Не хватило самоцветов — `InsufficientBalance`: транзакция откатывается вместе со строкой.
    const debited = await debitWithin(tx, {
      accountId,
      lines: [{ resource: "gems", amount: purchase.priceGems }],
      reason: "continue",
      // Колонка источника — 64 знака, а id забега до 64: хвост источнику не нужен.
      source: `run:${runId}`.slice(0, 64),
      idempotencyKey: `continue:${runId}:${String(continueNo)}`,
      at: purchase.at,
    });
    // Занятый ключ при новой строке: заплачено раньше, а строки не было. Выдать продолжение
    // без списания нельзя, а списывать второй раз нечем — отказ, и строка откатывается.
    if (debited.status === "duplicate") throw new GemContinueKeyConflict(debited.firstKey);
    return { status: "bought", row };
  }

  async forRun(runId: string): Promise<{ continueNo: number; elapsedSec: number }[]> {
    return await this.prisma.runGemContinue.findMany({ where: { runId }, select: { continueNo: true, elapsedSec: true }, orderBy: { continueNo: "asc" } });
  }
}
