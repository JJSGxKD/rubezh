import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Настройки без релиза (`/admin/settings`, docs/35-stage4-plan.md §3.18):
 * значение из панели сильнее окружения сервера, сброс возвращает окружение.
 */
const valueSchema = z.union([z.string(), z.boolean()]);

export const settingSchema = z.object({
  key: z.string(),
  group: z.string(),
  title: z.string(),
  hint: z.string(),
  kind: z.enum(["chat", "boolean"]),
  value: valueSchema,
  source: z.enum(["base", "env", "default"]),
  envValue: valueSchema.nullable(),
  fallback: valueSchema,
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export type SettingRow = z.infer<typeof settingSchema>;
export type SettingValue = z.infer<typeof valueSchema>;

export function fetchSettings(api: AdminApi): Promise<ApiResult<{ settings: SettingRow[] }>> {
  return api.request("/settings", { schema: z.object({ settings: z.array(settingSchema) }) });
}

export function saveSetting(api: AdminApi, key: string, value: SettingValue): Promise<ApiResult<SettingRow>> {
  return api.request(`/settings/${encodeURIComponent(key)}`, { method: "POST", body: { value: typeof value === "string" ? value.trim() : value }, schema: settingSchema });
}

export function resetSetting(api: AdminApi, key: string): Promise<ApiResult<SettingRow>> {
  return api.request(`/settings/${encodeURIComponent(key)}/reset`, { method: "POST", schema: settingSchema });
}

/** Тот же формат, что проверяет сервер: `-1001234567890` или `-1001234567890:57`. */
const CHAT_TARGET = /^-?\d{1,20}(?::\d{1,10})?$/;

/** Что не так со значением; `null` — можно сохранять. Сервер проверит то же самое. */
export function settingProblem(kind: SettingRow["kind"], value: SettingValue): string | null {
  if (kind !== "chat") return null;
  const text = String(value).trim();
  return text === "" || CHAT_TARGET.test(text) ? null : "Адрес — id чата или id:тема, например -1001234567890:57";
}

export const SOURCE_TITLES: Record<SettingRow["source"], string> = { base: "панель", env: "окружение", default: "умолчание" };

/** Значение для человека: пустой адрес чата — это «не задан», а не пустая строка. */
export function settingText(kind: SettingRow["kind"], value: SettingValue | null): string {
  if (value === null) return "—";
  if (kind === "boolean") return value === true ? "включено" : "выключено";
  return value === "" ? "не задан" : String(value);
}

/** Настройки по разделам в порядке каталога. */
export function groupSettings(rows: readonly SettingRow[]): { group: string; rows: SettingRow[] }[] {
  const groups: { group: string; rows: SettingRow[] }[] = [];
  for (const row of rows) {
    const found = groups.find((item) => item.group === row.group);
    if (found === undefined) groups.push({ group: row.group, rows: [row] });
    else found.rows.push(row);
  }
  return groups;
}
