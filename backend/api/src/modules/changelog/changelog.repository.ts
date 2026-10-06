import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { parseVersion, type ChangelogKind, type PublishedEntry } from "./changelog-rules.js";

/**
 * Журнал обновлений в базе (WP31). Записей — сотни за жизнь игры, поэтому
 * опубликованные читаются целиком и держатся в памяти сервиса, а не
 * листаются запросом на каждого игрока.
 */

export interface ChangelogEntryRecord {
  entryId: string;
  version: string;
  platforms: PlatformId[];
  kind: ChangelogKind;
  text: string;
  /** `null` — черновик */
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
  /** откуда пришла при выкате: `pr-<номер>-<строка>`; `null` — заведена в панели */
  sourceKey: string | null;
}

export interface ChangelogEntryInput {
  version: string;
  platforms: readonly PlatformId[];
  kind: ChangelogKind;
  text: string;
}

export interface ChangelogReleaseRecord {
  version: string;
  platforms: PlatformId[];
  publishedAt: Date;
  cursor: string | null;
  doneAt: Date | null;
}

/** Строка из раздела «Для игроков» влитого PR — то, что выкат заводит черновиком. */
export interface ImportedEntry extends ChangelogEntryInput {
  sourceKey: string;
}

/**
 * Чем кончился импорт строки: заведена черновиком, черновик поправлен по
 * новому тексту PR, оставлена как есть (опубликована, правлена человеком или
 * не изменилась), удалена в панели — и не возвращается.
 */
export type ImportOutcome = "created" | "updated" | "kept" | "removed";

export const CHANGELOG_REPOSITORY = Symbol("CHANGELOG_REPOSITORY");

export interface ChangelogRepository {
  /** опубликованные строки всех версий и площадок */
  published(): Promise<PublishedEntry[]>;
  /** всё, с черновиками, — для панели */
  all(): Promise<ChangelogEntryRecord[]>;
  byId(entryId: string): Promise<ChangelogEntryRecord | null>;
  create(entryId: string, input: ChangelogEntryInput, by: string, at: Date): Promise<ChangelogEntryRecord>;
  /** `null` — записи нет */
  update(entryId: string, input: ChangelogEntryInput, by: string, at: Date): Promise<ChangelogEntryRecord | null>;
  remove(entryId: string): Promise<boolean>;
  /** опубликовать черновики версии; сколько опубликовано */
  publish(version: string, at: Date): Promise<number>;
  /**
   * Раздача версии с начала: площадки и поколение — время публикации.
   * Прежний курсор сбрасывается — тем, кто уже получил, ключ события в ленте
   * второго уведомления не даст.
   */
  startRelease(version: string, platforms: readonly PlatformId[], at: Date): Promise<void>;
  releases(): Promise<ChangelogReleaseRecord[]>;
  pendingReleases(): Promise<ChangelogReleaseRecord[]>;
  /**
   * Сдвинуть курсор раздачи — только того поколения, которое раздавали:
   * публикация посреди прохода начала раздачу заново, и её курсор старый
   * проход не перепишет. `false` — поколение сменилось.
   */
  advanceRelease(version: string, generation: Date, cursor: string | null, doneAt: Date | null): Promise<boolean>;
  /**
   * Завести строку из PR черновиком или поправить её черновик. Черновик,
   * который правил человек, и опубликованная строка не трогаются; удалённая в
   * панели не возвращается — ключ источника остаётся.
   */
  importDraft(entry: ImportedEntry, at: Date): Promise<ImportOutcome>;
  seenAt(accountId: string): Promise<Date | null>;
  /** отметить журнал открытым; время только растёт — старая вкладка не вернёт знак */
  markSeen(accountId: string, at: Date): Promise<void>;
}

