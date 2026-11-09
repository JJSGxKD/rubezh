import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Онлайн по площадкам для панели (`GET /admin/online`, Р107, T-0147/T-0148):
 * без порогов показа, которые сервер применяет игроку, и с рекордом. Сервер
 * считает числа заданием раз в минуту; панель только читает.
 */

export const ONLINE_PLATFORMS = ["telegram", "max", "vk", "web"] as const;

export type OnlinePlatform = (typeof ONLINE_PLATFORMS)[number];

export const ONLINE_PLATFORM_TITLES: Record<OnlinePlatform, string> = { telegram: "Telegram", max: "MAX", vk: "VK", web: "Браузер" };

/** Как часто экран просит свежие числа, пока открыт. */
export const ONLINE_REFRESH_MS = 15_000;

const countsSchema = z.object({
  /** в приложении сейчас */
  app: z.number(),
  /** из них в забеге */
  run: z.number(),
  /** играли за игровые сутки */
  today: z.number(),
});

export type OnlineCounts = z.infer<typeof countsSchema>;

export const onlineSnapshotSchema = z.object({
  // Площадка, которой панель не знает (сервер новее), не роняет экран: её строка пропускается.
  byPlatform: z.record(z.string(), countsSchema),
  total: countsSchema,
  peak: z.nullable(z.object({ value: z.number(), at: z.number() })),
  /** момент последнего пересчёта, мс; 0 — пересчёта ещё не было */
  at: z.number(),
});

export type OnlineSnapshot = z.infer<typeof onlineSnapshotSchema>;

export function fetchOnline(api: AdminApi): Promise<ApiResult<OnlineSnapshot>> {
  return api.request("/online", { schema: onlineSnapshotSchema });
}

export interface OnlineRow {
  platform: OnlinePlatform;
  title: string;
  counts: OnlineCounts;
}

/** Строки таблицы в порядке площадок; не пришедшая площадка — нули, а не пропуск строки. */
export function onlineRows(snapshot: OnlineSnapshot): OnlineRow[] {
  return ONLINE_PLATFORMS.map((platform) => ({
    platform,
    title: ONLINE_PLATFORM_TITLES[platform],
    counts: snapshot.byPlatform[platform] ?? { app: 0, run: 0, today: 0 },
  }));
}

/** Пересчёта ещё не было (сервер только поднялся или Redis недоступен): числа нулевые не потому, что никого нет. */
export function hasCounted(snapshot: OnlineSnapshot): boolean {
  return snapshot.at > 0;
}
