import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Заявки на правку цен с подтверждением второго участника
 * (`/admin/change-requests`, docs/19-content-admin.md §6, tasks/T-0309):
 * читать — `sku.price.view`, подавать и решать — `sku.price.edit`.
 *
 * «Было» и «стало» приходят как `unknown`: форму значений знает вид правки,
 * а разбирает её экран (`screens/balance/prices/prices-rules.ts`).
 */

const ADMIN_CHANGE_REQUESTS = "/change-requests";

const dateText = z.string().min(1);

export const REQUEST_STATUSES = ["pending", "approved", "rejected", "expired", "superseded"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const changeRequestSchema = z.object({
  requestId: z.string(),
  kind: z.string(),
  target: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  reason: z.string(),
  /** идентификатор аккаунта автора */
  author: z.string(),
  authorName: z.string().nullable(),
  status: z.enum(REQUEST_STATUSES),
  /** кто подтвердил, отклонил или отозвал; `null` — заявка закрылась сама */
  decidedBy: z.string().nullable(),
  decidedByName: z.string().nullable(),
  decidedAt: dateText.nullable(),
  createdAt: dateText,
  expiresAt: dateText,
});
export type ChangeRequest = z.infer<typeof changeRequestSchema>;

/** Цель правки: что стоит в коде, что действует сейчас и менялось ли. */
export const changeTargetSchema = z.object({
  target: z.string(),
  title: z.string(),
  current: z.unknown(),
  inCode: z.unknown(),
  overridden: z.boolean(),
});
export type ChangeTarget = z.infer<typeof changeTargetSchema>;

const overviewSchema = z.object({
  requests: z.array(changeRequestSchema),
  /** цели по видам заявок: сейчас — `sku_price` */
  targets: z.record(z.string(), z.array(changeTargetSchema)),
  ttlHours: z.number().int(),
});
export type ChangeOverview = z.infer<typeof overviewSchema>;

export interface ProposeBody {
  kind: string;
  target: string;
  /** только изменяемые поля */
  after: Record<string, unknown>;
  reason: string;
}

export function fetchChangeRequests(api: AdminApi): Promise<ApiResult<ChangeOverview>> {
  return api.request(ADMIN_CHANGE_REQUESTS, { schema: overviewSchema });
}

/** Заявка: «было» сервер берёт сам. Отказ формы (`422`) — текст с названием поля. */
export function proposeChange(api: AdminApi, body: ProposeBody): Promise<ApiResult<ChangeRequest>> {
  return api.request(ADMIN_CHANGE_REQUESTS, { method: "POST", body: { ...body, reason: body.reason.trim() }, schema: changeRequestSchema });
}

function decide(api: AdminApi, requestId: string, action: "approve" | "reject" | "withdraw"): Promise<ApiResult<ChangeRequest>> {
  return api.request(`${ADMIN_CHANGE_REQUESTS}/${encodeURIComponent(requestId)}/${action}`, { method: "POST", schema: changeRequestSchema });
}

/** Подтвердить: только другой участник с правом; цель применяется в этом же запросе. */
export function approveChange(api: AdminApi, requestId: string): Promise<ApiResult<ChangeRequest>> {
  return decide(api, requestId, "approve");
}

export function rejectChange(api: AdminApi, requestId: string): Promise<ApiResult<ChangeRequest>> {
  return decide(api, requestId, "reject");
}

/** Отозвать свою заявку. */
export function withdrawChange(api: AdminApi, requestId: string): Promise<ApiResult<ChangeRequest>> {
  return decide(api, requestId, "withdraw");
}
