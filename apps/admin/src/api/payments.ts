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

/**
 * Сверка с площадкой, брошенные задания и компенсация (tasks/T-0438, серверы
 * T-0431, T-0433–T-0435). Список расхождений разбирается построчно: вид или
 * решение новее панели — строка пропускается, а не роняет вкладку.
 */

export const DISCREPANCY_KINDS = ["charged_unrecorded", "refund_unrecorded", "recorded_missing"] as const;
export type DiscrepancyKind = (typeof DISCREPANCY_KINDS)[number];

export const DISCREPANCY_RESOLUTIONS = ["matched", "retried", "refunded", "dismissed"] as const;
export type DiscrepancyResolution = (typeof DISCREPANCY_RESOLUTIONS)[number];

/** Что можно сделать с расхождением. */
export type DiscrepancyActionId = "retry" | "refund" | "dismiss";

export const discrepancySchema = z.object({
  discrepancyId: z.string(),
  /** строкой: площадка новее панели показывается как есть */
  platform: z.string(),
  kind: z.enum(DISCREPANCY_KINDS),
  chargeId: z.string(),
  purchaseId: z.string().nullable(),
  accountId: z.string().nullable(),
  displayName: z.string().nullable(),
  /** идентификатор плательщика на площадке; без права на персональные данные сервер его стирает */
  payerId: z.string().nullable(),
  /** сумма в звёздах */
  amount: z.number(),
  payload: z.string().nullable(),
  occurredAt: z.string(),
  detectedAt: z.string(),
  resolution: z.enum(DISCREPANCY_RESOLUTIONS).nullable(),
  resolvedAt: z.string().nullable(),
  resolvedByName: z.string().nullable(),
  note: z.string().nullable(),
});

export type Discrepancy = z.infer<typeof discrepancySchema>;

/** Строки, которые не разобрались, отбрасываются: незнакомое не должно прятать остальное. */
function lenientList<T extends z.ZodType>(item: T) {
  return z.array(z.unknown()).transform((rows): z.infer<T>[] => {
    const kept: z.infer<T>[] = [];
    for (const row of rows) {
      const parsed = item.safeParse(row);
      if (parsed.success) kept.push(parsed.data);
    }
    return kept;
  });
}

const reconcileRunSchema = z.object({
  platform: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  scanned: z.number(),
  found: z.number(),
  error: z.string().nullable(),
});

export const reconcileOverviewSchema = z.object({
  /** выключатель «Сверка оплат с площадкой» в «Настройках» */
  enabled: z.boolean(),
  lastRuns: lenientList(reconcileRunSchema),
  open: lenientList(discrepancySchema),
  resolved: lenientList(discrepancySchema),
});

export type ReconcileOverview = z.infer<typeof reconcileOverviewSchema>;
export type ReconcileRun = z.infer<typeof reconcileRunSchema>;

const reconcileSummarySchema = z.object({
  platform: z.string(),
  scanned: z.number(),
  found: z.number(),
  matched: z.number(),
  open: z.number(),
  error: z.string().nullable(),
});

export type ReconcileSummary = z.infer<typeof reconcileSummarySchema>;

export const failedJobSchema = z.object({
  jobId: z.string(),
  /** строкой: вид новее панели показывается как есть */
  kind: z.string(),
  chargeId: z.string().nullable(),
  purchaseId: z.string().nullable(),
  payerId: z.string().nullable(),
  amount: z.number().nullable(),
  reason: z.string(),
  attempts: z.number(),
  failedAt: z.string().nullable(),
});

export const paymentJobsSchema = z.object({
  /** `false` — очередь не отвечает или оплата выключена */
  available: z.boolean(),
  jobs: z.array(failedJobSchema),
});

export type FailedJob = z.infer<typeof failedJobSchema>;
export type PaymentJobs = z.infer<typeof paymentJobsSchema>;

export const compensationPreviewSchema = z.object({
  purchaseId: z.string(),
  /** `null` — можно; иначе — почему нельзя */
  blockedReason: z.string().nullable(),
  chargedStars: z.number(),
  equivalentGems: z.number().nullable(),
  multiplier: z.number(),
  suggestedGems: z.number().nullable(),
  maxGems: z.number(),
  /** компенсация уже записана; `credited: false` — записана, но самоцветы не начислены */
  existing: z
    .object({
      gems: z.number(),
      suggested: z.number().nullable(),
      note: z.string(),
      actorName: z.string().nullable(),
      createdAt: z.string(),
      credited: z.boolean(),
    })
    .nullable(),
  /** ручные начисления игроку за 30 суток */
  recentManual: z.array(z.object({ at: z.string(), resource: z.string(), amount: z.number() })),
});

export type CompensationPreview = z.infer<typeof compensationPreviewSchema>;

const compensationResultSchema = z.object({ purchaseId: z.string(), gems: z.number(), balance: z.number(), repaired: z.boolean() });

export type CompensationResult = z.infer<typeof compensationResultSchema>;

const jobRetrySchema = z.object({ jobId: z.string(), purchaseId: z.string().nullable() });

/** Сверка читает выписку страница за страницей и может идти дольше обычного запроса. */
const RECONCILE_TIMEOUT_MS = 60_000;

export function fetchReconcileOverview(api: AdminApi): Promise<ApiResult<ReconcileOverview>> {
  return api.request("/payment-reconcile", { schema: reconcileOverviewSchema });
}

/** «Сверить сейчас» (право `payments.support`): сверка идёт в самом запросе, ответ — итог по площадкам. */
export function runReconcile(api: AdminApi): Promise<ApiResult<ReconcileSummary[]>> {
  return api.request("/payment-reconcile/run", { method: "POST", schema: z.array(reconcileSummarySchema), timeoutMs: RECONCILE_TIMEOUT_MS });
}

export function discrepancyAction(api: AdminApi, discrepancyId: string, action: DiscrepancyActionId, note: string): Promise<ApiResult<Discrepancy>> {
  return api.request(`/payment-reconcile/${encodeURIComponent(discrepancyId)}/${action}`, { method: "POST", body: { note }, schema: discrepancySchema });
}

export function fetchPaymentJobs(api: AdminApi): Promise<ApiResult<PaymentJobs>> {
  return api.request("/payment-jobs", { schema: paymentJobsSchema });
}

export function retryPaymentJob(api: AdminApi, jobId: string, note: string): Promise<ApiResult<z.infer<typeof jobRetrySchema>>> {
  return api.request(`/payment-jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST", body: { note }, schema: jobRetrySchema });
}

export function fetchCompensationPreview(api: AdminApi, purchaseId: string): Promise<ApiResult<CompensationPreview>> {
  return api.request(`/payments/${encodeURIComponent(purchaseId)}/compensation`, { schema: compensationPreviewSchema });
}

export function compensatePayment(api: AdminApi, purchaseId: string, input: { gems: number; note: string }): Promise<ApiResult<CompensationResult>> {
  return api.request(`/payments/${encodeURIComponent(purchaseId)}/compensate`, { method: "POST", body: input, schema: compensationResultSchema });
}
