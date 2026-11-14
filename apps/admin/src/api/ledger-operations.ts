import { z } from "zod";
import type { AdminApi, ApiResult, QueryValue } from "./client";
import { journalPageSchema } from "./ledger";

/**
 * Ручные операции учёта (`/admin/ledger/operations`, `/places`, `/articles`, `/templates/draft-period`;
 * docs/37-accounting.md §4, Р220, Р221, tasks/T-0464). Человек описывает событие, проводку собирает сервер: панель
 * показывает предпросмотр, но суммы не решает — проводится то, что вернул сервер. Суммы — десятичные строки.
 */

export const OPERATION_KINDS = ["transfer", "exchange", "expense", "income", "loan", "reversal"] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export const OPERATION_STATUSES = ["draft", "pending", "posted", "rejected"] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const KIND_LABELS: Readonly<Record<OperationKind, string>> = {
  transfer: "Перевод",
  exchange: "Обмен",
  expense: "Расход",
  income: "Поступление",
  loan: "Заём",
  reversal: "Исправление",
};

export const STATUS_LABELS: Readonly<Record<OperationStatus, string>> = {
  draft: "Черновик",
  pending: "Ждёт подтверждения",
  posted: "Проведена",
  rejected: "Отклонена",
};

export function statusTone(status: OperationStatus): "neutral" | "warning" | "success" | "danger" {
  return status === "draft" ? "neutral" : status === "pending" ? "warning" : status === "posted" ? "success" : "danger";
}

/** Причина или описание операции — пределы те же, что держит сервер. */
export const NOTE_MIN = 3;
export const NOTE_MAX = 500;

const feeInputSchema = z.object({
  amount: z.string().optional(),
  fixed: z.object({ amount: z.string(), currency: z.string(), from: z.string().optional() }).optional(),
});

const receiptInputSchema = z.object({ number: z.string().optional(), link: z.string().optional(), payer: z.enum(["individual", "legal"]) });

/**
 * Ввод человека, как его хранит сервер: поля вида лежат плоско, лишнее для вида отсутствует. Сервер строгий,
 * панель — терпимая: форма правки заполняется из того, что есть.
 */
export const operationInputSchema = z.object({
  kind: z.enum(OPERATION_KINDS),
  note: z.string(),
  at: z.string(),
  link: z.string().optional(),
  receiptImage: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  article: z.string().optional(),
  amount: z.string().optional(),
  given: z.string().optional(),
  received: z.string().optional(),
  forMonth: z.string().optional(),
  lender: z.string().optional(),
  premium: z.string().optional(),
  repaymentBp: z.number().optional(),
  sourceKey: z.string().optional(),
  fee: feeInputSchema.optional(),
  receipt: receiptInputSchema.optional(),
});

export type OperationInput = z.infer<typeof operationInputSchema>;
export type FeeInput = z.infer<typeof feeInputSchema>;

const entrySchema = journalPageSchema.shape.entries.element;

export const operationViewSchema = z.object({
  operationId: z.string(),
  kind: z.enum(OPERATION_KINDS),
  status: z.enum(OPERATION_STATUSES),
  input: operationInputSchema,
  /** оценка размера в долларах на момент ввода; `null` — курса не было */
  amountUsd: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  templateId: z.string().nullable(),
  templatePeriod: z.string().nullable(),
  /** зачисление в рубли без чека НПД (Р221) */
  receiptMissing: z.boolean(),
  entry: entrySchema.nullable(),
  loan: z.object({ loanId: z.string(), lender: z.string(), accountId: z.string(), currency: z.string(), principal: z.string(), premium: z.string(), repaymentBp: z.number() }).nullable(),
});

export const operationPageSchema = z.object({ operations: z.array(operationViewSchema), next: z.string().nullable() });

export type OperationView = z.infer<typeof operationViewSchema>;
export type OperationPage = z.infer<typeof operationPageSchema>;
export type EntryView = z.infer<typeof entrySchema>;

const feeViewSchema = z.object({ percentBp: z.number().nullable(), fixed: z.string().nullable(), fixedCurrency: z.string().nullable() });

const placeSchema = z.object({
  placeId: z.string(),
  name: z.string(),
  currency: z.string(),
  archived: z.boolean(),
  balance: z.string(),
  fee: feeViewSchema.nullable(),
  accounts: z.array(z.object({ accountId: z.string(), name: z.string(), balance: z.string() })),
});

const articleSchema = z.object({ articleId: z.string(), kind: z.enum(["expense", "income"]), name: z.string(), system: z.boolean(), archived: z.boolean() });

