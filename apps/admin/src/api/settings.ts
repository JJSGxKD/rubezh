import { z } from "zod";
import { formatNumber, plural } from "../format";
import type { AdminApi, ApiResult } from "./client";

/**
 * Настройки без релиза (`/admin/settings`, docs/35-stage4-plan.md §3.18):
 * значение из панели сильнее окружения сервера, сброс возвращает окружение.
 */
const valueSchema = z.union([z.string(), z.boolean(), z.number()]);

/** Пределы и единица числа — сервер проверит те же; формы единицы — для одного, двух и пяти. */
const rangeSchema = z.object({ min: z.number(), max: z.number(), unit: z.tuple([z.string(), z.string(), z.string()]) });

export const settingSchema = z.object({
  key: z.string(),
  group: z.string(),
  title: z.string(),
  hint: z.string(),
  kind: z.enum(["chat", "boolean", "url", "number"]),
  /** сервер до числовых настроек поля не отдавал */
  range: rangeSchema.nullable().optional(),
  value: valueSchema,
  source: z.enum(["base", "env", "default"]),
  envValue: valueSchema.nullable(),
  fallback: valueSchema,
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export type SettingRow = z.infer<typeof settingSchema>;
export type SettingValue = z.infer<typeof valueSchema>;
export type SettingRange = z.infer<typeof rangeSchema>;

/** Что нужно о настройке, чтобы проверить и прочитать её значение. */
export type SettingShape = Pick<SettingRow, "kind" | "range">;
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

/** Ссылка — только https, до 256 знаков; пусто — «не задана». */
export const URL_MAX = 256;

/**
 * Число из поля ввода: только целое, без пробелов и знаков после запятой;
 * иначе `null`. `Number("")` дал бы ноль, а пустое поле — не ноль.
 */
export function parseInteger(text: string): number | null {
  const trimmed = text.trim();
  return /^-?\d{1,9}$/.test(trimmed) ? Number(trimmed) : null;
}

/** Что не так со значением; `null` — можно сохранять. Сервер проверит то же самое. */
export function settingProblem({ kind, range }: SettingShape, value: SettingValue): string | null {
  const text = String(value).trim();
  if (kind === "number") {
    const number = typeof value === "number" ? value : parseInteger(text);
    if (number === null || !Number.isInteger(number)) return "Целое число";
    if (range === null || range === undefined) return null;
    return number < range.min || number > range.max ? `От ${String(range.min)} до ${String(range.max)}` : null;
  }
  if (kind === "url") {
    const valid = text === "" || (text.length <= URL_MAX && URL.canParse(text) && new URL(text).protocol === "https:");
    return valid ? null : `Ссылка — https://…, до ${String(URL_MAX)} знаков, или пусто`;
  }
  if (kind !== "chat") return null;
  return text === "" || CHAT_TARGET.test(text) ? null : "Адрес — id чата или id:тема, например -1001234567890:57";
}

/** Подсказка в поле ввода по виду настройки. */
export const SETTING_PLACEHOLDER: Record<Exclude<SettingRow["kind"], "boolean">, string> = { chat: "-1001234567890:57", url: "https://t.me/…", number: "" };

export const SOURCE_TITLES: Record<SettingRow["source"], string> = { base: "панель", env: "окружение", default: "умолчание" };

/**
 * Значение для человека: пустой адрес чата — это «не задан», а не пустая
 * строка; число — с единицей: «3 минуты», «24 часа».
 */
export function settingText({ kind, range }: SettingShape, value: SettingValue | null): string {
  if (value === null) return "—";
  if (kind === "boolean") return value === true ? "включено" : "выключено";
  if (typeof value === "number") return range === null || range === undefined ? formatNumber(value) : `${formatNumber(value)} ${plural(value, range.unit)}`;
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
