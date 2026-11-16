import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Месяцы учёта (`/admin/ledger/periods`, tasks/T-0470, Р222; сервер — tasks/T-0468 и T-0469): список, отчёт и чек-лист
 * месяца, сверка, закрытие, снятие закрытия, статус выплат и сама выплата. Суммы — десятичные строки, как их отдаёт
 * сервер: панель ничего не пересчитывает, а показывает то, что вернул сервер.
 */

export const PERIOD_STATUSES = ["open", "review", "closed"] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

export const PERIOD_STATUS_LABELS: Readonly<Record<PeriodStatus, string>> = {
  open: "Открыт",
  review: "На сверке",
  closed: "Закрыт",
};

export function periodTone(status: PeriodStatus): "neutral" | "warning" | "success" {
  return status === "open" ? "neutral" : status === "review" ? "warning" : "success";
}

const periodItemSchema = z.object({
  period: z.string(),
  status: z.enum(PERIOD_STATUSES),
  reopenedCount: z.number(),
  reviewAt: z.string().nullable(),
  closedAt: z.string().nullable(),
});
export type PeriodListItem = z.infer<typeof periodItemSchema>;

const checklistItemSchema = z.object({
  code: z.string(),
  severity: z.enum(["blocker", "warning"]),
  count: z.number(),
  message: z.string(),
  refs: z.array(z.object({ kind: z.enum(["operation", "purchase", "entry", "rate"]), id: z.string() })),
  moreRefs: z.number(),
});
export type ChecklistItem = z.infer<typeof checklistItemSchema>;

const reportLineSchema = z.object({ key: z.string(), name: z.string(), amount: z.string() });
export type ReportLine = z.infer<typeof reportLineSchema>;

const reportSchema = z.object({
  currency: z.literal("USD"),
  rubRate: z.string().nullable(),
  revenue: z.array(reportLineSchema),
  otherIncome: z.array(reportLineSchema),
  expenses: z.array(reportLineSchema),
  grossRevenue: z.string(),
  totalExpenses: z.string(),
  profitBeforeTax: z.string(),
  tax: z.object({
    rub: z.string(),
    usd: z.string(),
    byPayer: z.array(z.object({ payer: z.enum(["individual", "legal"]), receiptsRub: z.string(), ratePercent: z.string(), taxRub: z.string() })),
  }),
  netProfit: z.string(),
  tranches: z.array(z.object({ loanId: z.string(), lender: z.string(), usd: z.string(), inLoanCurrency: z.string(), currency: z.string(), remainingAfterUsd: z.string() })),
  toDistribute: z.string(),
  payouts: z.array(z.object({ accountId: z.string(), name: z.string(), percent: z.string(), usd: z.string(), rub: z.string() })),
  ownerAmount: z.string(),
  noDistribution: z.boolean(),
});
export type ReportView = z.infer<typeof reportSchema>;

export const periodReportSchema = periodItemSchema.extend({
  checklist: z.array(checklistItemSchema),
  /** чек-лист без блокеров, месяц на сверке и отчёт посчитан */
  canClose: z.boolean(),
  /** `true` — отчёт посчитан сейчас, до закрытия; `false` — снимок закрытия */
  reportIsDraft: z.boolean(),
  /** `null` — считать не из чего: нет курса на дату проводки */
  report: reportSchema.nullable(),
});
export type PeriodReportView = z.infer<typeof periodReportSchema>;

const confirmationSchema = z.object({ status: z.enum(["confirmed", "disputed"]), comment: z.string().nullable(), decidedAt: z.string() });

const gateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("free") }),
  z.object({ state: z.literal("wait"), reason: z.string(), until: z.string() }),
  z.object({ state: z.literal("override"), reason: z.string() }),
]);

const participantSchema = z.object({
  accountId: z.string(),
  name: z.string(),
  owedRub: z.string(),
  paidRub: z.string(),
  remainingRub: z.string(),
  confirmation: confirmationSchema.nullable(),
  gate: gateSchema,
  canPay: z.boolean(),
  needsReason: z.boolean(),
  reason: z.string().nullable(),
});
export type ParticipantStatus = z.infer<typeof participantSchema>;

