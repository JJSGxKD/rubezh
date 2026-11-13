import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { DISCREPANCY_KINDS, type DiscrepancyKind, type FoundDiscrepancy, type KnownPurchase, type ReconcileTrigger } from "./payment-reconcile.js";

/**
 * Хранилище сверки оплат в Postgres (Р209, WP53, tasks/T-0433): строки
 * сверок, расхождения и чтение покупок для сравнения. Запрос к базе живёт
 * здесь, а не в сервисе (docs/15-engineering-standards.md §2.3).
 *
 * Внешних ключей у таблиц нет: покупки у «списано, но не записано» может не
 * быть, а аккаунт нужен только для показа. Площадка покупки — площадка её
 * аккаунта: у строки покупки своей площадки нет.
 *
 * Виды, решения и площадки в строках — текст: разбор схемой делает сервис, а
 * незнакомое значение (запись более новой версии) пропускается, а не роняет
 * обзор.
 */

export const PAYMENT_RECONCILE_REPOSITORY = Symbol("PAYMENT_RECONCILE_REPOSITORY");

/** Сколько значений кладётся в один `IN (…)` и сколько строк в один `INSERT`: пределы параметров запроса. */
const CHUNK = 1000;
const INSERT_CHUNK = 500;
/** Закрытые расхождения в обзоре: за 30 суток, не больше сотни — остальное ушло в историю. */
const RESOLVED_DAYS = 30;
const RESOLVED_LIMIT = 100;
const DAY_MS = 24 * 3_600_000;

/** Последняя удачная сверка площадки: курсор и время, от которого считается срок следующей. */
export interface LastFinished {
  toOffset: number;
  finishedAt: Date;
}

export interface StartedRun {
  runId: string;
  platform: PlatformId;
  trigger: ReconcileTrigger;
  actorAccountId: string | null;
  startedAt: Date;
  fromOffset: number;
}

export interface FinishedRun {
  finishedAt: Date;
  /** `null` — сверка оборвалась ошибкой: курсор не двигается */
  toOffset: number | null;
  coveredFrom: Date | null;
  coveredTo: Date | null;
  scanned: number;
  found: number;
  matched: number;
  error: string | null;
}

/** Сколько вставлено новых расхождений и какие они; повторные находки не в счёт. */
export interface InsertedFound {
  inserted: number;
  items: { kind: DiscrepancyKind; chargeId: string; purchaseId: string | null }[];
}

export interface PurchaseRef {
  purchaseId: string;
  accountId: string;
}

/** Открытое расхождение — столько нужно, чтобы понять, не сошлось ли оно само. */
export interface OpenDiscrepancy {
  discrepancyId: string;
  kind: string;
  chargeId: string;
}

export interface DiscrepancyRow {
  discrepancyId: string;
  platform: string;
  kind: string;
  chargeId: string;
  purchaseId: string | null;
  accountId: string | null;
  payerId: string | null;
  amount: number;
  payload: string | null;
  occurredAt: Date;
  detectedAt: Date;
  resolution: string | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  note: string | null;
}

export interface RunRow {
  platform: string;
  trigger: string;
  startedAt: Date;
  finishedAt: Date | null;
  scanned: number;
  found: number;
  error: string | null;
}

export interface ReconcileRows {
  /** последняя сверка каждой площадки — удачная или нет */
  lastRuns: RunRow[];
  /** все открытые, свежие первыми */
  open: DiscrepancyRow[];
  /** закрытые за 30 суток, до 100, закрытые недавно — первыми */
  resolved: DiscrepancyRow[];
}

