import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Контент игры в базе (docs/19-content-admin.md §3, tasks/T-0303): версии,
 * черновики поверх версий и проверки черновиков. Снимки — jsonb: порядок ключей
 * база не хранит, поэтому всё, что должно переживать запись, считается по
 * каноническому JSON (`content-hash.ts`), а не по строке.
 */

export const CONTENT_SOURCES = ["repo", "panel"] as const;
export type ContentSource = (typeof CONTENT_SOURCES)[number];

export type ContentCheckStatus = "queued" | "done" | "failed" | "timeout";

export interface ContentVersionSummary {
  versionNo: number;
  contentHash: string;
  schemaVersion: number;
  source: ContentSource;
  createdBy: string | null;
  createdAt: Date;
  publishedAt: Date | null;
}

export interface ContentVersionRecord extends ContentVersionSummary {
  snapshot: unknown;
  jsonSchema: unknown;
  names: Record<string, string>;
}

export interface NewContentVersion {
  contentHash: string;
  schemaVersion: number;
  snapshot: unknown;
  jsonSchema: unknown;
  names: Record<string, string>;
  source: ContentSource;
  createdBy: string | null;
  createdAt: Date;
}

export interface ContentDraftSummary {
  draftId: string;
  baseVersionNo: number;
  title: string;
  author: string;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface ContentDraftRecord extends ContentDraftSummary {
  snapshot: unknown;
}

export interface ContentCheckRecord {
  checkId: string;
  draftId: string;
  snapshotHash: string;
  status: ContentCheckStatus;
  report: unknown;
  createdAt: Date;
}

/** Чем кончилась правка черновика под блокировкой. */
export type DraftMutation = { outcome: "missing" } | { outcome: "archived" } | { outcome: "ok"; before: ContentDraftRecord; after: ContentDraftRecord };

export const CONTENT_REPOSITORY = Symbol("CONTENT_REPOSITORY");

export interface ContentRepository {
  /** новые сверху, без снимков */
  versions(): Promise<ContentVersionSummary[]>;
  version(versionNo: number): Promise<ContentVersionRecord | null>;
  versionByHash(contentHash: string): Promise<ContentVersionSummary | null>;
  latestVersion(): Promise<ContentVersionSummary | null>;
  /**
   * Завести версию, если её хэша ещё нет; иначе вернуть существующую. Номер
   * не тратится на повтор: версии идут подряд, без дыр от повторных импортов.
   */
  addVersion(input: NewContentVersion): Promise<{ created: boolean; version: ContentVersionSummary }>;
  /** черновики без снимков, свежие сверху; архивные или открытые */
  drafts(options: { archived: boolean; limit: number }): Promise<ContentDraftSummary[]>;
  activeDraftCount(): Promise<number>;
  draft(draftId: string): Promise<ContentDraftRecord | null>;
  addDraft(record: ContentDraftRecord): Promise<void>;
  /**
   * Править снимок черновика под блокировкой его строки: два одновременных
   * редактора не затирают друг друга. `edit` вызывается синхронно, на
   * актуальной записи; вернул новый снимок — он сохраняется, `null` — менять
   * нечего, запись не трогается. Исключение `edit` откатывает всё.
   */
  editDraft(draftId: string, at: Date, edit: (current: ContentDraftRecord) => unknown): Promise<DraftMutation>;
  /** идемпотентно: повторный архив ничего не меняет; `null` — черновика нет */
  archiveDraft(draftId: string, at: Date): Promise<ContentDraftSummary | null>;
  /**
   * Записать проверку. Если на пару (черновик, снимок) уже есть живая (не
   * упавшая) — вернуть её, новая не заводится: повтор проверки того же снимка
   * не гоняет воркер второй раз, даже при гонке двух запросов.
   */
  addCheck(record: ContentCheckRecord): Promise<ContentCheckRecord>;
  check(checkId: string): Promise<ContentCheckRecord | null>;
  latestCheck(draftId: string): Promise<ContentCheckRecord | null>;
  /** живая проверка пары (черновик, снимок): в очереди, готовая или оборванная пределом времени */
  reusableCheck(draftId: string, snapshotHash: string): Promise<ContentCheckRecord | null>;
  /** закрыть проверку из очереди; `false` — её уже закрыл другой опрос */
  finishCheck(checkId: string, status: Exclude<ContentCheckStatus, "queued">, report: unknown): Promise<boolean>;
  removeCheck(checkId: string): Promise<void>;
}

const namesSchema = z.record(z.string(), z.string());

/**
 * Значение, пришедшее из JSON, — в колонку jsonb. Снимок прошёл схему, имена —
 * Zod, отчёт воркера — Zod, а не пришедшее в сервис как есть: принимать здесь
 * больше не нужно, поэтому приведение одно и на виду.
 */
const toJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const toJsonText = (value: unknown): string => JSON.stringify(value ?? null);

interface VersionRow {
  versionNo: number;
  contentHash: string;
  schemaVersion: number;
  source: string;
  createdBy: string | null;
  createdAt: Date;
  publishedAt: Date | null;
}

const VERSION_SUMMARY = { versionNo: true, contentHash: true, schemaVersion: true, source: true, createdBy: true, createdAt: true, publishedAt: true } as const;
const DRAFT_SUMMARY = { draftId: true, baseVersionNo: true, title: true, author: true, updatedAt: true, archivedAt: true } as const;

function sourceOf(value: string): ContentSource {
  // CHECK в базе держит список; сюда другое значение не дойдёт.
  return value === "panel" ? "panel" : "repo";
}

function toSummary(row: VersionRow): ContentVersionSummary {
  return { ...row, source: sourceOf(row.source) };
}

function toCheck(row: { checkId: string; draftId: string; snapshotHash: string; status: string; report: unknown; createdAt: Date }): ContentCheckRecord {
  const status: ContentCheckStatus = row.status === "done" || row.status === "failed" || row.status === "timeout" ? row.status : "queued";
  return { checkId: row.checkId, draftId: row.draftId, snapshotHash: row.snapshotHash, status, report: row.report, createdAt: row.createdAt };
}

@Injectable()
export class PrismaContentRepository implements ContentRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async versions(): Promise<ContentVersionSummary[]> {
    const rows = await this.prisma.contentVersion.findMany({ orderBy: { versionNo: "desc" }, select: VERSION_SUMMARY });
    return rows.map(toSummary);
  }

