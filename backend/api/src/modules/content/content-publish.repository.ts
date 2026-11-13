import { Inject, Injectable } from "@nestjs/common";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { ContentVersionSummary } from "./content.repository.js";

/**
 * Публикация контента в базе (docs/19-content-admin.md §4.4–§4.5, tasks/T-0306):
 * указатели «что в игре» у команды и у всех, публикация версии вместе с
 * указателем, откат, подхват версии из кода при выкате и слияние кода в
 * черновик.
 *
 * Каждая операция — одна транзакция с блокировкой строк указателей в одном
 * порядке (сначала `team`, потом `all`): две публикации, откат и выкат, идущие
 * разом, не взаимоблокируются и не оставляют указатели в разном состоянии.
 * Redis-замок поверх этого — порядок для людей, а целостность держит база.
 */

export const AUDIENCES = ["team", "all"] as const;
export type Audience = (typeof AUDIENCES)[number];

export interface ContentPointer {
  audience: Audience;
  versionNo: number;
  /** `null` — версию поставил выкат */
  setBy: string | null;
  setAt: Date;
}

/** Нет строки `team` — команда играет версией «всем»; нет строки `all` — ничего не публиковалось. */
export interface ContentPointers {
  team: ContentPointer | null;
  all: ContentPointer | null;
}

export interface PublishInput {
  /** отпечаток снимка (`snapshotHash`): один снимок — одна версия */
  contentHash: string;
  schemaVersion: number;
  snapshot: unknown;
  jsonSchema: unknown;
  names: Record<string, string>;
  createdBy: string;
  now: Date;
  /** `["team"]` или `["team", "all"]`: публикация «Всем» ставит оба указателя */
  audiences: readonly Audience[];
}

export interface PublishOutcome {
  version: ContentVersionSummary;
  /** `false` — версия с таким снимком уже была */
  created: boolean;
  /** что стояло в указателе до публикации; `null` — строки не было */
  previous: Record<Audience, number | null>;
  /** аудитории, у которых указатель сменился */
  moved: Audience[];
}

export type RollbackOutcome =
  | { outcome: "ok"; previousVersionNo: number | null; changed: boolean }
  | { outcome: "no_version" }
  | { outcome: "not_published" }
  | { outcome: "nothing_published" };

/** Что дописать в черновик: новый снимок и основа, на которую он теперь опирается. */
export interface DraftRebase {
  snapshot: unknown;
  baseVersionNo: number;
}

export type DraftMergeOutcome =
  | { outcome: "missing" }
  | { outcome: "archived" }
  | { outcome: "ok"; changed: boolean; before: DraftRebase; after: DraftRebase };

export const CONTENT_PUBLISH_REPOSITORY = Symbol("CONTENT_PUBLISH_REPOSITORY");

export interface ContentPublishRepository {
  pointers(): Promise<ContentPointers>;
  /**
   * Опубликовать: завести версию, если снимка ещё нет, и поставить указатели
   * названным аудиториям. Повтор того же снимка новой версии не заводит, а
   * указатель, уже стоящий на ней, не трогает.
   */
  publish(input: PublishInput): Promise<PublishOutcome>;
  /** Указатель аудитории — на версию, которая уже бывала в игре. Новой версии не заводит. */
  rollback(input: { audience: Audience; versionNo: number; setBy: string; now: Date }): Promise<RollbackOutcome>;
  /**
   * Версия «из кода» после выката: становится текущей у каждой аудитории,
   * чья текущая версия — тоже из кода (или её нет). Остальное — «рядом».
   * Возвращает аудитории, у которых указатель сдвинулся.
   */
  adopt(versionNo: number, now: Date): Promise<Audience[]>;
  /** последняя версия «из кода»: ту, что ждёт рядом, «Взять из кода» и сливает */
  latestRepoVersion(): Promise<ContentVersionSummary | null>;
  /** последняя из бывших в игре версий не новее `maxVersionNo`, чья схема не выше клиентской */
  compatibleUpTo(maxVersionNo: number, schema: number): Promise<ContentVersionSummary | null>;
  /** снимок версии, которая бывала в игре, по хэшу; остальные версии клиенту не отдаются */
  publishedSnapshot(contentHash: string): Promise<{ contentHash: string; snapshot: unknown } | null>;
  /**
   * Переписать снимок и основу черновика под блокировкой его строки. `compute`
   * вызывается синхронно, на актуальной записи; `null` — менять нечего.
   */
  mergeDraft(draftId: string, at: Date, compute: (current: DraftRebase) => DraftRebase | null): Promise<DraftMergeOutcome>;
}

const VERSION_SUMMARY = { versionNo: true, contentHash: true, schemaVersion: true, source: true, createdBy: true, createdAt: true, publishedAt: true } as const;

