import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { UnavailableError } from "../../common/domain-error.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { diffSnapshots, type SnapshotChange } from "./content-diff.js";
import { ContentDraftArchivedError, ContentDraftNotFoundError, ContentValueError, ContentVersionNotFoundError } from "./content-errors.js";
import { snapshotHash } from "./content-hash.js";
import { validateJsonSchema } from "./content-json-schema.js";
import { mergeAdditions } from "./content-merge.js";
import { formatPointer } from "./content-path.js";
import { ContentCheckRequiredError, ContentMergeSourceError, ContentPublishBusyError, ContentRollbackInvalidError, ContentSchemaChangedError } from "./content-publish-errors.js";
import { CONTENT_PUBLISH_LOCK, type ContentPublishLock } from "./content-publish-lock.js";
import { publishBlockReason } from "./content-publish-rules.js";
import { CONTENT_PUBLISH_REPOSITORY, type Audience, type ContentPointers, type ContentPublishRepository } from "./content-publish.repository.js";
import { CONTENT_REPOSITORY, type ContentDraftRecord, type ContentRepository } from "./content.repository.js";

/**
 * Публикация контента (docs/19-content-admin.md §4.3–§4.5, tasks/T-0306):
 * черновик становится версией игры — сначала для команды, потом для всех, —
 * только по свежей зелёной проверке; откат — указателем на прошлую версию.
 *
 * Публикуется ровно тот снимок, который прочитан из базы один раз: по его
 * отпечатку ищется проверка и из него же заводится версия, поэтому правка
 * черновика посреди публикации не подменит проверенное непроверенным.
 * Идемпотентность — от отпечатка: тот же снимок второй раз версию не заводит.
 */

/** Сколько ждать замок: публикация — секунды, а упереться в чужую человек может, нажав дважды. */
export const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 50;
/** Замок живёт ограниченно: умершая реплика не должна держать публикацию вечно. */
const LOCK_TTL_MS = 30_000;

export interface PublishResult {
  audience: Audience;
  versionNo: number;
  contentHash: string;
  /** `false` — версия с таким снимком уже была (например, «Команде», а теперь «Всем») */
  created: boolean;
  /** хоть один указатель сменился; `false` — повтор, который ничего не изменил */
  changed: boolean;
  previousVersionNo: number | null;
}

export interface RollbackResult {
  audience: Audience;
  versionNo: number;
  previousVersionNo: number | null;
  changed: boolean;
}

export interface PublicationPreview {
  audience: Audience;
  /** версия, которая у этой аудитории в игре сейчас; `null` — ничего не публиковалось, играют встроенным */
  liveVersionNo: number | null;
  /** снимок черновика уже в игре у этой аудитории: публиковать нечего */
  alreadyLive: boolean;
  /** снимок черновика уже у команды: «Всем» выкатывает то, что команда смотрела */
  onTeam: boolean;
  ready: boolean;
  reason: string | null;
  /** что изменится у игроков: черновик против версии, которая в игре у аудитории */
  changes: SnapshotChange[];
  truncated: boolean;
}

export interface CodeMergeResult {
  baseVersionNo: number;
  fromVersionNo: number;
  added: number;
  changed: boolean;
  snapshotHash: string;
}

@Injectable()
export class ContentPublishService {
  private readonly logger = new Logger("content-publish");

  constructor(
    @Inject(CONTENT_REPOSITORY) private readonly repository: ContentRepository,
    @Inject(CONTENT_PUBLISH_REPOSITORY) private readonly publications: ContentPublishRepository,
    private readonly roles: RolesService,
    @Inject(CONTENT_PUBLISH_LOCK) private readonly lock: ContentPublishLock,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
  ) {}

  async current(actor: AccountRef): Promise<ContentPointers> {
    await this.roles.require(actor, "content.view");
    return await this.publications.pointers();
  }

