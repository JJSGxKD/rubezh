import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { Prisma } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { isGranted, isTelegramUserId, type PaymentMode, type RefundReason, type StoredPurchase } from "./purchase-types.js";

/**
 * Покупки в Postgres (docs/34-stage3-plan.md, WP5). Запрос к базе живёт
 * здесь, а не в сервисе (docs/15-engineering-standards.md §2.3).
 *
 * Идемпотентность — уникальными индексами, а не проверкой в коде: два
 * одновременных запроса счёта на одно продолжение упираются в
 * `(run_id, continue_no)`, и строка остаётся одна; два подтверждения одной
 * оплаты — в `telegram_charge_id`, и оплата записывается один раз.
 */

export interface InvoiceRecord {
  /** id новой покупки — если строки для этого продолжения ещё нет */
  purchaseId: string;
  accountId: string;
  runId: string;
  continueNo: number;
  elapsedSec: number;
  priceStars: number;
  chargedStars: number;
  mode: PaymentMode;
  invoicedAt: Date;
}

/**
 * `opened` — счёт можно выставлять: строка новая или ещё ждёт оплаты, и её
 * цена обновлена. `paid` — это продолжение уже оплачено: второй счёт на него
 * не выставляется. `foreign` — продолжение чужого забега.
 */
export type InvoiceOutcome =
  | { kind: "opened"; purchase: StoredPurchase }
  | { kind: "paid"; purchase: StoredPurchase }
  | { kind: "foreign" };

/** Покупка глазами предварительной проверки оплаты: кому выставлен счёт и жив ли забег. */
export interface CheckoutView {
  purchase: StoredPurchase;
  /** Telegram ID владельца покупки */
  platformUserId: string;
  /** забег уже закончен — продолжать нечего */
  runFinished: boolean;
}

export interface PaymentRecord {
  purchaseId: string;
  chargeId: string;
  /** сколько списал Telegram — на случай, если это не то, что стояло в счёте */
  chargedStars: number;
  paidAt: Date;
}

/**
 * `paid` — оплата записана сейчас. `duplicate` — эта же оплата уже записана:
 * Telegram повторил обновление. `already_paid` — покупка оплачена другой
 * оплатой: игрок заплатил дважды, и лишнее придётся вернуть. `unknown` —
 * покупки нет.
 */
export type ConfirmOutcome =
  | { kind: "paid"; purchase: StoredPurchase; runFinished: boolean }
  | { kind: "duplicate"; purchase: StoredPurchase }
  | { kind: "already_paid"; purchase: StoredPurchase }
  | { kind: "unknown" };

/**
 * Возврат, который надо сделать: кому и какую оплату. `purchaseId` пуст у
 * лишней оплаты — второй за то же продолжение или без покупки вовсе: строки
 * под неё нет, возвращается сама оплата.
 */
export interface RefundOrder {
  purchaseId: string | null;
  chargeId: string;
  userId: number;
  reason: RefundReason | "duplicate" | "unmatched";
}

export interface RefundedRecord {
  purchase: StoredPurchase;
  /** `false` — возврат уже был записан: повтор обновления */
  firstTime: boolean;
}

export const PURCHASES_REPOSITORY = Symbol("PURCHASES_REPOSITORY");

export interface PurchasesRepository {
  openInvoice(record: InvoiceRecord): Promise<InvoiceOutcome>;
  byId(purchaseId: string): Promise<StoredPurchase | null>;
  /** Сколько продолжений забега оплачено — возвраты не отзывают выданное */
  grantedContinues(runId: string): Promise<number>;
  /** Оплаченные продолжения забега: какое по счёту и по какой секунде посчитана цена */
  grantedForRun(runId: string): Promise<{ continueNo: number; elapsedSec: number }[]>;
  checkout(purchaseId: string): Promise<CheckoutView | null>;
  markPaid(record: PaymentRecord): Promise<ConfirmOutcome>;
  /** Звёзды вернулись. Причину, если её не заказывали мы, записывает как `external` */
  markRefunded(chargeId: string, refundedAt: Date): Promise<RefundedRecord | null>;
  /** Настоящие оплаты аккаунта и возвраты по ним не по нашей воле — доля возвратов (О4) */
  refundStats(accountId: string): Promise<{ paid: number; refunded: number }>;
  /**
   * Заказать возврат оплаченной покупки: причина и время заказа пишутся
   * раньше обращения к Telegram, чтобы после перезапуска его было кому
   * повторить. `null` — возвращать нечего: не оплачено или уже возвращено.
   */
  requestRefund(purchaseId: string, reason: RefundReason, at: Date): Promise<RefundOrder | null>;
  /** Заказанные и не подтверждённые возвраты — их очередь поднимает после перезапуска */
  pendingRefunds(limit: number): Promise<RefundOrder[]>;
  /** Оплаченные продолжения забега сверх взятых — их не использовали */
  unusedGrants(runId: string, usedContinues: number): Promise<string[]>;
}

