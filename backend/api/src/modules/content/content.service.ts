import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { PayloadTooLargeError, ValidationError } from "../../common/domain-error.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { diffSnapshots, type SnapshotChange } from "./content-diff.js";
import { editSnapshot } from "./content-edit.js";
import { ContentDraftArchivedError, ContentDraftLimitError, ContentDraftNotFoundError, ContentValueError, ContentVersionNotFoundError } from "./content-errors.js";
import { canonicalJson, snapshotHash } from "./content-hash.js";
import { CONTENT_REPOSITORY, type ContentCheckRecord, type ContentDraftRecord, type ContentDraftSummary, type ContentRepository, type ContentVersionRecord, type ContentVersionSummary } from "./content.repository.js";

/**
 * Версии и черновики контента (docs/19-content-admin.md §3, tasks/T-0303):
 * чтение версий, черновик как копия снимка версии, правка по пути с проверкой
 * формы, разница с базой. Проверка через sim-worker — `ContentCheckService`;
 * публикации здесь нет (T-0306).
 */

export const DRAFT_TITLE_MAX = 80;
/** Открытых черновиков всего: у каждого свой снимок на десятки килобайт, а архив их освобождает. */
export const DRAFTS_ACTIVE_MAX = 100;
export const DRAFTS_LIST_LIMIT = 200;
/** Значение одной правки: целый раздел снимка занимает единицы килобайт, больше — ошибка или попытка забить базу. */
export const PATCH_VALUE_MAX_BYTES = 32 * 1024;
/** Схемы версий неизменны, а читается схема на каждую правку: держим несколько последних. */
const SCHEMA_CACHE_MAX = 8;

export interface ContentDraftView extends ContentDraftSummary {
  /** отпечаток снимка: сменился — отчёты проверок устарели */
  snapshotHash: string;
}

export interface ContentCheckBrief {
  checkId: string;
  status: ContentCheckRecord["status"];
  snapshotHash: string;
  createdAt: Date;
}

export interface ContentDraftDetail extends ContentDraftView {
  snapshot: unknown;
  lastCheck: ContentCheckBrief | null;
}

export interface PatchResult {
  draftId: string;
  path: string;
  from: unknown;
  to: unknown;
  /** `false` — значение то же, запись и аудит пропущены */
  changed: boolean;
  snapshotHash: string;
  updatedAt: Date;
}

export interface DraftDiff {
  baseVersionNo: number;
  changes: SnapshotChange[];
  truncated: boolean;
}

@Injectable()
export class ContentService {
  private readonly schemas = new Map<number, unknown>();

  constructor(
    @Inject(CONTENT_REPOSITORY) private readonly repository: ContentRepository,
    private readonly roles: RolesService,
  ) {}

  async versions(actor: AccountRef): Promise<ContentVersionSummary[]> {
    await this.roles.require(actor, "content.view");
    return await this.repository.versions();
  }

  async version(actor: AccountRef, versionNo: number): Promise<ContentVersionRecord> {
    await this.roles.require(actor, "content.view");
    const version = await this.repository.version(versionNo);
    if (version === null) throw new ContentVersionNotFoundError();
    return version;
  }

  async drafts(actor: AccountRef, archived: boolean): Promise<ContentDraftSummary[]> {
    await this.roles.require(actor, "content.view");
    return await this.repository.drafts({ archived, limit: DRAFTS_LIST_LIMIT });
  }

  async draft(actor: AccountRef, draftId: string): Promise<ContentDraftDetail> {
    await this.roles.require(actor, "content.view");
    const draft = await this.load(draftId);
    const last = await this.repository.latestCheck(draftId);
    const lastCheck = last === null ? null : { checkId: last.checkId, status: last.status, snapshotHash: last.snapshotHash, createdAt: last.createdAt };
    return { ...summaryOf(draft), snapshot: draft.snapshot, snapshotHash: snapshotHash(draft.snapshot), lastCheck };
  }

  /** Черновик — копия снимка версии; без номера — последней. */
  async createDraft(actor: AccountRef, input: { title: string; baseVersionNo?: number | undefined }, now = new Date()): Promise<ContentDraftView> {
    await this.roles.require(actor, "content.edit");
    const title = input.title.trim();
    if (title === "") throw new ValidationError("Название черновика пустое");
    if (title.length > DRAFT_TITLE_MAX) throw new ValidationError(`Название черновика длиннее ${String(DRAFT_TITLE_MAX)} знаков`);

    const versionNo = input.baseVersionNo ?? (await this.repository.latestVersion())?.versionNo;
    if (versionNo === undefined) throw new ContentVersionNotFoundError("Версий контента ещё нет — заведите версию 0 командой content:import");
    const base = await this.repository.version(versionNo);
    if (base === null) throw new ContentVersionNotFoundError();
    if ((await this.repository.activeDraftCount()) >= DRAFTS_ACTIVE_MAX) throw new ContentDraftLimitError(DRAFTS_ACTIVE_MAX);

    const snapshot: unknown = JSON.parse(JSON.stringify(base.snapshot));
    const record: ContentDraftRecord = { draftId: randomUUID(), baseVersionNo: base.versionNo, title, snapshot, author: actor.accountId, updatedAt: now, archivedAt: null };
    await this.repository.addDraft(record);
    await this.roles.audit({ actorAccountId: actor.accountId, action: "content.draft.create", target: record.draftId, after: { title, baseVersionNo: base.versionNo } });
    return { ...summaryOf(record), snapshotHash: snapshotHash(snapshot) };
  }