  /** Что случится при публикации: готовность с причиной и правки против версии, которая в игре у аудитории. */
  async preview(actor: AccountRef, draftId: string, audience: Audience): Promise<PublicationPreview> {
    await this.roles.require(actor, "content.view");
    const draft = await this.openDraft(draftId);
    const hash = snapshotHash(draft.snapshot);
    const reason = await this.blockReason(draftId, hash);
    const requireCheck = this.settings.get(SETTINGS.contentPublishRequireCheck);

    const pointers = await this.publications.pointers();
    const liveNo = (audience === "team" ? (pointers.team ?? pointers.all) : pointers.all)?.versionNo ?? null;
    const teamNo = (pointers.team ?? pointers.all)?.versionNo ?? null;
    // Без версии в игре игроки играют встроенным контентом — это версия-основа, от неё и считаются правки.
    const live = await this.repository.version(liveNo ?? draft.baseVersionNo);
    if (live === null) throw new ContentVersionNotFoundError();
    const team = teamNo === null || teamNo === live.versionNo ? live : await this.repository.version(teamNo);
    const { changes, truncated } = diffSnapshots(live.snapshot, draft.snapshot);
    return {
      audience,
      liveVersionNo: liveNo,
      alreadyLive: liveNo !== null && live.contentHash === hash,
      onTeam: team !== null && team.contentHash === hash,
      ready: !requireCheck || reason === null,
      reason: requireCheck ? reason : null,
      changes,
      truncated,
    };
  }

  /**
   * Опубликовать черновик. «Команде» ставит указатель команды, «Всем» — оба.
   * Проверка нужна всегда, кроме ключа панели `content.publish-require-check =
   * false`: тогда публикация идёт, а аудит помечает, что проверку обошли.
   */
  async publish(actor: AccountRef, draftId: string, audience: Audience, now = new Date()): Promise<PublishResult> {
    await this.roles.require(actor, "content.publish");
    const draft = await this.openDraft(draftId);
    const base = await this.repository.version(draft.baseVersionNo);
    if (base === null) throw new ContentVersionNotFoundError();
    // Форму снимка меняет код: правка `schemaVersion` из панели оставила бы старые клиенты без версии.
    if ((draft.snapshot as { schemaVersion?: unknown } | null)?.schemaVersion !== base.schemaVersion) throw new ContentSchemaChangedError();

    const hash = snapshotHash(draft.snapshot);
    const reason = await this.blockReason(draftId, hash);
    const requireCheck = this.settings.get(SETTINGS.contentPublishRequireCheck);
    if (requireCheck && reason !== null) throw new ContentCheckRequiredError(reason);

    return await this.withLock(async () => {
      const outcome = await this.publications.publish({
        contentHash: hash,
        schemaVersion: base.schemaVersion,
        snapshot: draft.snapshot,
        jsonSchema: base.jsonSchema,
        names: base.names,
        createdBy: actor.accountId,
        now,
        audiences: audience === "all" ? ["team", "all"] : ["team"],
      });
      const changed = outcome.moved.length > 0;
      const result: PublishResult = {
        audience,
        versionNo: outcome.version.versionNo,
        contentHash: outcome.version.contentHash,
        created: outcome.created,
        changed,
        previousVersionNo: outcome.previous[audience],
      };
      // Повтор, который ничего не изменил, — не событие: в журнале только то, что сработало.
      if (changed || outcome.created) {
        await this.roles.audit({
          actorAccountId: actor.accountId,
          action: "content.publish",
          target: draftId,
          before: { versionNo: result.previousVersionNo },
          after: {
            audience,
            versionNo: result.versionNo,
            contentHash: result.contentHash,
            previousVersionNo: result.previousVersionNo,
            created: result.created,
            ...(!requireCheck && reason !== null ? { checkBypassed: true } : {}),
          },
        });
      }
      return result;
    });
  }

  /** Откат: указатель аудитории — на версию, которая уже бывала в игре. Новой версии не заводит. */
  async rollback(actor: AccountRef, input: { audience: Audience; versionNo: number }, now = new Date()): Promise<RollbackResult> {
    await this.roles.require(actor, "content.publish");
    return await this.withLock(async () => {
      const outcome = await this.publications.rollback({ ...input, setBy: actor.accountId, now });
      if (outcome.outcome === "no_version") throw new ContentVersionNotFoundError();
      if (outcome.outcome === "not_published") throw new ContentRollbackInvalidError(`Версия v${String(input.versionNo)} не публиковалась — откатиться можно только на ту, что была в игре`);
      if (outcome.outcome === "nothing_published") throw new ContentRollbackInvalidError("Откатывать нечего: версию для всех ещё не публиковали");
      if (outcome.changed) {
        await this.roles.audit({
          actorAccountId: actor.accountId,
          action: "content.rollback",
          target: input.audience,
          before: { versionNo: outcome.previousVersionNo },
          after: { versionNo: input.versionNo },
        });
      }
      return { audience: input.audience, versionNo: input.versionNo, previousVersionNo: outcome.previousVersionNo, changed: outcome.changed };
    });
  }

