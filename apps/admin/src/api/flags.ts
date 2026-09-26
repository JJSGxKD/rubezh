import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/** Флаги и выкат (`/admin/flags`, docs/29-admin-panel.md §2). */
export const FLAG_PLATFORMS = ["telegram", "max", "vk", "web"] as const;

export const flagSchema = z.object({
  key: z.string(),
  enabled: z.boolean(),
  platforms: z.array(z.enum(FLAG_PLATFORMS)),
  percent: z.number(),
  note: z.string().nullable(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string(),
});

export type FlagRow = z.infer<typeof flagSchema>;

export interface FlagInput {
  key: string;
  enabled: boolean;
  platforms: (typeof FLAG_PLATFORMS)[number][];
  percent: number;
  note: string;
}

/** Тот же формат, что проверяет сервер: ключ читает игра, поэтому он неизменен и без пробелов. */
export const FLAG_KEY = /^[a-z][a-z0-9_.-]{1,63}$/;

export function fetchFlags(api: AdminApi): Promise<ApiResult<{ flags: FlagRow[] }>> {
  return api.request("/flags", { schema: z.object({ flags: z.array(flagSchema) }) });
}

export function saveFlag(api: AdminApi, input: FlagInput): Promise<ApiResult<FlagRow>> {
  const note = input.note.trim();
  return api.request("/flags", {
    method: "POST",
    body: { key: input.key, enabled: input.enabled, platforms: input.platforms, percent: input.percent, ...(note === "" ? {} : { note }) },
    schema: flagSchema,
  });
}

export function removeFlag(api: AdminApi, key: string): Promise<ApiResult<{ removed: boolean }>> {
  return api.request(`/flags/${encodeURIComponent(key)}/remove`, { method: "POST", schema: z.object({ removed: z.boolean() }) });
}

/** Что не так с формой; `null` — можно сохранять. Сервер проверит то же самое. */
export function flagProblem(input: FlagInput): string | null {
  if (!FLAG_KEY.test(input.key)) return "Ключ — латиница в нижнем регистре, цифры, точка, дефис; от 2 до 64 знаков";
  if (!Number.isInteger(input.percent) || input.percent < 0 || input.percent > 100) return "Доля — целое число от 0 до 100";
  if (input.note.trim().length > 200) return "Заметка — до 200 знаков";
  return null;
}

/** Кому флаг включён сейчас, одной строкой для таблицы. */
export function flagReach(flag: Pick<FlagRow, "enabled" | "platforms" | "percent">): string {
  if (!flag.enabled || flag.percent === 0) return "никому";
  const where = flag.platforms.length === 0 ? "все площадки" : flag.platforms.join(", ");
  return flag.percent === 100 ? where : `${where}, ${flag.percent}% игроков`;
}
