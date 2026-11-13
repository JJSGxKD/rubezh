import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";

/**
 * Заявки на правку с подтверждением второго участника (docs/19-content-admin.md
 * §6, tasks/T-0309): один человек предлагает «было → стало», другой с тем же
 * правом подтверждает, и только тогда значение меняется. Типы и пределы —
 * здесь; правила — `change-request-rules.ts`, ход заявки — сервис.
 */

/** Что правится: товар магазина — сейчас, награды — T-0310. Список держит и `CHECK` в миграции. */
export const CHANGE_KINDS = ["sku_price", "reward_setting"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** `pending` — ждёт решения; остальные — исход. Список держит и `CHECK` в миграции. */
export const CHANGE_STATUSES = ["pending", "approved", "rejected", "expired", "superseded"] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];
export type ClosedStatus = Exclude<ChangeStatus, "pending">;

/** Заявка живёт трое суток: дольше она описывает уже не ту цену, что стоит сейчас. */
export const CHANGE_TTL_HOURS = 72;
export const CHANGE_TTL_MS = CHANGE_TTL_HOURS * 3_600_000;

export const REASON_MAX = 200;
export const TARGET_MAX = 64;

/** Закрытые заявки панель показывает за месяц; живые — все, сколько бы ни было. */
export const CLOSED_VISIBLE_DAYS = 30;
export const LIST_LIMIT = 200;

/** Транзакция хранилища: виды правок читают и пишут цель в ней же, вместе с заявкой. */
export type ChangeTx = Prisma.TransactionClient;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Данные базы разбираются схемой, а не приведением типа: jsonb мог записать кто угодно. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]));

export interface ChangeRequestRow {
  requestId: string;
  kind: ChangeKind;
  target: string;
  /** значения правимых полей на момент заявки */
  before: JsonValue;
  /** что станет — только изменяемые поля */
  after: JsonValue;
  reason: string;
  author: string;
  status: ChangeStatus;
  /** кто подтвердил, отклонил или отозвал; `null` — заявка закрылась сама */
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

/** Заявка для панели: с именами людей и сроком. */
export interface ChangeRequestView extends ChangeRequestRow {
  authorName: string | null;
  decidedByName: string | null;
  expiresAt: Date;
}

/** Цель правки для панели: что стоит в коде, что действует сейчас и менялось ли. */
export interface ChangeTargetView {
  target: string;
  title: string;
  current: JsonValue;
  inCode: JsonValue;
  overridden: boolean;
}

export interface ChangeOverview {
  requests: ChangeRequestView[];
  /** цели правки по видам — столько видов, сколько их умеет сервис */
  targets: Partial<Record<ChangeKind, ChangeTargetView[]>>;
  ttlHours: number;
}

/** Тело заявки: вид, цель, правка и причина. Лишнее поле — отказ: `before` сервер берёт сам. */
export const proposeSchema = z
  .object({
    kind: z.enum(CHANGE_KINDS),
    target: z.string().min(1).max(TARGET_MAX),
    after: z.record(z.string(), z.unknown()),
    reason: z.string().trim().min(1).max(REASON_MAX),
  })
  .strict();

export type ProposeInput = z.infer<typeof proposeSchema>;
