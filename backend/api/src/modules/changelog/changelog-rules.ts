import type { PlatformId } from "../../platforms/ports/platform.js";

/**
 * Журнал обновлений (docs/35-stage4-plan.md Р61, WP31): что игрок видит и в
 * каком порядке. Здесь — чистые правила без базы: отбор записей площадки,
 * сборка по версиям, порядок и курсор, что считать новым. Их проверяют
 * юнит-тесты, а сервис только подаёт им записи из кеша.
 */

export const CHANGELOG_KINDS = ["added", "changed", "fixed"] as const;

export type ChangelogKind = (typeof CHANGELOG_KINDS)[number];

/** Строка журнала — одно изменение, а не заметка к релизу. */
export const CHANGELOG_TEXT_MAX = 500;

/** Версий на страницу у клиента: в одной версии бывает десяток строк. */
export const CHANGELOG_PAGE_DEFAULT = 5;
export const CHANGELOG_PAGE_MAX = 20;

/**
 * Версия игрока — `X.Y.Z` без предрелиза: игрок видит выпуски, а не `rc`.
 * Числа — без ведущих нулей, чтобы `0.6.0` и `0.06.0` не стали двумя версиями.
 */
export const VERSION_PATTERN = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(value: string): Version | null {
  const match = VERSION_PATTERN.exec(value);
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Больше нуля — `a` новее. Невалидная версия старше любой валидной: её не бывает в базе, но и падать не из-за чего. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return (left === null ? 0 : 1) - (right === null ? 0 : 1);
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/** Опубликованная запись — то, из чего собирается журнал игрока. */
export interface PublishedEntry {
  entryId: string;
  version: string;
  /** пусто — все площадки */
  platforms: readonly PlatformId[];
  kind: ChangelogKind;
  text: string;
  publishedAt: Date;
  createdAt: Date;
}

export interface ChangelogVersionView {
  version: string;
  /** когда версия вышла на этой площадке — первая публикация её строк */
  publishedAt: string;
  /** есть строки, опубликованные после того, как игрок последний раз открывал журнал */
  fresh: boolean;
  entries: { id: string; kind: ChangelogKind; text: string }[];
}

export interface ChangelogPage {
  versions: ChangelogVersionView[];
  /** версия, после которой продолжать; `null` — дальше пусто */
  nextCursor: string | null;
  /** самая поздняя публикация на площадке — её клиент присылает, отмечая журнал прочитанным */
  latestAt: string | null;
}

export function visibleOn(entry: Pick<PublishedEntry, "platforms">, platform: PlatformId): boolean {
  return entry.platforms.length === 0 || entry.platforms.includes(platform);
}

const KIND_ORDER: Record<ChangelogKind, number> = { added: 0, changed: 1, fixed: 2 };

interface Grouped {
  version: string;
  entries: PublishedEntry[];
  firstAt: number;
  lastAt: number;
}

/**
 * Версии площадки новыми сверху; внутри версии — новое, изменённое,
 * исправленное, в порядке заведения. Версия без строк для площадки игроку не
 * показывается: строк нет — нет и версии.
 */
export function versionsFor(entries: readonly PublishedEntry[], platform: PlatformId): Grouped[] {
  const byVersion = new Map<string, Grouped>();
  for (const entry of entries) {
    if (!visibleOn(entry, platform)) continue;
    const at = entry.publishedAt.getTime();
    const group = byVersion.get(entry.version);
    if (group === undefined) {
      byVersion.set(entry.version, { version: entry.version, entries: [entry], firstAt: at, lastAt: at });
      continue;
    }
    group.entries.push(entry);
    group.firstAt = Math.min(group.firstAt, at);
    group.lastAt = Math.max(group.lastAt, at);
  }
  const groups = [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version));
  for (const group of groups) {
    group.entries.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.createdAt.getTime() - b.createdAt.getTime() || (a.entryId < b.entryId ? -1 : 1));
  }
  return groups;
}

/**
 * Страница журнала: версии строго старше курсора. Курсор — сама версия, а не
 * номер страницы: версия, опубликованная, пока игрок листал, не сдвинет
 * страницы и не повторит строки.
 */
export function pageOf(entries: readonly PublishedEntry[], platform: PlatformId, options: { cursor: string | null; limit: number; seenAt: Date }): ChangelogPage {
  const groups = versionsFor(entries, platform);
  const latest = groups.reduce<number | null>((max, group) => (max === null ? group.lastAt : Math.max(max, group.lastAt)), null);
  const after = options.cursor === null ? groups : groups.filter((group) => compareVersions(group.version, options.cursor ?? "") < 0);
  const size = Math.min(Math.max(1, Math.floor(options.limit)), CHANGELOG_PAGE_MAX);
  const page = after.slice(0, size);
  const last = page[page.length - 1];
  return {
    versions: page.map((group) => ({
      version: group.version,
      publishedAt: new Date(group.firstAt).toISOString(),
      fresh: group.lastAt > options.seenAt.getTime(),
      entries: group.entries.map((entry) => ({ id: entry.entryId, kind: entry.kind, text: entry.text })),
    })),
    nextCursor: after.length > size && last !== undefined ? last.version : null,
    latestAt: latest === null ? null : new Date(latest).toISOString(),
  };
}

/** Знак меню: сколько версий площадки получили строки после того, как игрок открывал журнал. */
export function freshVersions(entries: readonly PublishedEntry[], platform: PlatformId, seenAt: Date): number {
  return versionsFor(entries, platform).filter((group) => group.lastAt > seenAt.getTime()).length;
}

/**
 * Кому раздавать уведомление о версии: площадки её опубликованных строк.
 * Строка без площадок — для всех, и тогда все.
 */
export function releasePlatforms(entries: readonly Pick<PublishedEntry, "platforms">[], all: readonly PlatformId[]): PlatformId[] {
  if (entries.some((entry) => entry.platforms.length === 0)) return [...all];
  return all.filter((platform) => entries.some((entry) => entry.platforms.includes(platform)));
}

/**
 * Раздача — только тем, кто заходил за срок хранения ленты: ушедший давно
 * строку не прочтёт, а сообщение в бота о каждой версии — самый быстрый путь
 * к блокировке бота (docs/35-stage4-plan.md §6, Р11).
 */
export const FANOUT_ACTIVE_DAYS = 90;

/** Аккаунтов в пачке раздачи — один INSERT; пачек за проход — чтобы лок не держался дольше минуты. */
export const FANOUT_BATCH = 500;
export const FANOUT_MAX_BATCHES = 40;

/** Ключ события в ленте: одна версия — одно уведомление аккаунту, сколько её ни публикуй. */
export function releaseDedupeKey(version: string): string {
  return `app_update:${version}`;
}