  async version(versionNo: number): Promise<ContentVersionRecord | null> {
    const row = await this.prisma.contentVersion.findUnique({ where: { versionNo } });
    if (row === null) return null;
    return { ...toSummary(row), snapshot: row.snapshot, jsonSchema: row.jsonSchema, names: namesSchema.parse(row.names) };
  }

  async versionByHash(contentHash: string): Promise<ContentVersionSummary | null> {
    const row = await this.prisma.contentVersion.findUnique({ where: { contentHash }, select: VERSION_SUMMARY });
    return row === null ? null : toSummary(row);
  }

  async latestVersion(): Promise<ContentVersionSummary | null> {
    const row = await this.prisma.contentVersion.findFirst({ orderBy: { versionNo: "desc" }, select: VERSION_SUMMARY });
    return row === null ? null : toSummary(row);
  }

  async addVersion(input: NewContentVersion): Promise<{ created: boolean; version: ContentVersionSummary }> {
    // `WHERE NOT EXISTS` не пускает в `INSERT` ни одной строки, когда хэш уже есть, и номер серийной
    // колонки не расходуется; гонку двух импортов закрывает `ON CONFLICT` — проигравший получает
    // пустой ответ и читает победителя.
    const inserted = await this.prisma.$queryRaw<{ version_no: number }[]>`
      INSERT INTO content_version (content_hash, schema_version, snapshot, json_schema, names, source, created_by, created_at)
      SELECT ${input.contentHash}::varchar, ${input.schemaVersion}::smallint, ${toJsonText(input.snapshot)}::jsonb, ${toJsonText(input.jsonSchema)}::jsonb,
             ${toJsonText(input.names)}::jsonb, ${input.source}::varchar, ${input.createdBy}::uuid, ${input.createdAt}::timestamptz
      WHERE NOT EXISTS (SELECT 1 FROM content_version WHERE content_hash = ${input.contentHash})
      ON CONFLICT (content_hash) DO NOTHING
      RETURNING version_no`;
    const row = await this.prisma.contentVersion.findUniqueOrThrow({ where: { contentHash: input.contentHash }, select: VERSION_SUMMARY });
    return { created: inserted.length > 0, version: toSummary(row) };
  }

