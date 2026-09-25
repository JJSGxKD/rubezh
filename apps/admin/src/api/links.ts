import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/** Ссылки кампаний (`/admin/links`, docs/24-attribution-and-sharing.md §3). */
export const linkSchema = z.object({
  code: z.string(),
  url: z.string(),
  platform: z.string(),
  campaign: z.string(),
  source: z.string().nullable(),
  medium: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
});

export const linkStatsSchema = linkSchema.extend({ clicks: z.number(), clicks30d: z.number(), launches: z.number() });

export type LinkRow = z.infer<typeof linkStatsSchema>;

export interface NewLink {
  campaign: string;
  source?: string;
  medium?: string;
  note?: string;
}

/** Тот же формат, что проверяет сервер: кампания и источник уходят в разрезы аналитики. */
export const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function fetchLinks(api: AdminApi): Promise<ApiResult<{ links: LinkRow[] }>> {
  return api.request("/links", { schema: z.object({ links: z.array(linkStatsSchema) }) });
}

export function createLink(api: AdminApi, input: NewLink): Promise<ApiResult<z.infer<typeof linkSchema>>> {
  return api.request("/links", { method: "POST", body: input, schema: linkSchema });
}

/** Доля запусков от кликов, целыми процентами; без кликов — `null`. */
export function conversion(row: Pick<LinkRow, "clicks" | "launches">): number | null {
  return row.clicks === 0 ? null : Math.round((row.launches / row.clicks) * 100);
}
