import { Inject, Injectable } from "@nestjs/common";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import type { FeedStatus, PaymentMode, PurchaseProduct, StoredPurchase } from "./purchase-types.js";

/**
 * Лента платежей в Postgres (Р209, WP53, tasks/T-0429): все покупки всех
 * игроков, свежие счета первыми, страница — по курсору, без `OFFSET`. Запрос
 * к базе живёт здесь, а не в сервисе (docs/15-engineering-standards.md §2.3);
 * репозиторий покупок (`purchases.repository.ts`) ленты не знает.
 *
 * Площадка покупки — площадка аккаунта: у строки покупки своей площадки нет,
 * а аккаунт живёт на одной. Порядок держит индекс `[invoicedAt, purchaseId]`.
 */

export const PAYMENTS_FEED_REPOSITORY = Symbol("PAYMENTS_FEED_REPOSITORY");

/** Сколько продлений карточка первой покупки подписки показывает: подписка за год — двенадцать, потолок — страховка. */
const RENEWALS_SHOWN = 60;

export interface FeedQuery {
  status: FeedStatus | null;
  product: PurchaseProduct | null;
  /** по `invoiced_at`, включительно */
  from: Date | null;
  /** по `invoiced_at`, исключительно */
  to: Date | null;
  accountId: string | null;
  /** площадка аккаунта покупки */
  platform: PlatformId | null;
  mode: PaymentMode | null;
  /** номер покупки (и продления с таким `renewal_of`) или точный идентификатор оплаты; частичного поиска нет */
  search: { purchaseId: string } | { chargeId: string } | null;
  /** товары, у которых есть выдача, — для состояния `undelivered` */
  fulfillable: readonly PurchaseProduct[];
  cursor: { invoicedAt: Date; purchaseId: string } | null;
  limit: number;
}

/** Строка ленты: покупка и игрок без персональных данных — ни идентификатора на площадке, ни юзернейма. */
export interface FeedRowRecord {
  purchase: StoredPurchase;
  account: { displayName: string; platform: PlatformId };
}

/** Покупка для карточки: игрок вместе с идентификатором на площадке и юзернеймом — отдаются только с правом. */
export interface PurchaseCardRecord {
  purchase: StoredPurchase;
  account: { displayName: string; platform: PlatformId; platformUserId: string; username: string | null };
}

export interface PaymentsFeedRepository {
  /** До `limit + 1` строк: лишняя — признак следующей страницы. */
  page(query: FeedQuery): Promise<FeedRowRecord[]>;
  byId(purchaseId: string): Promise<PurchaseCardRecord | null>;
  /** Продления подписки по `renewal_of`, по времени оплаты, не больше 60. */
  renewals(firstId: string): Promise<StoredPurchase[]>;
}

/** Поля `StoredPurchase`: пропущенное поле — ошибка типов при возврате строки, а не пустое значение в панели. */
const PURCHASE_SELECT = {
  purchaseId: true,
  accountId: true,
  product: true,
  runId: true,
  continueNo: true,
  elapsedSec: true,
  sku: true,
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
  fulfilledAt: true,
  renewalOf: true,
} as const;

const ROW_SELECT = { ...PURCHASE_SELECT, account: { select: { displayName: true, platform: true } } } as const;

const CARD_SELECT = { ...PURCHASE_SELECT, account: { select: { displayName: true, platform: true, platformUserId: true, username: true } } } as const;

@Injectable()
export class PrismaPaymentsFeedRepository implements PaymentsFeedRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async page(query: FeedQuery): Promise<FeedRowRecord[]> {
    const rows = await this.prisma.purchase.findMany({
      where: { AND: conditionsOf(query) },
      // Второй ключ — id: две покупки одной миллисекунды идут в одном порядке от запроса к запросу, и курсор их не теряет.
      orderBy: [{ invoicedAt: "desc" }, { purchaseId: "desc" }],
      take: query.limit + 1,
      select: ROW_SELECT,
    });
    return rows.map(({ account, ...purchase }) => ({ purchase, account }));
  }

  async byId(purchaseId: string): Promise<PurchaseCardRecord | null> {
    const row = await this.prisma.purchase.findUnique({ where: { purchaseId }, select: CARD_SELECT });
    if (row === null) return null;
    const { account, ...purchase } = row;
    return { purchase, account };
  }

  async renewals(firstId: string): Promise<StoredPurchase[]> {
    return await this.prisma.purchase.findMany({
      where: { renewalOf: firstId },
      orderBy: [{ paidAt: "asc" }, { purchaseId: "asc" }],
      take: RENEWALS_SHOWN,
      select: PURCHASE_SELECT,
    });
  }
}

/** Оплата записана и не возвращается: то, что осталось от «paid» после заказа возврата. */
const LIVE_PAID: Prisma.PurchaseWhereInput = { paidAt: { not: null }, refundRequestedAt: null, refundedAt: null };

function statusCondition(status: FeedStatus, fulfillable: readonly PurchaseProduct[]): Prisma.PurchaseWhereInput {
  switch (status) {
    case "pending":
      return { status: "pending" };
    case "paid":
      return LIVE_PAID;
    case "undelivered":
      // Товар из `fulfillable`: у второго шанса выдачи нет, и `fulfilled_at` у него пуст всегда.
      return { ...LIVE_PAID, fulfilledAt: null, product: { in: [...fulfillable] } };
    case "refund_requested":
      return { refundRequestedAt: { not: null }, refundedAt: null };
    case "refunded":
      return { refundedAt: { not: null } };
  }
}

/** Условия по одному на фильтр: склеиваются через `AND`, потому что состояние и товар оба ограничивают `product`. */
function conditionsOf(query: FeedQuery): Prisma.PurchaseWhereInput[] {
  const conditions: Prisma.PurchaseWhereInput[] = [];
  if (query.status !== null) conditions.push(statusCondition(query.status, query.fulfillable));
  if (query.product !== null) conditions.push({ product: query.product });
  if (query.from !== null) conditions.push({ invoicedAt: { gte: query.from } });
  if (query.to !== null) conditions.push({ invoicedAt: { lt: query.to } });
  if (query.accountId !== null) conditions.push({ accountId: query.accountId });
  if (query.platform !== null) conditions.push({ account: { platform: query.platform } });
  if (query.mode !== null) conditions.push({ mode: query.mode });
  if (query.search !== null) {
    conditions.push("purchaseId" in query.search ? { OR: [{ purchaseId: query.search.purchaseId }, { renewalOf: query.search.purchaseId }] } : { telegramChargeId: query.search.chargeId });
  }
  if (query.cursor !== null) {
    const { invoicedAt, purchaseId } = query.cursor;
    conditions.push({ OR: [{ invoicedAt: { lt: invoicedAt } }, { invoicedAt, purchaseId: { lt: purchaseId } }] });
  }
  return conditions;
}
