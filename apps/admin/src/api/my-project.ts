import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Кабинет «Мой проект» (`/admin/my-project`, docs/35-stage4-plan.md Р218, tasks/T-0453).
 * Схема повторяет `MyProjectView` сервера. Денежные суммы приходят строками «123.45» (без потери
 * точности), `null` — курса нет.
 */
const moneySchema = z.string().nullable();

export const myProjectSchema = z.object({
  /** `ГГГГ-ММ` */
  month: z.string(),
  /** от первого месяца оплат до текущего, новые сверху */
  months: z.array(z.string()),
  viewer: z.object({
    role: z.enum(["stakeholder", "owner", "finance"]),
    sharePercent: z.number().nullable(),
    shareFrom: z.string().nullable(),
  }),
  participants: z.array(z.object({ name: z.string(), sharePercent: z.number(), me: z.boolean() })),
  ownerSharePercent: z.number(),
  rates: z.object({ starUsd: z.string(), usdRub: z.string(), at: z.string() }).nullable(),
  project: z.object({
    revenue: z.object({
      stars: z.object({ paid: z.number(), refunded: z.number(), net: z.number() }),
      byPlatform: z.array(z.object({ platform: z.enum(["telegram", "max", "vk", "web"]), net: z.number() })),
      bySource: z.array(z.object({ source: z.enum(["shop", "continue", "vip", "donation"]), net: z.number() })),
      usd: moneySchema,
      rub: moneySchema,
    }),
    hold: z.object({ days: z.number(), inHoldStars: z.number(), releasedStars: z.number(), nextReleaseAt: z.string().nullable() }),
    draft: z.object({ sharePercent: z.number(), usd: moneySchema, rub: moneySchema, stars: z.number() }).nullable(),
  }),
});

export type MyProject = z.infer<typeof myProjectSchema>;

export function loadMyProject(api: AdminApi, month?: string): Promise<ApiResult<MyProject>> {
  const query = month === undefined ? "" : `?month=${encodeURIComponent(month)}`;
  return api.request(`/my-project${query}`, { schema: myProjectSchema });
}

const MONTH_NOMINATIVE = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"] as const;

/** `2026-11` → «ноябрь 2026»: подпись в переключателе месяцев. */
export function monthTitle(month: string): string {
  const [year = "", mm = "1"] = month.split("-");
  return `${MONTH_NOMINATIVE[Number(mm) - 1] ?? mm} ${year}`;
}

const MONEY = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** «11651.64» → «11 651,64 ₽». Сумма — строка сервера, разряды разбираются без Number только при сомнении. */
export function moneyLine(amount: string, symbol: "$" | "₽"): string {
  const value = Number(amount);
  return `${Number.isFinite(value) ? MONEY.format(value) : amount} ${symbol}`;
}

/**
 * Отчёт закрытого месяца и решение участника (Р222, tasks/T-0469): `GET /my-project/periods/:p` и
 * `POST /my-project/periods/:p/confirm`. Схема повторяет `MyReportView` сервера; суммы — десятичные строки, считать их
 * в панели нельзя: всё, что видит участник, приходит готовым из снимка закрытия.
 */
const reportLineSchema = z.object({ key: z.string(), name: z.string(), amount: z.string() });

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

export const myReportSchema = z.object({
  period: z.string(),
  closedAt: z.string(),
  deadlineAt: z.string(),
  report: reportSchema,
  mine: z.object({
    accountId: z.string(),
    name: z.string(),
    owedRub: z.string(),
    paidRub: z.string(),
    remainingRub: z.string(),
    confirmation: z.object({ status: z.enum(["confirmed", "disputed"]), comment: z.string().nullable(), decidedAt: z.string() }).nullable(),
    /** выплат ещё не было: решение можно поменять */
    canChange: z.boolean(),
  }),
});

export type MyReport = z.infer<typeof myReportSchema>;
export type MyDecision = "confirmed" | "disputed";

/** Границы комментария к спору — те же, что на сервере (`COMMENT_MIN`, `COMMENT_MAX` в payouts.service). */
export const DISPUTE_MIN = 3;
export const DISPUTE_MAX = 1_000;

/** Что не так с комментарием спора; `null` — можно отправлять. Без комментария спор не уходит. */
export function disputeProblem(comment: string): string | null {
  const length = comment.trim().length;
  if (length < DISPUTE_MIN) return `Напишите, что не сходится: от ${DISPUTE_MIN} знаков`;
  if (length > DISPUTE_MAX) return `Комментарий длиннее ${DISPUTE_MAX} знаков`;
  return null;
}

export function loadMyReport(api: AdminApi, period: string): Promise<ApiResult<MyReport>> {
  return api.request(`/my-project/periods/${encodeURIComponent(period)}`, { schema: myReportSchema });
}

export function decideMyReport(api: AdminApi, period: string, decision: MyDecision, comment?: string): Promise<ApiResult<MyReport>> {
  return api.request(`/my-project/periods/${encodeURIComponent(period)}/confirm`, {
    method: "POST",
    body: decision === "disputed" ? { decision, comment: (comment ?? "").trim() } : { decision },
    schema: myReportSchema,
  });
}

/** Статус отчёта для участника: подпись сверху и метка в списке месяцев. */
export type ReportStatus = "waiting" | "confirmed" | "disputed" | "paid";

export function reportStatus(report: MyReport): ReportStatus {
  const { mine } = report;
  if (!mine.canChange) return "paid";
  if (mine.confirmation === null) return "waiting";
  return mine.confirmation.status;
}