export interface PaymentReconcileRepository {
  /** Последняя сверка площадки с `finished_at` и без ошибки; такой не было — `null`. */
  lastFinished(platform: PlatformId): Promise<LastFinished | null>;
  startRun(run: StartedRun): Promise<void>;
  finishRun(runId: string, result: FinishedRun): Promise<void>;
  /** Покупки по идентификаторам оплат; идентификатор оплаты уникален, площадка не нужна. */
  purchasesByCharges(chargeIds: readonly string[]): Promise<KnownPurchase[]>;
  purchasesByIds(purchaseIds: readonly string[]): Promise<PurchaseRef[]>;
  /** Оплаченные покупки аккаунтов площадки с идентификатором оплаты и временем оплаты в отрезке, включительно. */
  paidInWindow(platform: PlatformId, from: Date, to: Date): Promise<KnownPurchase[]>;
  insertFound(runId: string, platform: PlatformId, found: readonly FoundDiscrepancy[], at: Date): Promise<InsertedFound>;
  open(platform: PlatformId): Promise<OpenDiscrepancy[]>;
  /** Закрыть сошедшиеся: только открытые, решение `matched`. Ответ — сколько закрыто. */
  resolveMatched(discrepancyIds: readonly string[], at: Date): Promise<number>;
  overview(now: Date): Promise<ReconcileRows>;
}

/** Поля строки расхождения для обзора: без `run_id` — он нужен базе, а не панели. */
const DISCREPANCY_SELECT = {
  discrepancyId: true,
  platform: true,
  kind: true,
  chargeId: true,
  purchaseId: true,
  accountId: true,
  payerId: true,
  amount: true,
  payload: true,
  occurredAt: true,
  detectedAt: true,
  resolution: true,
  resolvedAt: true,
  resolvedBy: true,
  note: true,
} as const;

const PURCHASE_SELECT = { purchaseId: true, accountId: true, telegramChargeId: true, chargedStars: true, paidAt: true, invoicedAt: true, refundedAt: true } as const;

interface PurchaseRecord {
  purchaseId: string;
  accountId: string;
  telegramChargeId: string | null;
  chargedStars: number;
  paidAt: Date | null;
  invoicedAt: Date;
  refundedAt: Date | null;
}

/** Покупка с оплатой: без идентификатора оплаты строки здесь нет; время оплаты нет — время счёта (оплата без отметки — сбой записи, но не повод ронять сверку). */
function known(row: PurchaseRecord): KnownPurchase[] {
  if (row.telegramChargeId === null) return [];
  return [{ purchaseId: row.purchaseId, accountId: row.accountId, chargeId: row.telegramChargeId, chargedStars: row.chargedStars, paidAt: row.paidAt ?? row.invoicedAt, refundedAt: row.refundedAt }];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let index = 0; index < items.length; index += size) parts.push(items.slice(index, index + size));
  return parts;
}

