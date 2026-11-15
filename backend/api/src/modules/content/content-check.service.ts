import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { DomainError, UnavailableError } from "../../common/domain-error.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { CONTENT_CHECK_QUEUE, type CheckJobState, type ContentCheckQueue } from "./content-check.queue.js";
import { ContentCheckNotFoundError, ContentDraftArchivedError, ContentDraftNotFoundError, ContentVersionNotFoundError } from "./content-errors.js";
import { snapshotHash } from "./content-hash.js";
import { CONTENT_REPOSITORY, type ContentCheckRecord, type ContentCheckStatus, type ContentRepository } from "./content.repository.js";

/**
 * Проверка черновика контента (docs/19-content-admin.md §4.3, tasks/T-0303):
 * сервер ставит в очередь задание `content-check` с черновиком и базой,
 * `sim-worker` проверяет схемой, проверками контента и ботами калибровки и
 * возвращает отчёт тем же заданием.
 *
 * Итог читается при опросе, а не слушается событием: опрашивать может любая
 * реплика, закрытие проверки идемпотентно (`UPDATE … WHERE status = 'queued'`),
 * и фонового потребителя, который пришлось бы выбирать между репликами, нет.
 * Платит за это отчёт, который никто не спросил: результат живёт в Redis час,
 * потом проверка считается потерянной.
 */

/** Ждущих до пяти, каждое — до двух минут, плюс идущее и запас: дольше проверка в очереди не живёт. */
export const CHECK_QUEUED_MAX_MS = 15 * 60_000;
/** Только поставленное задание Redis мог ещё не показать: до этого срока «нет в очереди» — не потеря. */
export const CHECK_MISSING_GRACE_MS = 60_000;

export interface ContentCheckView {
  checkId: string;
  draftId: string;
  snapshotHash: string;
  status: ContentCheckStatus;
  /** итог воркера (`schemaProblems`, `contentProblems`, `report`, `elapsedMs`) или `{ error }`; `null` — ещё считается */
  report: unknown;
  createdAt: Date;
}

export interface StartedCheck {
  check: ContentCheckView;
  /** `true` — тот же снимок уже проверялся (или проверяется), нового задания нет */
  reused: boolean;
}

const problemSchema = z.object({ path: z.string(), message: z.string() });
/** Итог воркера пришёл из Redis: разбираем форму, а остальное (медианы, коридоры) храним как есть. */
const workerResultSchema = z.looseObject({
  checkId: z.string(),
  schemaProblems: z.array(problemSchema),
  contentProblems: z.array(problemSchema),
  report: z.looseObject({ timeout: z.boolean() }).nullable(),
  elapsedMs: z.number(),
});

function viewOf(check: ContentCheckRecord): ContentCheckView {
  return { checkId: check.checkId, draftId: check.draftId, snapshotHash: check.snapshotHash, status: check.status, report: check.report, createdAt: check.createdAt };
}

@Injectable()
export class ContentCheckService {
  private readonly logger = new Logger("content-check");

  constructor(
    @Inject(CONTENT_REPOSITORY) private readonly repository: ContentRepository,
    private readonly roles: RolesService,
    @Inject(CONTENT_CHECK_QUEUE) private readonly queue: ContentCheckQueue,
  ) {}

