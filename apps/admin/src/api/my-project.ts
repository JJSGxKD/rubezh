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
