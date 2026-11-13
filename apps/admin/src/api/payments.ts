import { z } from "zod";
import type { AdminApi, ApiResult, QueryValue } from "./client";
import { purchaseSchema } from "./players";

/**
 * Платежи в панели (`/admin/payments`, Р209, WP53, tasks/T-0437): лента всех
 * покупок и карточка платежа с хронологией. Схемы описывают то, что панель
 * показывает; лишние поля сервера отбрасываются, а изменившийся тип поля —
 * ошибка разбора. Действия и пометки приходят строками: значение новее панели
 * не должно ронять экран. Даты — строки ISO в UTC.
 */

/** Покупка в ленте — как в карточке игрока, плюс игрок и идентификатор оплаты площадки. */
export const feedPurchaseSchema = purchaseSchema.extend({
  accountId: z.string(),
  /** идентификатор оплаты площадки; у счёта без оплаты его нет */
  telegramChargeId: z.string().nullable().default(null),
});

const feedAccountSchema = z.object({ accountId: z.string(), displayName: z.string(), platform: z.string() });

export const feedRowSchema = z.object({
  purchase: feedPurchaseSchema,
  account: feedAccountSchema,
  marks: z.array(z.string()),
});

export const feedPageSchema = z.object({
  rows: z.array(feedRowSchema),
  /** курсор следующей страницы; `null` — это последняя */
  next: z.string().nullable(),
});

export const timelineEntrySchema = z.object({
  at: z.string(),
  kind: z.string(),
  text: z.string(),
  /** кто сделал; у системы и площадки — `null` */
  actorName: z.string().nullable(),
});

export const paymentCardSchema = z.object({
  purchase: feedPurchaseSchema,
  account: feedAccountSchema.extend({
    /** идентификатор на площадке и юзернейм — сервер отдаёт их только с правом на персональные данные */
    pii: z
      .object({ platformUserId: z.string(), username: z.string().nullable() })
      .nullable()
      .optional()
      .transform((value) => value ?? null),
  }),
  /** первая покупка подписки — если эта покупка продление */
  renewalOf: feedPurchaseSchema.nullable(),
  /** продления — если эта покупка первая покупка подписки */
  renewals: z.array(feedPurchaseSchema),
  timeline: z.array(timelineEntrySchema),
  actions: z.array(z.string()),
  marks: z.array(z.string()),
});

export type FeedRow = z.infer<typeof feedRowSchema>;
export type FeedPage = z.infer<typeof feedPageSchema>;
export type FeedPurchase = z.infer<typeof feedPurchaseSchema>;
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;
export type PaymentCard = z.infer<typeof paymentCardSchema>;

export const FEED_STATUSES = [
  ["pending", "ждёт оплаты"],
  ["paid", "оплачен"],
  ["undelivered", "не выдан"],
  ["refund_requested", "возврат в пути"],
  ["refunded", "звёзды возвращены"],
] as const;

export const PRODUCTS = [
  ["continue_run", "второй шанс"],
  ["shop_item", "магазин"],
  ["vip", "VIP"],
  ["donation", "донат"],
] as const;

export const PLATFORMS = [
  ["telegram", "Telegram"],
  ["max", "MAX"],
  ["vk", "VK"],
  ["web", "веб"],
] as const;

export const MODES = [
  ["live", "боевой"],
  ["test", "тестовый"],
] as const;

export type FeedStatus = (typeof FEED_STATUSES)[number][0];
export type FeedProduct = (typeof PRODUCTS)[number][0];
export type FeedPlatform = (typeof PLATFORMS)[number][0];
export type FeedMode = (typeof MODES)[number][0];

/** Подпись из таблицы пар; значение новее панели показывается как есть. */
export function titleOf(table: readonly (readonly [string, string])[], key: string): string {
  return table.find(([id]) => id === key)?.[1] ?? key;
}

export type MarkTone = "neutral" | "success" | "warning";

const MARKS: Readonly<Record<string, { label: string; tone: MarkTone }>> = {
  compensated: { label: "компенсирована", tone: "success" },
  job_abandoned: { label: "задание брошено", tone: "warning" },
  discrepancy: { label: "расхождение", tone: "warning" },
};

/** Пометка ленты — словами и тоном бейджа; незнакомая — как есть, без тона. */
export function markLabel(mark: string): { label: string; tone: MarkTone } {
  return MARKS[mark] ?? { label: mark, tone: "neutral" };
}

export function fetchPaymentsFeed(api: AdminApi, query: Record<string, QueryValue>, cursor: string | null): Promise<ApiResult<FeedPage>> {
  return api.request("/payments", { query: { ...query, cursor: cursor ?? undefined }, schema: feedPageSchema });
}

export function fetchPaymentCard(api: AdminApi, purchaseId: string): Promise<ApiResult<PaymentCard>> {
  return api.request(`/payments/${encodeURIComponent(purchaseId)}`, { schema: paymentCardSchema });
}

/** Ответ повтора не разбирается по полям: учёт поставлен в очередь, а исход покажет хронология. */
const retryResultSchema = z.object({});

/** «Повторить учёт» (право `payments.support`); причина попадёт в журнал действий и в поток «Покупки». */
export function retryPayment(api: AdminApi, purchaseId: string, note: string): Promise<ApiResult<z.infer<typeof retryResultSchema>>> {
  return api.request(`/payments/${encodeURIComponent(purchaseId)}/retry`, { method: "POST", body: { note }, schema: retryResultSchema });
}