export const payoutStatusSchema = z.object({
  period: z.string(),
  closedAt: z.string(),
  confirmDays: z.number(),
  confirmDeadlineAt: z.string(),
  participants: z.array(participantSchema),
  tax: z.object({ owedRub: z.string(), paidRub: z.string(), remainingRub: z.string() }).nullable(),
  loans: z.array(z.object({ loanId: z.string(), lender: z.string(), currency: z.string(), owed: z.string(), paid: z.string(), remaining: z.string() })),
  owner: z.object({ shareUsd: z.string() }).nullable(),
  payouts: z.array(z.object({ operationId: z.string(), payee: z.string(), currency: z.string(), amount: z.string(), overrideReason: z.string().nullable(), at: z.string() })),
});
export type PayoutStatusView = z.infer<typeof payoutStatusSchema>;
export type PayoutRow = PayoutStatusView["payouts"][number];

const periodPath = (period: string): string => `/ledger/periods/${encodeURIComponent(period)}`;
const okSchema = z.object({ ok: z.literal(true) });

export async function loadPeriods(api: AdminApi): Promise<ApiResult<PeriodListItem[]>> {
  const result = await api.request("/ledger/periods", { schema: z.object({ periods: z.array(periodItemSchema) }) });
  return result.ok ? { ok: true, data: result.data.periods } : result;
}

export async function loadPeriod(api: AdminApi, period: string): Promise<ApiResult<PeriodReportView>> {
  const result = await api.request(periodPath(period), { schema: z.object({ period: periodReportSchema }) });
  return result.ok ? { ok: true, data: result.data.period } : result;
}

export async function loadPayouts(api: AdminApi, period: string): Promise<ApiResult<PayoutStatusView>> {
  const result = await api.request(`${periodPath(period)}/payouts`, { schema: z.object({ status: payoutStatusSchema }) });
  return result.ok ? { ok: true, data: result.data.status } : result;
}

export function startReview(api: AdminApi, period: string): Promise<ApiResult<{ ok: true }>> {
  return api.request(`${periodPath(period)}/review`, { method: "POST", schema: okSchema });
}

export function closePeriod(api: AdminApi, period: string): Promise<ApiResult<{ ok: true }>> {
  return api.request(`${periodPath(period)}/close`, { method: "POST", schema: okSchema });
}

/** Снять закрытие: причина обязательна, сервер проверит, что выплат по месяцу не было. */
export function reopenPeriod(api: AdminApi, period: string, reason: string): Promise<ApiResult<{ ok: true }>> {
  return api.request(`${periodPath(period)}/reopen`, { method: "POST", body: { reason: reason.trim() }, schema: okSchema });
}

/** Тело операции «Выплата»: получатель, месяц отчёта, место, сумма в валюте места и причина решения владельца. */
export interface PayoutBody {
  kind: "payout";
  payee: string;
  period: string;
  from: string;
  amount: string;
  note: string;
  at: string;
  overrideReason?: string;
}

const payoutOperationSchema = z.object({
  operation: z.object({ operationId: z.string(), status: z.enum(["draft", "pending", "posted", "rejected"]) }),
});

export interface PayoutResult {
  operationId: string;
  status: "draft" | "pending" | "posted" | "rejected";
}

/**
 * Выплата — операция вида `payout` (T-0469): черновик и сразу проведение; сервер сам решает, провести ли
 * (владелец) или поставить к владельцу (финансы). Если проведение отказано, черновик убирается — иначе он остался бы
 * в списке операций, откуда его не видно как выплату.
 */
export async function sendPayout(api: AdminApi, body: PayoutBody): Promise<ApiResult<PayoutResult>> {
  const created = await api.request("/ledger/operations", { method: "POST", body, schema: payoutOperationSchema });
  if (!created.ok) return created;
  const { operationId } = created.data.operation;
  const submitted = await api.request(`/ledger/operations/${encodeURIComponent(operationId)}/submit`, { method: "POST", schema: payoutOperationSchema });
  if (!submitted.ok) {
    // Результат уборки не важен: ошибка проведения — то, что нужно показать человеку.
    await api.request(`/ledger/operations/${encodeURIComponent(operationId)}/discard`, { method: "POST", schema: okSchema });
    return submitted;
  }
  return { ok: true, data: { operationId, status: submitted.data.operation.status } };
}
