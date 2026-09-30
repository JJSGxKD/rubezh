import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { useBadges } from "./badges";
import { useShell } from "./shell";

/**
 * Журнал обновлений с сервера (docs/35-stage4-plan.md Р61, WP31): версии
 * площадки игрока новыми сверху, по курсору. Площадку сервер берёт из
 * токена, клиент её не называет. Вид строки — строкой: сервер новее клиента
 * пришлёт вид, которого экран не знает, и журнал не должен от этого падать.
 *
 * Модуль грузится вместе с экраном журнала — первой загрузке он не нужен.
 */

const entrySchema = z.object({ id: z.string(), kind: z.string(), text: z.string() });
const versionSchema = z.object({ version: z.string(), publishedAt: z.string(), fresh: z.boolean(), entries: z.array(entrySchema) });
const pageSchema = z.object({ versions: z.array(versionSchema), nextCursor: z.nullable(z.string()), latestAt: z.nullable(z.string()) });
const seenSchema = z.object({ badge: z.number() });

export type ChangelogVersion = z.infer<typeof versionSchema>;
export type ChangelogPage = z.infer<typeof pageSchema>;

export interface ChangelogApi {
  page(cursor: string | null): Promise<ApiResult<ChangelogPage>>;
  seen(upTo: string): Promise<ApiResult<{ badge: number }>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createChangelogApi(request: ApiRequest = apiRequest): ChangelogApi {
  return {
    page: (cursor) => request(`/api/v1/changelog${cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`, pageSchema, { method: "GET" }),
    seen: (upTo) => request("/api/v1/changelog/seen", seenSchema, { method: "POST", body: { upTo } }),
  };
}

/** Журнал — только с входом: площадку и «открывал» знает аккаунт. */
export function changelogAvailable(): boolean {
  return useShell.getState().capabilities.auth !== undefined;
}

/**
 * Журнал открыт — прочитано всё не новее самой поздней публикации из ответа,
 * который игрок видел: версия, вышедшая, пока журнал открыт, останется новой.
 * Знак меню гаснет по ответу сервера, а не наугад.
 */
export async function markChangelogSeen(page: ChangelogPage, api: ChangelogApi): Promise<void> {
  if (page.latestAt === null) return;
  const response = await api.seen(page.latestAt);
  if (response.ok) useBadges.setState({ changelog: response.data.badge });
}

/** Порядок видов внутри версии — как на сервере; незнакомый вид — в конце. */
export const CHANGELOG_KIND_ORDER = ["added", "changed", "fixed"] as const;

/** Строки версии по видам в порядке показа; пустые виды пропускаются. */
export function entriesByKind(version: ChangelogVersion): { kind: string; texts: { id: string; text: string }[] }[] {
  const kinds = [...CHANGELOG_KIND_ORDER, ...new Set(version.entries.map((entry) => entry.kind).filter((kind) => !(CHANGELOG_KIND_ORDER as readonly string[]).includes(kind)))];
  return kinds
    .map((kind) => ({ kind, texts: version.entries.filter((entry) => entry.kind === kind).map((entry) => ({ id: entry.id, text: entry.text })) }))
    .filter((group) => group.texts.length > 0);
}
