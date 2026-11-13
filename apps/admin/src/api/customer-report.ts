import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Отчёт заказчику партнёрских заданий (`/admin/customer-report`,
 * docs/35-stage4-plan.md Р140, tasks/T-0225): по дням и заданиям — показы,
 * нажатия, выполнения, удержание на 1-й, 3-й и 7-й день и сумма к оплате.
 * Ответ — одни счётчики, игроков в нём нет; CSV собирается здесь же из того
 * же ответа, чтобы файл и экран не разошлись.
 */

/** Столько суток отчёт не превышает: так же режет сервер. */
export const REPORT_MAX_DAYS = 92;
const DAY_MS = 86_400_000;

const cellSchema = z.object({ kept: z.number(), pending: z.number(), unknown: z.number() });
const retentionSchema = z.object({ d1: cellSchema, d3: cellSchema, d7: cellSchema });

const rowSchema = z.object({
  day: z.string(),
  taskId: z.string(),
  title: z.string(),
  payModel: z.enum(["cpa", "rs"]),
  shown: z.number(),
  opened: z.number(),
  completed: z.number(),
  retention: retentionSchema,
  paid: z.number().nullable(),
  amountCents: z.number().nullable(),
});

const reportSchema = z.object({
  customer: z.string(),
  from: z.string(),
  to: z.string(),
  rows: z.array(rowSchema),
  totals: z.object({
    shown: z.number(),
    opened: z.number(),
    completed: z.number(),
    retention: retentionSchema,
    paid: z.number(),
    amountCents: z.number(),
    hasRevenueShare: z.boolean(),
  }),
  conversions: z.object({ opened: z.number().nullable(), completed: z.number().nullable(), keptD7: z.number().nullable() }),
});
export type CustomerReport = z.infer<typeof reportSchema>;
export type ReportRow = z.infer<typeof rowSchema>;
export type RetentionCell = z.infer<typeof cellSchema>;

export async function fetchCustomers(api: AdminApi): Promise<ApiResult<string[]>> {
  const result = await api.request("/customer-report/customers", { schema: z.object({ customers: z.array(z.string()) }) });
  return result.ok ? { ok: true, data: result.data.customers } : result;
}

export function fetchCustomerReport(api: AdminApi, customer: string, from: string, to: string): Promise<ApiResult<CustomerReport>> {
  return api.request("/customer-report", { query: { customer, from, to }, schema: reportSchema });
}

/** Ошибка выбранного периода у поля; `null` — годен. Сервер проверит то же самое сам. */
export function reportPeriodProblem(from: string, to: string): string | null {
  if (from === "" || to === "") return "Укажите обе даты";
  if (from > to) return "Дата «С» позже даты «По»";
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
  return days > REPORT_MAX_DAYS ? `Не длиннее ${String(REPORT_MAX_DAYS)} дней` : null;
}

/** `2026-10-24` → `24.10.2026`: так дату читает Excel с русской локалью. */
export function csvDate(day: string): string {
  const [year, month, date] = day.split("-");
  return `${date ?? ""}.${month ?? ""}.${year ?? ""}`;
}

/** Центы долларов — «244,00»: два знака, запятая, без разделителя тысяч (в CSV он ломает число). */
export function formatCents(cents: number): string {
  const whole = Math.floor(cents / 100);
  return `${String(whole)},${String(cents - whole * 100).padStart(2, "0")}`;
}

/** Доля 0…1 процентами с одним знаком: «14,9%»; нет знаменателя — «—». */
export function formatPercent(value: number | null): string {
  if (value === null) return "—";
  const text = (value * 100).toFixed(1).replace(/\.0$/, "").replace(".", ",");
  return `${text}%`;
}

export type RetentionView = { kind: "early" } | { kind: "unknown" } | { kind: "count"; kept: number; pending: number };

/**
 * Как показать удержание: «ещё рано» — ни одна отметка ещё не наступила,
 * «неизвестно» — ни одна не придёт (площадка не отвечала или окна нет),
 * иначе — число оставшихся и сколько отметок ещё ждут.
 */
export function retentionText(cell: RetentionCell, completed: number): RetentionView {
  if (completed > 0 && cell.pending === completed) return { kind: "early" };
  if (completed > 0 && cell.unknown === completed) return { kind: "unknown" };
  return { kind: "count", kept: cell.kept, pending: cell.pending };
}

const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** Имя файла: `report-<заказчик латиницей>-<с>-<по>.csv`; из одних знаков без букв — `customer`. */
export function reportFileName(report: Pick<CustomerReport, "customer" | "from" | "to">): string {
  const latin = [...report.customer.toLowerCase()].map((char) => CYRILLIC[char] ?? char).join("");
  const slug = latin.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return `report-${slug === "" ? "customer" : slug}-${report.from}-${report.to}.csv`;
}

/** Поле CSV: формулу Excel обезвреживает апостроф, а `;`, кавычки и переносы — кавычки. */
function field(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const REVENUE_SHARE_TEXT = "по отчёту заказчика";

function retentionField(cell: RetentionCell, completed: number): string {
  const view = retentionText(cell, completed);
  if (view.kind === "early") return "";
  return view.kind === "unknown" ? "неизвестно" : String(view.kept);
}

/**
 * CSV для Excel с русской локалью без настроек: UTF-8 с BOM, разделитель
 * «;», строки через CRLF, даты `ДД.ММ.ГГГГ`, деньги с запятой. «Ещё рано» —
 * пустая ячейка, «неизвестно» — словом. У доли дохода сумма — «по отчёту
 * заказчика»: долю считает заказчик по своей выручке.
 */
export function reportCsv(report: CustomerReport): string {
  const header = ["день", "задание", "показы", "нажатия", "выполнения", "остались на 1-й день", "остались на 3-й день", "остались на 7-й день", "к оплате, $"];
  const lines = [header.map(field).join(";")];
  for (const row of report.rows) {
    const pay = row.amountCents === null ? REVENUE_SHARE_TEXT : formatCents(row.amountCents);
    lines.push(
      [
        csvDate(row.day),
        row.title,
        row.shown,
        row.opened,
        row.completed,
        retentionField(row.retention.d1, row.completed),
        retentionField(row.retention.d3, row.completed),
        retentionField(row.retention.d7, row.completed),
        pay,
      ]
        .map(field)
        .join(";"),
    );
  }
  const { totals } = report;
  const cpa = formatCents(totals.amountCents);
  const totalPay = !totals.hasRevenueShare ? cpa : totals.amountCents === 0 ? REVENUE_SHARE_TEXT : `${cpa} + ${REVENUE_SHARE_TEXT}`;
  lines.push(
    [
      "Всего",
      "",
      totals.shown,
      totals.opened,
      totals.completed,
      retentionField(totals.retention.d1, totals.completed),
      retentionField(totals.retention.d3, totals.completed),
      retentionField(totals.retention.d7, totals.completed),
      totalPay,
    ]
      .map(field)
      .join(";"),
  );
  return `﻿${lines.join("\r\n")}`;
}