interface VersionRow {
  versionNo: number;
  contentHash: string;
  schemaVersion: number;
  source: string;
  createdBy: string | null;
  createdAt: Date;
  publishedAt: Date | null;
}

function toSummary(row: VersionRow): ContentVersionSummary {
  // `CHECK` в миграции держит список источников: сюда другое значение не дойдёт.
  return { ...row, source: row.source === "panel" ? "panel" : "repo" };
}

function audienceOf(value: string): Audience {
  return value === "team" ? "team" : "all";
}

const toJsonText = (value: unknown): string => JSON.stringify(value ?? null);
const toJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

type Tx = Prisma.TransactionClient;

@Injectable()
export class PrismaContentPublishRepository implements ContentPublishRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async pointers(): Promise<ContentPointers> {
    const rows = await this.prisma.contentCurrent.findMany();
    const pointers: ContentPointers = { team: null, all: null };
    for (const row of rows) {
      const audience = audienceOf(row.audience);
      pointers[audience] = { audience, versionNo: row.versionNo, setBy: row.setBy, setAt: row.setAt };
    }
    return pointers;
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    return await this.prisma.$transaction(async (tx) => {
      // Ни одного `INSERT` на повтор: номер серийной колонки не расходуется, а гонку двух публикаций одного
      // снимка закрывает `ON CONFLICT` — проигравший получает пустой ответ и читает победителя.
      const inserted = await tx.$queryRaw<{ version_no: number }[]>`
        INSERT INTO content_version (content_hash, schema_version, snapshot, json_schema, names, source, created_by, created_at, published_at)
        SELECT ${input.contentHash}::varchar, ${input.schemaVersion}::smallint, ${toJsonText(input.snapshot)}::jsonb, ${toJsonText(input.jsonSchema)}::jsonb,
               ${toJsonText(input.names)}::jsonb, 'panel', ${input.createdBy}::uuid, ${input.now}::timestamptz, ${input.now}::timestamptz
        WHERE NOT EXISTS (SELECT 1 FROM content_version WHERE content_hash = ${input.contentHash})
        ON CONFLICT (content_hash) DO NOTHING
        RETURNING version_no`;
      let row = await tx.contentVersion.findUniqueOrThrow({ where: { contentHash: input.contentHash }, select: VERSION_SUMMARY });
      // Версия без отметки публикации в игре не бывала; публикуя, отмечаем — иначе на неё нельзя будет откатиться.
      if (row.publishedAt === null) row = await tx.contentVersion.update({ where: { versionNo: row.versionNo }, data: { publishedAt: input.now }, select: VERSION_SUMMARY });

      const previous: Record<Audience, number | null> = { team: null, all: null };
      const moved: Audience[] = [];
      // Порядок один во всех операциях: иначе два встречных запроса ждали бы друг друга вечно.
      for (const audience of AUDIENCES.filter((candidate) => input.audiences.includes(candidate))) {
        const own = await this.lockedPointer(tx, audience);
        // Команда без своего указателя играет версией «всем»: «было» у неё — она, и закреплять то же самое незачем.
        const effective = own ?? (audience === "team" ? await this.plainPointer(tx, "all") : null);
        previous[audience] = effective;
        if (own === null && effective === row.versionNo) continue;
        if (await this.point(tx, audience, row.versionNo, input.createdBy, input.now)) moved.push(audience);
      }
      return { version: toSummary(row), created: inserted.length > 0, previous, moved };
    });
  }

  async rollback(input: { audience: Audience; versionNo: number; setBy: string; now: Date }): Promise<RollbackOutcome> {
    return await this.prisma.$transaction(async (tx) => {
      const target = await tx.contentVersion.findUnique({ where: { versionNo: input.versionNo }, select: { publishedAt: true } });
      if (target === null) return { outcome: "no_version" } as const;
      if (target.publishedAt === null) return { outcome: "not_published" } as const;

      const own = await this.lockedPointer(tx, input.audience);
      // Команда без своего указателя играет версией «всем»: откатывается она от неё.
      const previous = own ?? (input.audience === "team" ? await this.lockedPointer(tx, "all") : null);
      if (previous === null) return { outcome: "nothing_published" } as const;
      if (previous === input.versionNo) return { outcome: "ok", previousVersionNo: previous, changed: false } as const;
      await this.point(tx, input.audience, input.versionNo, input.setBy, input.now);
      return { outcome: "ok", previousVersionNo: previous, changed: true } as const;
    });
  }

  async adopt(versionNo: number, now: Date): Promise<Audience[]> {
    return await this.prisma.$transaction(async (tx) => {
      const candidate = await tx.contentVersion.findUnique({ where: { versionNo }, select: { source: true } });
      // Подхватывать нечего, кроме версии из кода: панельная версия попадает в игру публикацией.
      if (candidate?.source !== "repo") return [];

      const adopted: Audience[] = [];
      for (const audience of AUDIENCES) {
        const rows = await tx.$queryRaw<{ version_no: number; source: string }[]>`
          SELECT c.version_no, v.source FROM content_current c JOIN content_version v ON v.version_no = c.version_no
          WHERE c.audience = ${audience} FOR UPDATE OF c`;
        const current = rows[0];
        if (current === undefined) {
          // Строки `team` нет — команда идёт за «всеми», и свою ей заводить незачем.
          if (audience === "team") continue;
          // `ON CONFLICT`: публикация из панели успела раньше — её указатель сильнее подхвата.
          const created = await tx.$executeRaw`
            INSERT INTO content_current (audience, version_no, set_by, set_at) VALUES (${audience}, ${versionNo}, NULL, ${now}::timestamptz) ON CONFLICT (audience) DO NOTHING`;
          if (created > 0) adopted.push(audience);
        } else if (current.source === "repo" && current.version_no !== versionNo) {
          await tx.$executeRaw`UPDATE content_current SET version_no = ${versionNo}, set_by = NULL, set_at = ${now}::timestamptz WHERE audience = ${audience}`;
          adopted.push(audience);
        }
      }
      if (adopted.length > 0) await tx.$executeRaw`UPDATE content_version SET published_at = COALESCE(published_at, ${now}::timestamptz) WHERE version_no = ${versionNo}`;
      return adopted;
    });
  }

  async latestRepoVersion(): Promise<ContentVersionSummary | null> {
    const row = await this.prisma.contentVersion.findFirst({ where: { source: "repo" }, orderBy: { versionNo: "desc" }, select: VERSION_SUMMARY });
    return row === null ? null : toSummary(row);
  }

  async compatibleUpTo(maxVersionNo: number, schema: number): Promise<ContentVersionSummary | null> {
    const row = await this.prisma.contentVersion.findFirst({
      where: { publishedAt: { not: null }, versionNo: { lte: maxVersionNo }, schemaVersion: { lte: schema } },
      orderBy: { versionNo: "desc" },
      select: VERSION_SUMMARY,
    });
    return row === null ? null : toSummary(row);
  }

  async publishedSnapshot(contentHash: string): Promise<{ contentHash: string; snapshot: unknown } | null> {
    const row = await this.prisma.contentVersion.findFirst({ where: { contentHash, publishedAt: { not: null } }, select: { contentHash: true, snapshot: true } });
    return row;
  }

  async mergeDraft(draftId: string, at: Date, compute: (current: DraftRebase) => DraftRebase | null): Promise<DraftMergeOutcome> {
    return await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ archived: boolean }[]>`
        SELECT (archived_at IS NOT NULL) AS archived FROM content_draft WHERE draft_id = ${draftId}::uuid FOR UPDATE`;
      const state = locked[0];
      if (state === undefined) return { outcome: "missing" } as const;
      if (state.archived) return { outcome: "archived" } as const;
      const draft = await tx.contentDraft.findUniqueOrThrow({ where: { draftId }, select: { snapshot: true, baseVersionNo: true } });
      const before: DraftRebase = { snapshot: draft.snapshot, baseVersionNo: draft.baseVersionNo };
      const after = compute(before);
      if (after === null) return { outcome: "ok", changed: false, before, after: before } as const;
      await tx.contentDraft.update({ where: { draftId }, data: { snapshot: toJson(after.snapshot), baseVersionNo: after.baseVersionNo, updatedAt: at } });
      return { outcome: "ok", changed: true, before, after } as const;
    });
  }

  /** Номер версии у указателя аудитории под блокировкой строки; `null` — строки нет. */
  private async lockedPointer(tx: Tx, audience: Audience): Promise<number | null> {
    const rows = await tx.$queryRaw<{ version_no: number }[]>`SELECT version_no FROM content_current WHERE audience = ${audience} FOR UPDATE`;
    return rows[0]?.version_no ?? null;
  }

  /** Номер версии у указателя без блокировки: когда строку только читают, а менять будут другую. */
  private async plainPointer(tx: Tx, audience: Audience): Promise<number | null> {
    const row = await tx.contentCurrent.findUnique({ where: { audience }, select: { versionNo: true } });
    return row?.versionNo ?? null;
  }

  /** Поставить указатель; `false` — он уже стоял на этой версии и остался как был (автор и время тоже). */
  private async point(tx: Tx, audience: Audience, versionNo: number, setBy: string, now: Date): Promise<boolean> {
    const changed = await tx.$executeRaw`
      INSERT INTO content_current (audience, version_no, set_by, set_at) VALUES (${audience}, ${versionNo}, ${setBy}::uuid, ${now}::timestamptz)
      ON CONFLICT (audience) DO UPDATE SET version_no = EXCLUDED.version_no, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at
      WHERE content_current.version_no <> EXCLUDED.version_no`;
    return changed > 0;
  }
}