  /**
   * Правка по пути. Не та форма — 422, черновик не меняется. Новое значение
   * равно прежнему — записи и аудита нет. Аудит хранит путь, что было и что
   * стало: черновик перезаписывается, и без этого прежнее значение не вернуть.
   */
  async patchDraft(actor: AccountRef, draftId: string, input: { path: string; value: unknown }, now = new Date()): Promise<PatchResult> {
    await this.roles.require(actor, "content.edit");
    if (Buffer.byteLength(JSON.stringify(input.value) ?? "", "utf8") > PATCH_VALUE_MAX_BYTES) throw new PayloadTooLargeError("Значение больше 32 КБ");
    // Postgres не хранит нулевой знак в тексте jsonb: запись упала бы 500-й, а не отказом с причиной.
    if ((JSON.stringify(input.value) ?? "").includes("\\u0000")) throw new ContentValueError(`${input.path}: нулевой знак в тексте недопустим`);

    const current = await this.load(draftId);
    const jsonSchema = await this.schemaOf(current.baseVersionNo);
    // Держатель, а не `let`: присвоение в замыкании компилятор при чтении ниже не видит.
    const made: { from: unknown; to: unknown } = { from: null, to: input.value };
    const outcome = await this.repository.editDraft(draftId, now, (locked) => {
      const result = editSnapshot({ snapshot: locked.snapshot, jsonSchema, path: input.path, value: input.value });
      made.from = result.from;
      made.to = result.to;
      return canonicalJson(result.from) === canonicalJson(result.to) ? null : result.next;
    });
    if (outcome.outcome === "missing") throw new ContentDraftNotFoundError();
    if (outcome.outcome === "archived") throw new ContentDraftArchivedError();
    const { from, to } = made;
    const changed = outcome.after !== outcome.before;
    if (changed) {
      await this.roles.audit({
        actorAccountId: actor.accountId,
        action: "content.draft.patch",
        target: draftId,
        before: { path: input.path, value: from },
        after: { path: input.path, value: to },
      });
    }
    return { draftId, path: input.path, from, to, changed, snapshotHash: snapshotHash(outcome.after.snapshot), updatedAt: outcome.after.updatedAt };
  }

  async archiveDraft(actor: AccountRef, draftId: string, now = new Date()): Promise<ContentDraftSummary> {
    await this.roles.require(actor, "content.edit");
    const archived = await this.repository.archiveDraft(draftId, now);
    if (archived === null) throw new ContentDraftNotFoundError();
    // Повторный архив — не событие: в журнале только тот, что сработал.
    if (archived.archivedAt?.getTime() === now.getTime()) {
      await this.roles.audit({ actorAccountId: actor.accountId, action: "content.draft.archive", target: draftId, before: { title: archived.title } });
    }
    return archived;
  }

  /** Отличия черновика от версии-основы: только изменённые пути. */
  async diff(actor: AccountRef, draftId: string): Promise<DraftDiff> {
    await this.roles.require(actor, "content.view");
    const draft = await this.load(draftId);
    const base = await this.repository.version(draft.baseVersionNo);
    if (base === null) throw new ContentVersionNotFoundError();
    return { baseVersionNo: base.versionNo, ...diffSnapshots(base.snapshot, draft.snapshot) };
  }

  private async load(draftId: string): Promise<ContentDraftRecord> {
    const draft = await this.repository.draft(draftId);
    if (draft === null) throw new ContentDraftNotFoundError();
    return draft;
  }

  private async schemaOf(versionNo: number): Promise<unknown> {
    const cached = this.schemas.get(versionNo);
    if (cached !== undefined) return cached;
    const version = await this.repository.version(versionNo);
    if (version === null) throw new ContentVersionNotFoundError();
    if (this.schemas.size >= SCHEMA_CACHE_MAX) this.schemas.delete(this.schemas.keys().next().value as number);
    this.schemas.set(versionNo, version.jsonSchema);
    return version.jsonSchema;
  }
}

function summaryOf(draft: ContentDraftSummary): ContentDraftSummary {
  return { draftId: draft.draftId, baseVersionNo: draft.baseVersionNo, title: draft.title, author: draft.author, updatedAt: draft.updatedAt, archivedAt: draft.archivedAt };
}
