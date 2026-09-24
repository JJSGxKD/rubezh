import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { Prisma } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { isGranted, type PaymentMode, type StoredPurchase } from "./purchase-types.js";

/**
 * Покупки в Postgres (docs/34-stage3-plan.md, WP5). Запрос к базе живёт
 * здесь, а не в сервисе (docs/15-engineering-standards.md §2.3).
 *
 * Идемпотентность — уникальными индексами, а не проверкой в коде: два
 * одновременных запроса счёта на одно продолжение упираются в
 * `(run_id, continue_no)`, и строка остаётся одна.
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

export const PURCHASES_REPOSITORY = Symbol("PURCHASES_REPOSITORY");

export interface PurchasesRepository {
  openInvoice(record: InvoiceRecord): Promise<InvoiceOutcome>;
  byId(purchaseId: string): Promise<StoredPurchase | null>;
  /** Сколько продолжений забега оплачено — возвраты не отзывают выданное */
  grantedContinues(runId: string): Promise<number>;
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
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