  /**
   * Поставить проверку черновика. Тот же снимок, что уже проверяли, — прошлый
   * отчёт без нового прогона; упавшая проверка не считается — её повторяют.
   */
  async start(actor: AccountRef, draftId: string, now = new Date()): Promise<StartedCheck> {
    await this.roles.require(actor, "content.edit");
    const draft = await this.repository.draft(draftId);
    if (draft === null) throw new ContentDraftNotFoundError();
    if (draft.archivedAt !== null) throw new ContentDraftArchivedError();
    const hash = snapshotHash(draft.snapshot);

    const reusable = await this.reusable(draftId, hash, now);
    if (reusable !== null) return { check: viewOf(reusable), reused: true };

    const base = await this.repository.version(draft.baseVersionNo);
    if (base === null) throw new ContentVersionNotFoundError();
    const record: ContentCheckRecord = { checkId: randomUUID(), draftId, snapshotHash: hash, status: "queued", report: null, createdAt: now };
    const stored = await this.repository.addCheck(record);
    // Параллельный запрос успел раньше: его задание уже стоит, второго не надо.
    if (stored.checkId !== record.checkId) return { check: viewOf(stored), reused: true };

    try {
      await this.queue.submit({ checkId: record.checkId, snapshot: draft.snapshot, baseSnapshot: base.snapshot });
    } catch (error: unknown) {
      // Задание не встало — проверки нет: запись, оставшаяся «в очереди», навсегда заняла бы пару (черновик, снимок).
      await this.repository.removeCheck(record.checkId);
      if (error instanceof DomainError) throw error;
      this.logger.warn(JSON.stringify({ module: "content-check", event: "submit_failed", reason: error instanceof Error ? error.message : "unknown" }));
      throw new UnavailableError("Очередь проверок недоступна — попробуйте позже");
    }
    await this.roles.audit({ actorAccountId: actor.accountId, action: "content.check.start", target: draftId, after: { checkId: record.checkId, snapshotHash: hash } });
    return { check: viewOf(record), reused: false };
  }

  /** Проверка по идентификатору; в очереди — забирает итог воркера, если он готов. */
  async read(actor: AccountRef, checkId: string, now = new Date()): Promise<ContentCheckView> {
    await this.roles.require(actor, "content.view");
    const check = await this.repository.check(checkId);
    if (check === null) throw new ContentCheckNotFoundError();
    return viewOf(await this.sync(check, now));
  }

  /** Живая проверка пары: ждущую сверяем с очередью — она могла давно закончиться или пропасть. */
  private async reusable(draftId: string, hash: string, now: Date): Promise<ContentCheckRecord | null> {
    const found = await this.repository.reusableCheck(draftId, hash);
    if (found === null) return null;
    const synced = await this.sync(found, now);
    return synced.status === "failed" ? null : synced;
  }

  private async sync(check: ContentCheckRecord, now: Date): Promise<ContentCheckRecord> {
    if (check.status !== "queued") return check;
    const age = now.getTime() - check.createdAt.getTime();
    let state: CheckJobState;
    try {
      state = await this.queue.poll(check.checkId);
    } catch (error: unknown) {
      // Redis не ответил — состояния не знаем: проверка остаётся в очереди, пока не вышел общий срок.
      this.logger.warn(JSON.stringify({ module: "content-check", event: "poll_failed", reason: error instanceof Error ? error.message : "unknown" }));
      return age > CHECK_QUEUED_MAX_MS ? await this.close(check, "failed", { error: "Воркер не ответил: очередь недоступна" }) : check;
    }

    if (state.state === "finished") {
      const parsed = workerResultSchema.safeParse(state.result);
      if (!parsed.success) return await this.close(check, "failed", { error: "Воркер вернул отчёт неожиданной формы" });
      return await this.close(check, parsed.data.report?.timeout === true ? "timeout" : "done", parsed.data);
    }
    if (state.state === "failed") return await this.close(check, "failed", { error: state.reason });
    if (state.state === "missing" && age >= CHECK_MISSING_GRACE_MS) {
      await this.queue.cancel(check.checkId);
      return await this.close(check, "failed", { error: "Воркер не ответил: задание пропало из очереди" });
    }
    if (age > CHECK_QUEUED_MAX_MS) {
      await this.queue.cancel(check.checkId);
      return await this.close(check, "failed", { error: "Воркер не ответил за 15 минут — проверка снята" });
    }
    return check;
  }

  /** Закрыть проверку; перечитать: её мог закрыть другой опрос, и верен тот итог, что в базе. */
  private async close(check: ContentCheckRecord, status: Exclude<ContentCheckStatus, "queued">, report: unknown): Promise<ContentCheckRecord> {
    await this.repository.finishCheck(check.checkId, status, report);
    return (await this.repository.check(check.checkId)) ?? { ...check, status, report };
  }
}