const SELECT = {
  purchaseId: true,
  accountId: true,
  runId: true,
  continueNo: true,
  elapsedSec: true,
  priceStars: true,
  chargedStars: true,
  mode: true,
  status: true,
  telegramChargeId: true,
  invoicedAt: true,
  paidAt: true,
  refundReason: true,
  refundRequestedAt: true,
  refundedAt: true,
} as const;

@Injectable()
export class PrismaPurchasesRepository implements PurchasesRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async openInvoice(record: InvoiceRecord): Promise<InvoiceOutcome> {
    const offer = {
      elapsedSec: record.elapsedSec,
      priceStars: record.priceStars,
      chargedStars: record.chargedStars,
      mode: record.mode,
      invoicedAt: record.invoicedAt,
    };
    try {
      const created = await this.prisma.purchase.create({
        data: {
          purchaseId: record.purchaseId,
          accountId: record.accountId,
          product: "continue_run",
          runId: record.runId,
          continueNo: record.continueNo,
          status: "pending",
          ...offer,
        },
        select: SELECT,
      });
      return { kind: "opened", purchase: created };
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
    }

    // Счёт на это продолжение уже выставляли. Цена обновляется, только пока
    // оплаты нет: условие на статус — та же защита от гонки с подтверждением
    // оплаты, что у итога забега.
    await this.prisma.purchase.updateMany({
      where: { runId: record.runId, continueNo: record.continueNo, accountId: record.accountId, status: "pending" },
      data: offer,
    });
    const existing = await this.prisma.purchase.findUnique({
      where: { runId_continueNo: { runId: record.runId, continueNo: record.continueNo } },
      select: SELECT,
    });
    if (existing === null || existing.accountId !== record.accountId) return { kind: "foreign" };
    // Решает прочитанная строка, а не число обновлённых: оплата могла прийти
    // между обновлением и чтением, и счёт на оплаченное выставлять нельзя.
    return isGranted(existing) ? { kind: "paid", purchase: existing } : { kind: "opened", purchase: existing };
  }

  async byId(purchaseId: string): Promise<StoredPurchase | null> {
    return await this.prisma.purchase.findUnique({ where: { purchaseId }, select: SELECT });
  }

  async grantedContinues(runId: string): Promise<number> {
    return await this.prisma.purchase.count({ where: { runId, paidAt: { not: null } } });
  }

  async grantedForRun(runId: string): Promise<{ continueNo: number; elapsedSec: number }[]> {
    return await this.prisma.purchase.findMany({
      where: { runId, paidAt: { not: null } },
      orderBy: { continueNo: "asc" },
      select: { continueNo: true, elapsedSec: true },
    });
  }

  async checkout(purchaseId: string): Promise<CheckoutView | null> {
    // Одним запросом: на всю проверку у Telegram десять секунд.
    const row = await this.prisma.purchase.findUnique({
      where: { purchaseId },
      select: { ...SELECT, account: { select: { platformUserId: true } }, run: { select: { status: true } } },
    });
    if (row === null) return null;
    const { account, run, ...purchase } = row;
    return { purchase, platformUserId: account.platformUserId, runFinished: run.status === "finished" };
  }

  async markPaid(record: PaymentRecord): Promise<ConfirmOutcome> {
    const known = await this.prisma.purchase.findUnique({ where: { telegramChargeId: record.chargeId }, select: SELECT });
    if (known !== null) return { kind: "duplicate", purchase: known };

    let updated = 0;
    try {
      // Условие на статус — защита от второй оплаты той же покупки: оплату
      // принимает ровно одна, вторая увидит ноль обновлённых строк.
      const result = await this.prisma.purchase.updateMany({
        where: { purchaseId: record.purchaseId, status: "pending" },
        data: { status: "paid", paidAt: record.paidAt, telegramChargeId: record.chargeId, chargedStars: record.chargedStars },
      });
      updated = result.count;
    } catch (error: unknown) {
      // Тот же платёж записали параллельно — уникальный индекс не пустил второй.
      if (!isUniqueViolation(error)) throw error;
    }

    const view = await this.checkout(record.purchaseId);
    if (view === null) return { kind: "unknown" };
    if (updated === 1) return { kind: "paid", purchase: view.purchase, runFinished: view.runFinished };
    return view.purchase.telegramChargeId === record.chargeId
      ? { kind: "duplicate", purchase: view.purchase }
      : { kind: "already_paid", purchase: view.purchase };
  }

  async markRefunded(chargeId: string, refundedAt: Date): Promise<RefundedRecord | null> {
    // Одной транзакцией: время возврата — первое, а причина остаётся той,
    // что записали при заказе возврата, если его заказывали мы.
    const [refunded] = await this.prisma.$transaction([
      this.prisma.purchase.updateMany({ where: { telegramChargeId: chargeId, refundedAt: null }, data: { status: "refunded", refundedAt } }),
      this.prisma.purchase.updateMany({ where: { telegramChargeId: chargeId, refundReason: null }, data: { refundReason: "external" } }),
    ]);
    const purchase = await this.prisma.purchase.findUnique({ where: { telegramChargeId: chargeId }, select: SELECT });
    return purchase === null ? null : { purchase, firstTime: refunded.count === 1 };
  }

  async refundStats(accountId: string): Promise<{ paid: number; refunded: number }> {
    const [paid, refunded] = await Promise.all([
      this.prisma.purchase.count({ where: { accountId, mode: "live", paidAt: { not: null } } }),
      this.prisma.purchase.count({ where: { accountId, mode: "live", refundReason: "external" } }),
    ]);
    return { paid, refunded };
  }

  async requestRefund(purchaseId: string, reason: RefundReason, at: Date): Promise<RefundOrder | null> {
    // Первая причина остаётся: повторный заказ того же возврата её не меняет.
    await this.prisma.purchase.updateMany({
      where: { purchaseId, paidAt: { not: null }, refundRequestedAt: null, refundedAt: null },
      data: { refundReason: reason, refundRequestedAt: at },
    });
    const row = await this.prisma.purchase.findUnique({ where: { purchaseId }, select: REFUND_SELECT });
    return row === null ? null : refundOrderOf(row);
  }

  async pendingRefunds(limit: number): Promise<RefundOrder[]> {
    const rows = await this.prisma.purchase.findMany({
      where: { refundRequestedAt: { not: null }, refundedAt: null },
      orderBy: { refundRequestedAt: "asc" },
      take: limit,
      select: REFUND_SELECT,
    });
    return rows.map(refundOrderOf).filter((order) => order !== null);
  }

  async unusedGrants(runId: string, usedContinues: number): Promise<string[]> {
    const rows = await this.prisma.purchase.findMany({
      where: { runId, paidAt: { not: null }, continueNo: { gt: usedContinues }, refundRequestedAt: null },
      select: { purchaseId: true },
    });
    return rows.map((row) => row.purchaseId);
  }
}

const REFUND_SELECT = {
  purchaseId: true,
  telegramChargeId: true,
  refundReason: true,
  refundRequestedAt: true,
  refundedAt: true,
  account: { select: { platformUserId: true } },
} as const;

function refundOrderOf(row: {
  purchaseId: string;
  telegramChargeId: string | null;
  refundReason: RefundReason | null;
  refundRequestedAt: Date | null;
  refundedAt: Date | null;
  account: { platformUserId: string };
}): RefundOrder | null {
  if (row.telegramChargeId === null || row.refundRequestedAt === null || row.refundedAt !== null || row.refundReason === null) return null;
  if (!isTelegramUserId(row.account.platformUserId)) return null;
  return { purchaseId: row.purchaseId, chargeId: row.telegramChargeId, userId: Number(row.account.platformUserId), reason: row.refundReason };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