@Injectable()
export class PrismaChangelogRepository implements ChangelogRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async published(): Promise<PublishedEntry[]> {
    const rows = await this.prisma.changelogEntry.findMany({ where: { publishedAt: { not: null } } });
    return rows.flatMap((row) => (row.publishedAt === null ? [] : [{ entryId: row.entryId, version: row.version, platforms: row.platforms, kind: row.kind, text: row.text, publishedAt: row.publishedAt, createdAt: row.createdAt }]));
  }

  async all(): Promise<ChangelogEntryRecord[]> {
    const rows = await this.prisma.changelogEntry.findMany({
      orderBy: [{ versionMajor: "desc" }, { versionMinor: "desc" }, { versionPatch: "desc" }, { createdAt: "asc" }],
      select: SELECT,
    });
    return rows.map(toRecord);
  }

  async byId(entryId: string): Promise<ChangelogEntryRecord | null> {
    const row = await this.prisma.changelogEntry.findUnique({ where: { entryId }, select: SELECT });
    return row === null ? null : toRecord(row);
  }

  async create(entryId: string, input: ChangelogEntryInput, by: string, at: Date): Promise<ChangelogEntryRecord> {
    return toRecord(await this.prisma.changelogEntry.create({ data: { entryId, ...fields(input), createdAt: at, updatedAt: at, updatedBy: by }, select: SELECT }));
  }

  async update(entryId: string, input: ChangelogEntryInput, by: string, at: Date): Promise<ChangelogEntryRecord | null> {
    const { count } = await this.prisma.changelogEntry.updateMany({ where: { entryId }, data: { ...fields(input), updatedAt: at, updatedBy: by } });
    return count === 0 ? null : await this.byId(entryId);
  }

  async remove(entryId: string): Promise<boolean> {
    const { count } = await this.prisma.changelogEntry.deleteMany({ where: { entryId } });
    return count > 0;
  }

  async publish(version: string, at: Date): Promise<number> {
    const { count } = await this.prisma.changelogEntry.updateMany({ where: { version, publishedAt: null }, data: { publishedAt: at } });
    return count;
  }

  async startRelease(version: string, platforms: readonly PlatformId[], at: Date): Promise<void> {
    const data = { platforms: [...platforms], publishedAt: at, cursor: null, doneAt: null };
    await this.prisma.changelogRelease.upsert({ where: { version }, create: { version, ...data }, update: data });
  }

  async releases(): Promise<ChangelogReleaseRecord[]> {
    return await this.prisma.changelogRelease.findMany({ orderBy: { publishedAt: "desc" } });
  }

  async pendingReleases(): Promise<ChangelogReleaseRecord[]> {
    return await this.prisma.changelogRelease.findMany({ where: { doneAt: null }, orderBy: { publishedAt: "asc" } });
  }

  async advanceRelease(version: string, generation: Date, cursor: string | null, doneAt: Date | null): Promise<boolean> {
    const { count } = await this.prisma.changelogRelease.updateMany({ where: { version, publishedAt: generation, doneAt: null }, data: { cursor, doneAt } });
    return count > 0;
  }

  async importDraft(entry: ImportedEntry, at: Date): Promise<ImportOutcome> {
    return await this.prisma.$transaction(async (tx) => {
      // Ключ источника занимается первым: два выката одной версии разом строку
      // не задвоят — второй увидит ключ и пойдёт правкой.
      const entryId = randomUUID();
      const claimed = await tx.$executeRaw`
        INSERT INTO changelog_source (source_key, entry_id, imported_at) VALUES (${entry.sourceKey}, NULL, ${at})
        ON CONFLICT (source_key) DO NOTHING`;
      if (claimed > 0) {
        await tx.changelogEntry.create({ data: { entryId, ...fields(entry), createdAt: at, updatedAt: at, updatedBy: null } });
        await tx.changelogSource.update({ where: { sourceKey: entry.sourceKey }, data: { entryId } });
        return "created";
      }
      const source = await tx.changelogSource.findUnique({ where: { sourceKey: entry.sourceKey }, select: { entry: { select: { entryId: true, version: true, platforms: true, kind: true, text: true, publishedAt: true, updatedBy: true } } } });
      const current = source?.entry ?? null;
      if (current === null) return "removed";
      if (current.publishedAt !== null || current.updatedBy !== null) return "kept";
      const next = fields(entry);
      if (current.version === next.version && current.kind === next.kind && current.text === next.text && samePlatforms(current.platforms, next.platforms)) return "kept";
      await tx.changelogEntry.update({ where: { entryId: current.entryId }, data: { ...next, updatedAt: at } });
      return "updated";
    });
  }

  async seenAt(accountId: string): Promise<Date | null> {
    const row = await this.prisma.changelogSeen.findUnique({ where: { accountId }, select: { seenAt: true } });
    return row?.seenAt ?? null;
  }

  async markSeen(accountId: string, at: Date): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO changelog_seen (account_id, seen_at) VALUES (${accountId}::uuid, ${at})
      ON CONFLICT (account_id) DO UPDATE SET seen_at = GREATEST(changelog_seen.seen_at, EXCLUDED.seen_at)`;
  }
}

const SELECT = {
  entryId: true,
  version: true,
  platforms: true,
  kind: true,
  text: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  updatedBy: true,
  source: { select: { sourceKey: true } },
} as const;

type SelectedEntry = Omit<ChangelogEntryRecord, "sourceKey"> & { source: { sourceKey: string } | null };

function toRecord(row: SelectedEntry): ChangelogEntryRecord {
  const { source, ...entry } = row;
  return { ...entry, sourceKey: source?.sourceKey ?? null };
}

function samePlatforms(a: readonly PlatformId[], b: readonly PlatformId[]): boolean {
  return a.length === b.length && a.every((platform) => b.includes(platform));
}

function fields(input: ChangelogEntryInput): { version: string; versionMajor: number; versionMinor: number; versionPatch: number; platforms: PlatformId[]; kind: ChangelogKind; text: string } {
  const parsed = parseVersion(input.version);
  // Сюда доходит только проверенная версия; проверка базы поймала бы и без этого.
  if (parsed === null) throw new Error(`версия не по формату: ${input.version}`);
  return { version: input.version, versionMajor: parsed.major, versionMinor: parsed.minor, versionPatch: parsed.patch, platforms: [...input.platforms], kind: input.kind, text: input.text };
}