@Injectable()
export class PrismaPaymentReconcileRepository implements PaymentReconcileRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async lastFinished(platform: PlatformId): Promise<LastFinished | null> {
    const row = await this.prisma.paymentReconcileRun.findFirst({
      where: { platform, finishedAt: { not: null }, toOffset: { not: null }, error: null },
      orderBy: { finishedAt: "desc" },
      select: { toOffset: true, finishedAt: true },
    });
    if (row === null || row.toOffset === null || row.finishedAt === null) return null;
    return { toOffset: row.toOffset, finishedAt: row.finishedAt };
  }

  async startRun(run: StartedRun): Promise<void> {
    await this.prisma.paymentReconcileRun.create({
      data: {
        runId: run.runId,
        platform: run.platform,
        trigger: run.trigger,
        actorAccountId: run.actorAccountId,
        startedAt: run.startedAt,
        fromOffset: run.fromOffset,
      },
    });
  }

  async finishRun(runId: string, result: FinishedRun): Promise<void> {
    await this.prisma.paymentReconcileRun.update({
      where: { runId },
      data: {
        finishedAt: result.finishedAt,
        toOffset: result.toOffset,
        coveredFrom: result.coveredFrom,
        coveredTo: result.coveredTo,
        scanned: result.scanned,
        found: result.found,
        matched: result.matched,
        error: result.error,
      },
    });
  }

  async purchasesByCharges(chargeIds: readonly string[]): Promise<KnownPurchase[]> {
    const found: KnownPurchase[] = [];
    for (const part of chunks(chargeIds, CHUNK)) {
      const rows = await this.prisma.purchase.findMany({ where: { telegramChargeId: { in: part } }, select: PURCHASE_SELECT });
      for (const row of rows) found.push(...known(row));
    }
    return found;
  }

  async purchasesByIds(purchaseIds: readonly string[]): Promise<PurchaseRef[]> {
    const found: PurchaseRef[] = [];
    for (const part of chunks(purchaseIds, CHUNK)) {
      found.push(...(await this.prisma.purchase.findMany({ where: { purchaseId: { in: part } }, select: { purchaseId: true, accountId: true } })));
    }
    return found;
  }

  async paidInWindow(platform: PlatformId, from: Date, to: Date): Promise<KnownPurchase[]> {
    const rows = await this.prisma.purchase.findMany({
      where: { account: { platform }, telegramChargeId: { not: null }, paidAt: { gte: from, lte: to } },
      orderBy: [{ paidAt: "asc" }, { purchaseId: "asc" }],
      select: PURCHASE_SELECT,
    });
    return rows.flatMap(known);
  }

  async insertFound(runId: string, platform: PlatformId, found: readonly FoundDiscrepancy[], at: Date): Promise<InsertedFound> {
    const items: InsertedFound["items"] = [];
    for (const part of chunks(found, INSERT_CHUNK)) {
      // Возвращаются только вставленные строки: повторная находка упирается в уникальный ключ и пропускается.
      const created = await this.prisma.paymentDiscrepancy.createManyAndReturn({
        data: part.map((item) => ({
          discrepancyId: randomUUID(),
          platform,
          kind: item.kind,
          chargeId: item.chargeId,
          purchaseId: item.purchaseId,
          accountId: item.accountId,
          payerId: item.payerId,
          amount: item.amount,
          payload: item.payload,
          occurredAt: item.occurredAt,
          detectedAt: at,
          runId,
        })),
        skipDuplicates: true,
        select: { kind: true, chargeId: true, purchaseId: true },
      });
      for (const row of created) {
        // Вид только что записан нами из `FoundDiscrepancy`; сужение — вместо приведения типа.
        const kind = DISCREPANCY_KINDS.find((candidate) => candidate === row.kind);
        if (kind !== undefined) items.push({ kind, chargeId: row.chargeId, purchaseId: row.purchaseId });
      }
    }
    return { inserted: items.length, items };
  }

  async open(platform: PlatformId): Promise<OpenDiscrepancy[]> {
    return await this.prisma.paymentDiscrepancy.findMany({
      where: { platform, resolvedAt: null },
      orderBy: [{ detectedAt: "asc" }, { discrepancyId: "asc" }],
      select: { discrepancyId: true, kind: true, chargeId: true },
    });
  }

  async resolveMatched(discrepancyIds: readonly string[], at: Date): Promise<number> {
    let closed = 0;
    for (const part of chunks(discrepancyIds, CHUNK)) {
      // `resolved_at: null` — закрытое руками остаётся как закрыл человек.
      const result = await this.prisma.paymentDiscrepancy.updateMany({
        where: { discrepancyId: { in: part }, resolvedAt: null },
        data: { resolvedAt: at, resolution: "matched" },
      });
      closed += result.count;
    }
    return closed;
  }

  async overview(now: Date): Promise<ReconcileRows> {
    const since = new Date(now.getTime() - RESOLVED_DAYS * DAY_MS);
    const [lastRuns, open, resolved] = await Promise.all([
      this.prisma.paymentReconcileRun.findMany({
        distinct: ["platform"],
        orderBy: [{ platform: "asc" }, { startedAt: "desc" }],
        select: { platform: true, trigger: true, startedAt: true, finishedAt: true, scanned: true, found: true, error: true },
      }),
      this.prisma.paymentDiscrepancy.findMany({
        where: { resolvedAt: null },
        orderBy: [{ detectedAt: "desc" }, { discrepancyId: "desc" }],
        select: DISCREPANCY_SELECT,
      }),
      this.prisma.paymentDiscrepancy.findMany({
        where: { resolvedAt: { gte: since } },
        orderBy: [{ resolvedAt: "desc" }, { discrepancyId: "desc" }],
        take: RESOLVED_LIMIT,
        select: DISCREPANCY_SELECT,
      }),
    ]);
    return { lastRuns, open, resolved };
  }
}