  /**
   * «Взять из кода»: в черновик добавляются новые понятия и поля версии из
   * кода, значения, что в нём уже есть, не меняются. Основа черновика
   * переезжает на эту версию: правки дальше проверяются её схемой, а разница
   * считается от неё.
   */
  async mergeCode(actor: AccountRef, draftId: string, versionNo: number | undefined, now = new Date()): Promise<CodeMergeResult> {
    await this.roles.require(actor, "content.edit");
    const source = versionNo ?? (await this.publications.latestRepoVersion())?.versionNo;
    if (source === undefined) throw new ContentVersionNotFoundError("Версий из кода ещё нет — их заводит выкат командой content:import");
    const code = await this.repository.version(source);
    if (code === null) throw new ContentVersionNotFoundError();
    if (code.source !== "repo") throw new ContentMergeSourceError(`Версия v${String(source)} заведена панелью, а не из кода — сливать из неё нечего`);

    const made = { added: 0 };
    const outcome = await this.publications.mergeDraft(draftId, now, (current) => {
      const { merged, added } = mergeAdditions(current.snapshot, code.snapshot);
      made.added = added;
      if (added === 0) return null;
      // Слияние обязано дать снимок по схеме версии из кода: иначе правка человека, которой в коде нет, ломает форму.
      const violation = validateJsonSchema(code.jsonSchema, merged, 1)[0];
      if (violation !== undefined) throw new ContentValueError(`${formatPointer(merged, violation.pointer) || "снимок"}: ${violation.message}`);
      return { snapshot: merged, baseVersionNo: code.versionNo };
    });
    if (outcome.outcome === "missing") throw new ContentDraftNotFoundError();
    if (outcome.outcome === "archived") throw new ContentDraftArchivedError();
    if (outcome.changed) {
      await this.roles.audit({
        actorAccountId: actor.accountId,
        action: "content.draft.merge-code",
        target: draftId,
        before: { baseVersionNo: outcome.before.baseVersionNo },
        after: { baseVersionNo: outcome.after.baseVersionNo, fromVersionNo: code.versionNo, added: made.added },
      });
    }
    return { baseVersionNo: outcome.after.baseVersionNo, fromVersionNo: code.versionNo, added: made.added, changed: outcome.changed, snapshotHash: snapshotHash(outcome.after.snapshot) };
  }

  private async openDraft(draftId: string): Promise<ContentDraftRecord> {
    const draft = await this.repository.draft(draftId);
    if (draft === null) throw new ContentDraftNotFoundError();
    if (draft.archivedAt !== null) throw new ContentDraftArchivedError();
    return draft;
  }

  private async blockReason(draftId: string, hash: string): Promise<string | null> {
    const [latest, forSnapshot] = await Promise.all([this.repository.latestCheck(draftId), this.repository.reusableCheck(draftId, hash)]);
    return publishBlockReason({ latest, forSnapshot });
  }

  /** Одна публикация или откат на весь кластер; не дождался — «занято», а не тихая очередь на минуты. */
  private async withLock<T>(run: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      let taken: boolean;
      try {
        taken = await this.lock.acquire(token, LOCK_TTL_MS);
      } catch (error: unknown) {
        // Без замка публикацию не начинаем: недоступный Redis — отказ с причиной, а не гонка вслепую.
        this.logger.warn(JSON.stringify({ module: "content-publish", event: "lock_unavailable", reason: error instanceof Error ? error.message : "unknown" }));
        throw new UnavailableError("Замок публикации недоступен — попробуйте позже");
      }
      if (taken) break;
      if (Date.now() >= deadline) throw new ContentPublishBusyError();
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
    try {
      return await run();
    } finally {
      try {
        await this.lock.release(token);
      } catch (error: unknown) {
        // Срок замка снимет его сам; сбой снятия публикацию, которая уже прошла, не отменяет.
        this.logger.warn(JSON.stringify({ module: "content-publish", event: "lock_not_released", reason: error instanceof Error ? error.message : "unknown" }));
      }
    }
  }
}
