import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Отчёты диагностики (`/admin/diagnostics/reports`, docs/28-diagnostics.md):
 * стресс-тесты и записи забегов с устройств. Список — без тяжёлого `payload`,
 * отчёт целиком — отдельным запросом. Telegram ID тестера сервер отдаёт только
 * с правом на персональные данные.
 */
const reportRowSchema = z.object({
  reportId: z.string(),
  kind: z.string(),
  appVersion: z.string(),
  contentHash: z.string().nullable(),
  platform: z.string(),
  platformUserId: z.string().nullable(),
  device: z.unknown(),
  summary: z.unknown(),
  sizeBytes: z.number(),
  occurredAt: z.string(),
  receivedAt: z.string(),
});

export const reportSchema = reportRowSchema.extend({ schemaVersion: z.string().optional(), installId: z.string().optional(), payload: z.unknown() });

export type ReportRow = z.infer<typeof reportRowSchema>;
export type Report = z.infer<typeof reportSchema>;

export interface ReportFilter {
  kind?: "bench" | "run";
  platform?: string;
  appVersion?: string;
  /** курсор «раньше»: `receivedAt` последней строки предыдущей страницы */
  before?: string;
}

export const REPORTS_PAGE = 50;

export function fetchReports(api: AdminApi, filter: ReportFilter): Promise<ApiResult<{ reports: ReportRow[] }>> {
  return api.request("/diagnostics/reports", { query: { ...filter, limit: REPORTS_PAGE }, schema: z.object({ reports: z.array(reportRowSchema) }) });
}

export function fetchReport(api: AdminApi, reportId: string): Promise<ApiResult<Report>> {
  return api.request(`/diagnostics/reports/${encodeURIComponent(reportId)}`, { schema: reportSchema });
}

/** Отчёт целиком на экране — до этого предела; дальше — скачать JSON: тысячи строк браузер рисует, но читать их нельзя. */
export const REPORT_SHOWN_CHARS = 100_000;

export function prettyJson(value: unknown): { text: string; truncated: boolean } {
  const text = JSON.stringify(value, null, 2) ?? "null";
  return text.length > REPORT_SHOWN_CHARS ? { text: text.slice(0, REPORT_SHOWN_CHARS), truncated: true } : { text, truncated: false };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}
