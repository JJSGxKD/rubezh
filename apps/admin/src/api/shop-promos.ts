import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Акции магазина (`/admin/shop/promos`, docs/35-stage4-plan.md WP10, часть 8):
 * скидка от цены каталога на срок — под `shop.promo.edit`. Правки нет: акцию
 * снимают и заводят заново. Пределы приходят с сервера (`PROMO_LIMITS`), форма
 * проверяет по ним то, что видно без базы; пересечение с соседними акциями
 * товара решает сервер.
 */

export const PROMO_STATE_TITLES: Partial<Record<string, string>> = {
  scheduled: "будет",
  active: "идёт",
  ended: "кончилась",
  cancelled: "снята",
};

/** Снять можно то, что ещё не кончилось. */
export const CANCELLABLE: ReadonlySet<string> = new Set(["scheduled", "active"]);

/** Подпись баннера — та же длина, что принимает сервер. */
export const PROMO_TITLE_MAX = 48;

const promoSchema = z.object({
  promoId: z.string(),
  sku: z.string(),
  percent: z.number(),
  startsAt: z.string(),
  endsAt: z.string(),
  title: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string(),
  cancelledAt: z.string().nullable(),
  cancelledBy: z.string().nullable(),
  state: z.string(),
});
export type Promo = z.infer<typeof promoSchema>;

const limitsSchema = z.object({
  minPercent: z.number(),
  maxPercent: z.number(),
  minHours: z.number(),
  maxDays: z.number(),
  restDays: z.number(),
  aheadDays: z.number(),
});
export type PromoLimits = z.infer<typeof limitsSchema>;

const catalogSchema = z.object({
  promos: z.array(promoSchema),
  skus: z.array(z.object({ sku: z.string(), title: z.string(), kind: z.string(), stars: z.number() })),
  limits: limitsSchema,
});
export type PromoCatalog = z.infer<typeof catalogSchema>;
export type PromoSku = PromoCatalog["skus"][number];

export interface PromoDraft {
  sku: string;
  percent: number;
  /** пусто — начать сразу; иначе значение поля `datetime-local` в часах браузера */
  startsAt: string;
  days: number;
  title: string;
}

export function emptyDraft(skus: readonly PromoSku[]): PromoDraft {
  return { sku: skus[0]?.sku ?? "", percent: 20, startsAt: "", days: 3, title: "" };
}

export function fetchPromos(api: AdminApi): Promise<ApiResult<PromoCatalog>> {
  return api.request("/shop/promos", { schema: catalogSchema });
}

/** Время — в UTC: поле формы — в часах браузера, сервер считает в абсолютном времени. */
export function promoRequest(draft: PromoDraft, now: Date): { sku: string; percent: number; startsAt: string; endsAt: string; title: string | null } {
  const start = draft.startsAt === "" ? now : new Date(draft.startsAt);
  const title = draft.title.trim();
  return {
    sku: draft.sku,
    percent: draft.percent,
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + draft.days * 86_400_000).toISOString(),
    title: title === "" ? null : title,
  };
}

export function createPromo(api: AdminApi, draft: PromoDraft, now = new Date()): Promise<ApiResult<Promo>> {
  return api.request("/shop/promos", { method: "POST", body: promoRequest(draft, now), schema: promoSchema });
}

export function cancelPromo(api: AdminApi, promoId: string): Promise<ApiResult<Promo>> {
  return api.request(`/shop/promos/${encodeURIComponent(promoId)}/cancel`, { method: "POST", schema: promoSchema });
}

/** Цена по акции — тем же правилом, что сервер: вниз до целой звезды, не ниже одной. */
export function promoPrice(full: number, percent: number): number {
  return Math.max(1, Math.floor((full * (100 - percent)) / 100));
}

/** Что не так с формой по пределам сервера; `null` — можно отправлять. Пересечение с другими акциями решит сервер. */
export function draftProblem(draft: PromoDraft, limits: PromoLimits, now: Date): string | null {
  if (draft.sku === "") return "Выберите товар";
  if (!Number.isInteger(draft.percent) || draft.percent < limits.minPercent || draft.percent > limits.maxPercent) {
    return `Скидка — целое число от ${String(limits.minPercent)} до ${String(limits.maxPercent)}%`;
  }
  if (!Number.isFinite(draft.days) || draft.days * 24 < limits.minHours || draft.days > limits.maxDays) {
    return `Акция идёт от ${String(limits.minHours)} ч до ${String(limits.maxDays)} дней`;
  }
  if (draft.startsAt !== "") {
    const start = new Date(draft.startsAt);
    if (Number.isNaN(start.getTime())) return "Некорректное начало";
    if (start.getTime() < now.getTime()) return "Начало — в прошлом: оставьте поле пустым, чтобы начать сразу";
    if (start.getTime() > now.getTime() + limits.aheadDays * 86_400_000) return `Заводите не дальше чем за ${String(limits.aheadDays)} дней`;
  }
  if (draft.title.trim().length > PROMO_TITLE_MAX) return `Подпись — не длиннее ${String(PROMO_TITLE_MAX)} знаков`;
  return null;
}
