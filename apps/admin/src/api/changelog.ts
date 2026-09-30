import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";
import { FLAG_PLATFORMS } from "./flags";

/**
 * Журнал обновлений (`/admin/changelog`, docs/35-stage4-plan.md WP31): строки
 * «что нового» по версиям с метками площадок. Писать — `changelog.edit`,
 * публиковать версию — `changelog.publish`: публикация раздаёт уведомление
 * всем игрокам площадок версии.
 */

export const CHANGELOG_PLATFORMS = FLAG_PLATFORMS;
export type ChangelogPlatform = (typeof CHANGELOG_PLATFORMS)[number];

export const CHANGELOG_KINDS = ["added", "changed", "fixed"] as const;
export type ChangelogKind = (typeof CHANGELOG_KINDS)[number];

export const KIND_TITLES: Record<ChangelogKind, string> = { added: "Новое", changed: "Изменено", fixed: "Исправлено" };

/** Тот же формат, что проверяет сервер (`changelog-rules.ts`): выпуск без предрелиза и ведущих нулей. */
export const VERSION_PATTERN = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
export const TEXT_MAX = 500;

const entrySchema = z.object({
  entryId: z.string(),
  version: z.string(),
  platforms: z.array(z.enum(CHANGELOG_PLATFORMS)),
  kind: z.enum(CHANGELOG_KINDS),
  text: z.string(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
  /** `pr-<номер>-<строка>` — строку завёл выкат из раздела «Для игроков» PR; сервер старее панели поля не пришлёт */
  sourceKey: z.string().nullable().optional(),
});

const releaseSchema = z.object({
  version: z.string(),
  platforms: z.array(z.enum(CHANGELOG_PLATFORMS)),
  publishedAt: z.string(),
  cursor: z.string().nullable(),
  doneAt: z.string().nullable(),
});

export type ChangelogEntry = z.infer<typeof entrySchema>;
export type ChangelogRelease = z.infer<typeof releaseSchema>;

const listSchema = z.object({ entries: z.array(entrySchema), releases: z.array(releaseSchema) });
const publishSchema = z.object({ published: z.number(), release: releaseSchema.nullable() });

export interface EntryInput {
  /** есть — правка строки */
  entryId?: string;
  version: string;
  kind: ChangelogKind;
  platforms: ChangelogPlatform[];
  text: string;
}

export function fetchChangelog(api: AdminApi): Promise<ApiResult<z.infer<typeof listSchema>>> {
  return api.request("/changelog", { schema: listSchema });
}

export function saveEntry(api: AdminApi, input: EntryInput): Promise<ApiResult<ChangelogEntry>> {
  return api.request("/changelog", {
    method: "POST",
    body: { ...(input.entryId === undefined ? {} : { entryId: input.entryId }), version: input.version.trim(), kind: input.kind, platforms: input.platforms, text: input.text.trim() },
    schema: entrySchema,
  });
}

export function removeEntry(api: AdminApi, entryId: string): Promise<ApiResult<{ removed: boolean }>> {
  return api.request(`/changelog/${encodeURIComponent(entryId)}/remove`, { method: "POST", schema: z.object({ removed: z.boolean() }) });
}

export function publishVersion(api: AdminApi, version: string): Promise<ApiResult<z.infer<typeof publishSchema>>> {
  return api.request("/changelog/publish", { method: "POST", body: { version }, schema: publishSchema });
}

/**
 * Что не так с формой; `null` — можно сохранять. Сервер проверит то же и
 * ещё одно: у опубликованной строки не меняются версия и площадки.
 */
export function entryProblem(input: EntryInput, original: ChangelogEntry | null = null): string | null {
  if (!VERSION_PATTERN.test(input.version.trim())) return "Версия — X.Y.Z без предрелиза, например 0.6.0";
  const text = input.text.trim();
  if (text === "") return "Напишите, что изменилось";
  if (text.length > TEXT_MAX) return `Строка — до ${String(TEXT_MAX)} знаков: одно изменение, а не заметка к релизу`;
  if (original !== null && original.publishedAt !== null && (original.version !== input.version.trim() || !samePlatforms(original.platforms, input.platforms))) {
    return "У опубликованной строки меняются только текст и вид — для другой версии или площадок заведите новую";
  }
  return null;
}

/** Номер PR, из которого строка пришла при выкате; `null` — заведена в панели. */
export function sourcePr(entry: Pick<ChangelogEntry, "sourceKey">): number | null {
  const match = /^pr-(\d+)-\d+$/.exec(entry.sourceKey ?? "");
  return match === null ? null : Number(match[1]);
}

export function platformsLabel(platforms: readonly ChangelogPlatform[]): string {
  return platforms.length === 0 ? "все площадки" : platforms.join(", ");
}

export interface VersionGroup {
  version: string;
  entries: ChangelogEntry[];
  drafts: number;
  release: ChangelogRelease | null;
}

/** Строки по версиям, новые сверху — по числам: `0.10.0` выше `0.9.0`. */
export function groupByVersion(entries: readonly ChangelogEntry[], releases: readonly ChangelogRelease[]): VersionGroup[] {
  const groups = new Map<string, VersionGroup>();
  for (const entry of entries) {
    const group = groups.get(entry.version) ?? { version: entry.version, entries: [], drafts: 0, release: releases.find((release) => release.version === entry.version) ?? null };
    group.entries.push(entry);
    if (entry.publishedAt === null) group.drafts++;
    groups.set(entry.version, group);
  }
  return [...groups.values()].sort((a, b) => compareVersions(b.version, a.version));
}

/** Кому уйдёт уведомление при публикации версии: площадки всех её строк, строка без площадок — всем. */
export function publishAudience(entries: readonly Pick<ChangelogEntry, "platforms">[]): string {
  if (entries.some((entry) => entry.platforms.length === 0)) return "все площадки";
  return CHANGELOG_PLATFORMS.filter((platform) => entries.some((entry) => entry.platforms.includes(platform))).join(", ");
}

/** Состояние раздачи уведомления одной строкой. */
export function releaseState(release: ChangelogRelease | null): string {
  if (release === null) return "не публиковалась";
  return release.doneAt === null ? "уведомление раздаётся" : "уведомление разослано";
}

function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const diff = (x[index] ?? 0) - (y[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function samePlatforms(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((platform) => b.includes(platform));
}
