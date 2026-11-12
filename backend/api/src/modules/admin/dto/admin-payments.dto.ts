import { z } from "zod";
import { PLATFORM_IDS } from "../../../platforms/ports/platform.js";
import type { FeedFilters } from "../../payments/payments-feed.service.js";
import { FEED_STATUSES, PAYMENT_MODES, PURCHASE_PRODUCTS } from "../../payments/purchase-types.js";
import { accountIdSchema } from "./admin.dto.js";

/**
 * Запрос ленты платежей (Р209, WP53, tasks/T-0429). Схема строгая: лишний
 * параметр — ошибка, а не молча проигнорированный фильтр, после которого
 * команда читает не ту выборку.
 */

export const FEED_PAGE_DEFAULT = 50;
export const FEED_PAGE_MAX = 100;

/** Номер покупки: Postgres принимает любой UUID по форме, и поиск не должен зависеть от версии, с которой его сгенерировали. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const moment = z.iso.datetime({ offset: true });

export const paymentsFeedQuerySchema = z
  .strictObject({
    status: z.enum(FEED_STATUSES).optional(),
    product: z.enum(PURCHASE_PRODUCTS).optional(),
    platform: z.enum(PLATFORM_IDS).optional(),
    mode: z.enum(PAYMENT_MODES).optional(),
    from: moment.optional(),
    to: moment.optional(),
    /** игрок — по идентификатору аккаунта */
    account: accountIdSchema.optional(),
    /** номер покупки (UUID) или идентификатор оплаты площадки — точно, без частичного поиска */
    q: z.string().trim().min(8).max(256).optional(),
    cursor: z.string().min(1).max(300).optional(),
    limit: z.coerce.number().int().min(1).max(FEED_PAGE_MAX).default(FEED_PAGE_DEFAULT),
  })
  .refine((query) => query.from === undefined || query.to === undefined || new Date(query.from).getTime() < new Date(query.to).getTime(), "Конец периода должен быть позже начала");

export type PaymentsFeedQuery = z.output<typeof paymentsFeedQuerySchema>;

/**
 * Фильтры для сервиса: границы — датами, а поиск разобран по виду: UUID —
 * номер покупки, всё остальное — идентификатор оплаты.
 */
export function feedFiltersOf(query: PaymentsFeedQuery): FeedFilters {
  return {
    status: query.status ?? null,
    product: query.product ?? null,
    from: query.from === undefined ? null : new Date(query.from),
    to: query.to === undefined ? null : new Date(query.to),
    accountId: query.account ?? null,
    platform: query.platform ?? null,
    mode: query.mode ?? null,
    search: query.q === undefined ? null : UUID_SHAPE.test(query.q) ? { purchaseId: query.q.toLowerCase() } : { chargeId: query.q },
  };
}
