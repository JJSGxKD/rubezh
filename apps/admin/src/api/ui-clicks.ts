import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";
import { FLAG_PLATFORMS } from "./flags";
import type { Period } from "./funnel";

/**
 * Отчёт «Нажатия» (`GET /admin/ui-clicks/screens` и `GET /admin/ui-clicks`,
 * docs/35-stage4-plan.md Р141; tasks/T-0228): на экране — какие кнопки
 * нажимают и какая доля открывших экран нажала каждую. Сервер отдаёт только
 * счётчики: идентификаторов игроков и устройств в ответе нет.
 */

export const uiScreenSchema = z.object({ screen: z.string(), players: z.number(), views: z.number() });
export const uiScreensSchema = z.object({ from: z.string(), to: z.string(), screens: z.array(uiScreenSchema) });

export const uiClickRowSchema = z.object({
  control: z.string(),
  clicks: z.number(),
  players: z.number(),
  /** проценты с десятыми; `null` — экран за период не открывали */
  share: z.number().nullable(),
});
export const uiClicksSchema = z.object({ from: z.string(), to: z.string(), screen: z.string(), opened: z.number(), rows: z.array(uiClickRowSchema) });

export type UiScreen = z.infer<typeof uiScreenSchema>;
export type UiScreens = z.infer<typeof uiScreensSchema>;
export type UiClickRow = z.infer<typeof uiClickRowSchema>;
export type UiClicks = z.infer<typeof uiClicksSchema>;

/** Площадки переключателя; пусто — все. */
export const UI_CLICK_PLATFORMS = FLAG_PLATFORMS;

/** Отчёт не длиннее трёх месяцев — как на сервере. */
export const UI_CLICKS_MAX_DAYS = 92;

export function fetchUiScreens(api: AdminApi, period: Period, platform: string | null): Promise<ApiResult<UiScreens>> {
  return api.request("/ui-clicks/screens", { query: { from: period.from, to: period.to, platform: platform ?? undefined }, schema: uiScreensSchema });
}

export function fetchUiClicks(api: AdminApi, screen: string, period: Period, platform: string | null): Promise<ApiResult<UiClicks>> {
  return api.request("/ui-clicks", { query: { screen, from: period.from, to: period.to, platform: platform ?? undefined }, schema: uiClicksSchema });
}

/** Доля словами: «26,6%», нет открытий — «—». */
export function formatShare(share: number | null): string {
  return share === null ? "—" : `${share.toFixed(1).replace(".", ",")}%`;
}

/** Свой период длиннее предела отчёта — текст ошибки у поля; `null` — годен. */
export function rangeProblem(from: string, to: string): string | null {
  if (from === "" || to === "") return null;
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  return days > UI_CLICKS_MAX_DAYS ? `Не длиннее ${UI_CLICKS_MAX_DAYS} дней` : null;
}
