import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";
import type { Period } from "./funnel";

/**
 * Выгрузки данных (`/admin/exports`, docs/28-diagnostics.md §6): журнал и
 * сборка архива тем же сервисом, что у бота. Архив собирается синхронно в
 * ответе — ждать приходится дольше обычного запроса.
 */
const exportRowSchema = z.object({
  exportId: z.string(),
  source: z.string(),
  requestedBy: z.string(),
  period: z.object({ from: z.string().nullable(), to: z.string() }),
  status: z.string(),
  events: z.number(),
  reports: z.number(),
  sizeBytes: z.number(),
  parts: z.number(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});

export type ExportRow = z.infer<typeof exportRowSchema>;

/** Сборка за большой период — минуты, а не секунды. */
export const EXPORT_TIMEOUT_MS = 10 * 60_000;

export const EXPORT_SOURCES: Record<string, string> = { bot: "бот", cli: "консоль", panel: "панель" };
export const EXPORT_STATUSES: Record<string, string> = { running: "собирается", sent: "отдан", failed: "сбой" };

export function fetchExports(api: AdminApi): Promise<ApiResult<{ exports: ExportRow[] }>> {
  return api.request("/exports", { query: { limit: 50 }, schema: z.object({ exports: z.array(exportRowSchema) }) });
}

export function buildExport(api: AdminApi, period: Period): Promise<ApiResult<{ blob: Blob; fileName: string }>> {
  return api.download("/exports", { from: period.from, to: period.to }, EXPORT_TIMEOUT_MS);
}