export type PlaceView = z.infer<typeof placeSchema>;
export type ArticleView = z.infer<typeof articleSchema>;
export type FeeTemplateView = z.infer<typeof feeViewSchema>;

const draftPeriodSchema = z.object({
  period: z.string(),
  created: z.number(),
  existing: z.number(),
  failed: z.array(z.object({ templateId: z.string(), name: z.string(), reason: z.string() })),
});
export type DraftPeriodResult = z.infer<typeof draftPeriodSchema>;

/** Фильтр списка: статус; пустой не уходит. */
export interface OperationsFilter {
  status?: OperationStatus | "";
}

export function operationsQuery(filter: OperationsFilter, cursor: string | null): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = {};
  if (filter.status !== undefined && filter.status !== "") query.status = filter.status;
  if (cursor !== null) query.cursor = cursor;
  return query;
}

export function loadOperations(api: AdminApi, filter: OperationsFilter, cursor: string | null): Promise<ApiResult<OperationPage>> {
  return api.request("/ledger/operations", { query: operationsQuery(filter, cursor), schema: operationPageSchema });
}

export async function loadPlaces(api: AdminApi): Promise<ApiResult<PlaceView[]>> {
  const result = await api.request("/ledger/places", { schema: z.object({ places: z.array(placeSchema) }) });
  return result.ok ? { ok: true, data: result.data.places } : result;
}

export async function loadArticles(api: AdminApi): Promise<ApiResult<ArticleView[]>> {
  const result = await api.request("/ledger/articles", { schema: z.object({ articles: z.array(articleSchema) }) });
  return result.ok ? { ok: true, data: result.data.articles } : result;
}

const operationEnvelope = z.object({ operation: operationViewSchema });

async function operationOf(result: Promise<ApiResult<z.infer<typeof operationEnvelope>>>): Promise<ApiResult<OperationView>> {
  const answer = await result;
  return answer.ok ? { ok: true, data: answer.data.operation } : answer;
}

/** Черновик: без `id` — новый, с `id` — правка целиком (тело заменяет ввод). */
export function saveOperation(api: AdminApi, input: OperationInput, operationId: string | null): Promise<ApiResult<OperationView>> {
  const path = operationId === null ? "/ledger/operations" : `/ledger/operations/${encodeURIComponent(operationId)}`;
  return operationOf(api.request(path, { method: operationId === null ? "POST" : "PATCH", body: input, schema: operationEnvelope }));
}

/** Провести черновик: сервер сам решает, провести сразу или поставить «на подтверждении». */
export function submitOperation(api: AdminApi, operationId: string): Promise<ApiResult<OperationView>> {
  return operationOf(api.request(`/ledger/operations/${encodeURIComponent(operationId)}/submit`, { method: "POST", schema: operationEnvelope }));
}

export function discardOperation(api: AdminApi, operationId: string): Promise<ApiResult<{ ok: true }>> {
  return api.request(`/ledger/operations/${encodeURIComponent(operationId)}/discard`, { method: "POST", schema: z.object({ ok: z.literal(true) }) });
}

/** Подтвердить: комментарий необязателен. */
export function approveOperation(api: AdminApi, operationId: string, note: string | undefined): Promise<ApiResult<OperationView>> {
  const body = note === undefined || note.trim() === "" ? {} : { note: note.trim() };
  return operationOf(api.request(`/ledger/operations/${encodeURIComponent(operationId)}/approve`, { method: "POST", body, schema: operationEnvelope }));
}

/** Отклонить: причина обязательна. */
export function rejectOperation(api: AdminApi, operationId: string, note: string): Promise<ApiResult<OperationView>> {
  return operationOf(api.request(`/ledger/operations/${encodeURIComponent(operationId)}/reject`, { method: "POST", body: { note: note.trim() }, schema: operationEnvelope }));
}

/** «Расходы месяца»: по шаблонам периода — черновики; повтор дублей не плодит. */
export function draftPeriod(api: AdminApi, period: string): Promise<ApiResult<DraftPeriodResult>> {
  return api.request("/ledger/templates/draft-period", { method: "POST", body: { period }, schema: draftPeriodSchema });
}

/** «Показать ещё»: страница дописывается в конец, повтор по `operationId` отбрасывается (список мог пополниться). */
export function mergeOperations(current: readonly OperationView[], incoming: readonly OperationView[]): OperationView[] {
  const seen = new Set(current.map((item) => item.operationId));
  return [...current, ...incoming.filter((item) => !seen.has(item.operationId))];
}

/** Блок владельца «На подтверждении». */
export function pendingOperations(operations: readonly OperationView[]): OperationView[] {
  return operations.filter((item) => item.status === "pending");
}