  async drafts(options: { archived: boolean; limit: number }): Promise<ContentDraftSummary[]> {
    return await this.prisma.contentDraft.findMany({
      where: { archivedAt: options.archived ? { not: null } : null },
      orderBy: { updatedAt: "desc" },
      take: options.limit,
      select: DRAFT_SUMMARY,
    });
  }

  async activeDraftCount(): Promise<number> {
    return await this.prisma.contentDraft.count({ where: { archivedAt: null } });
  }

  async draft(draftId: string): Promise<ContentDraftRecord | null> {
    return await this.prisma.contentDraft.findUnique({ where: { draftId } });
  }

  async addDraft(record: ContentDraftRecord): Promise<void> {
    await this.prisma.contentDraft.create({ data: { ...record, snapshot: toJson(record.snapshot) } });
  }

  async editDraft(draftId: string, at: Date, edit: (current: ContentDraftRecord) => unknown): Promise<DraftMutation> {
    return await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ archived: boolean }[]>`
        SELECT (archived_at IS NOT NULL) AS archived FROM content_draft WHERE draft_id = ${draftId}::uuid FOR UPDATE`;
      const state = locked[0];
      if (state === undefined) return { outcome: "missing" } as const;
      if (state.archived) return { outcome: "archived" } as const;
      const before = await tx.contentDraft.findUniqueOrThrow({ where: { draftId } });
      const next = edit(before);
      if (next === null) return { outcome: "ok", before, after: before } as const;
      const after = await tx.contentDraft.update({ where: { draftId }, data: { snapshot: toJson(next), updatedAt: at } });
      return { outcome: "ok", before, after } as const;
    });
  }

  async archiveDraft(draftId: string, at: Date): Promise<ContentDraftSummary | null> {
    await this.prisma.contentDraft.updateMany({ where: { draftId, archivedAt: null }, data: { archivedAt: at } });
    return await this.prisma.contentDraft.findUnique({ where: { draftId }, select: DRAFT_SUMMARY });
  }

  async addCheck(record: ContentCheckRecord): Promise<ContentCheckRecord> {
    // Три захода: живая проверка, что мешала вставке, могла за это время упасть — тогда вставка пройдёт со второго раза.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const inserted = await this.prisma.$queryRaw<{ check_id: string }[]>`
        INSERT INTO content_check (check_id, draft_id, snapshot_hash, status, report, created_at)
        VALUES (${record.checkId}::uuid, ${record.draftId}::uuid, ${record.snapshotHash}::varchar, ${record.status}::varchar,
                ${record.report === null ? null : toJsonText(record.report)}::jsonb, ${record.createdAt}::timestamptz)
        ON CONFLICT (draft_id, snapshot_hash) WHERE status <> 'failed' DO NOTHING
        RETURNING check_id`;
      if (inserted.length > 0) return record;
      const existing = await this.reusableCheck(record.draftId, record.snapshotHash);
      if (existing !== null) return existing;
    }
    throw new Error("проверка не записана: конфликт не разрешился");
  }

  async check(checkId: string): Promise<ContentCheckRecord | null> {
    const row = await this.prisma.contentCheck.findUnique({ where: { checkId } });
    return row === null ? null : toCheck(row);
  }

  async latestCheck(draftId: string): Promise<ContentCheckRecord | null> {
    const row = await this.prisma.contentCheck.findFirst({ where: { draftId }, orderBy: { createdAt: "desc" } });
    return row === null ? null : toCheck(row);
  }

  async reusableCheck(draftId: string, snapshotHash: string): Promise<ContentCheckRecord | null> {
    const row = await this.prisma.contentCheck.findFirst({ where: { draftId, snapshotHash, status: { not: "failed" } }, orderBy: { createdAt: "desc" } });
    return row === null ? null : toCheck(row);
  }

  async finishCheck(checkId: string, status: Exclude<ContentCheckStatus, "queued">, report: unknown): Promise<boolean> {
    const { count } = await this.prisma.contentCheck.updateMany({ where: { checkId, status: "queued" }, data: { status, report: toJson(report) } });
    return count > 0;
  }

  async removeCheck(checkId: string): Promise<void> {
    await this.prisma.contentCheck.deleteMany({ where: { checkId } });
  }
}
