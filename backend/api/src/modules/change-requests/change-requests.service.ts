import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { ChangeRequestClosedError, ChangeRequestExpiredError, ChangeRequestNotAuthorError, ChangeRequestNotFoundError, ChangeRequestOwnError, ChangeRequestStaleError } from "./change-request-errors.js";
import { ChangeKindRegistry } from "./change-request-kinds.js";
import { expiresAt, isExpired, sameJson } from "./change-request-rules.js";
import {
  CHANGE_TTL_HOURS,
  CHANGE_TTL_MS,
  CLOSED_VISIBLE_DAYS,
  LIST_LIMIT,
  proposeSchema,
  type ChangeOverview,
  type ChangeRequestRow,
  type ChangeRequestView,
} from "./change-request-types.js";
import { ChangeRequestsNotifier } from "./change-requests-notifier.js";
import { CHANGE_REQUESTS_REPOSITORY, type ChangeRequestsRepository } from "./change-requests.repository.js";

/**
 * Заявки на правку с подтверждением второго участника (docs/19-content-admin.md
 * §6, tasks/T-0309). Ход заявки:
 *
 * 1. человек с правом предлагает «было → стало» с причиной; «было» берёт сервер,
 *    форму и пределы проверяет вид правки; прежняя живая заявка на ту же цель
 *    гасится (`superseded`), просроченная — закрывается как `expired`;
 * 2. другой человек с тем же правом подтверждает — автор не может, даже
 *    владелец; в одной транзакции под блокировкой цели проверяется, что цель всё
 *    ещё равна «было», и правка применяется. Изменилась — 409, заявка `superseded`;
 * 3. отклонить может любой другой с правом, отозвать — только автор; обе заявки
 *    закрываются как `rejected` с тем, кто решил.
 *
 * Аудит — заявка, подтверждение, отклонение, применение. Сбой журнала или
 * уведомления не отменяет решение: оно уже в базе.
 */

const DAY_MS = 86_400_000;
const DB_TIMEOUT_MS = 3_000;
/** Уведомление и чат — довесок к заявке: ждать их дольше пары секунд панель не должна. */
const NOTIFY_TIMEOUT_MS = 8_000;

type Decision = "reject" | "withdraw";

@Injectable()
export class ChangeRequestsService {
  private readonly logger = new Logger("change-requests");

  constructor(
    @Inject(CHANGE_REQUESTS_REPOSITORY) private readonly repository: ChangeRequestsRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    private readonly roles: RolesService,
    private readonly kinds: ChangeKindRegistry,
    private readonly notifier: ChangeRequestsNotifier,
  ) {}

  /** Живые и недавно закрытые заявки и цели правки. Просроченные закрываются здесь же — отдельного задания нет. */
  async overview(actor: AccountRef, now = new Date()): Promise<ChangeOverview> {
    await this.roles.require(actor, "sku.price.view");
    // Просрочена с `created + 72 ч` включительно, а выборка строго «раньше»: миллисекунда закрывает границу.
    await withTimeout(this.repository.expireOverdue(new Date(now.getTime() - CHANGE_TTL_MS + 1), now), DB_TIMEOUT_MS, "заявки на правку");
    const rows = await withTimeout(this.repository.list(new Date(now.getTime() - CLOSED_VISIBLE_DAYS * DAY_MS), LIST_LIMIT), DB_TIMEOUT_MS, "заявки на правку");
    const views = await this.views(rows);
    const targets: ChangeOverview["targets"] = {};
    for (const handler of this.kinds.all()) targets[handler.kind] = await handler.targets();
    // Живые сверху: их ждут решения, закрытые — история.
    const requests = [...views.filter((view) => view.status === "pending"), ...views.filter((view) => view.status !== "pending")];
    return { requests, targets, ttlHours: CHANGE_TTL_HOURS };
  }

  async propose(actor: AccountRef, input: unknown, now = new Date()): Promise<ChangeRequestView> {
    const parsed = proposeSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError("Некорректная заявка: нужны вид, цель, правка и причина до 200 знаков");
    const { kind, target, after, reason } = parsed.data;
    const handler = this.kinds.get(kind);
    await this.roles.require(actor, handler.permission);

    const created = await this.repository.locked(kind, target, async (session) => {
      const prepared = await handler.prepare(session.tx, target, after);
      const superseded: string[] = [];
      for (const old of await session.pending(kind, target)) {
        // Просроченная живой уже не была: честный исход — срок, а не новая заявка.
        const expired = isExpired(old, now);
        await session.close(old.requestId, expired ? "expired" : "superseded", null, now);
        if (!expired) superseded.push(old.requestId);
      }
      const row: ChangeRequestRow = {
        requestId: randomUUID(),
        kind,
        target,
        before: prepared.before,
        after: prepared.after,
        reason,
        author: actor.accountId,
        status: "pending",
        decidedBy: null,
        decidedAt: null,
        createdAt: now,
      };
      await session.insert(row);
      return { row, superseded };
    });

    const { row } = created;
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "change_request.create",
      target: row.requestId,
      after: { kind, target, before: row.before, after: row.after, reason, supersedes: created.superseded },
    });
    this.log("created", { requestId: row.requestId, kind, target, author: actor.accountId, supersedes: created.superseded });
    const [view] = await this.views([row]);
    if (view === undefined) throw new Error("заявка не собралась в вид");
    await this.notify(view);
    return view;
  }

  /**
   * Подтвердить: другой участник с правом. Статус, срок, «цель всё ещё равна
   * было» и запись правки — одна транзакция под блокировкой цели; закрывается
   * заявка до записи, чтобы проход срока не опередил применение.
   */
  async approve(actor: AccountRef, requestId: string, now = new Date()): Promise<ChangeRequestView> {
    const found = await this.find(requestId);
    const handler = this.kinds.get(found.kind);
    await this.roles.require(actor, handler.permission);
    if (found.author === actor.accountId) throw new ChangeRequestOwnError();

    const outcome = await this.repository.locked(found.kind, found.target, async (session) => {
      const request = await session.find(requestId);
      if (request === null) return { type: "missing" } as const;
      if (request.status !== "pending") return { type: "closed", status: request.status } as const;
      if (isExpired(request, now)) {
        await session.close(requestId, "expired", null, now);
        return { type: "expired" } as const;
      }
      if (!sameJson(await handler.current(session.tx, request), request.before)) {
        await session.close(requestId, "superseded", null, now);
        return { type: "stale" } as const;
      }
      if (!(await session.close(requestId, "approved", actor.accountId, now))) return { type: "closed", status: "expired" } as const;
      await handler.apply(session.tx, request, actor.accountId, now);
      return { type: "approved", request: { ...request, status: "approved", decidedBy: actor.accountId, decidedAt: now } satisfies ChangeRequestRow } as const;
    });

    switch (outcome.type) {
      case "missing":
        throw new ChangeRequestNotFoundError();
      case "closed":
        throw new ChangeRequestClosedError(outcome.status);
      case "expired":
        throw new ChangeRequestExpiredError();
      case "stale":
        this.log("stale", { requestId, kind: found.kind, target: found.target, actor: actor.accountId });
        throw new ChangeRequestStaleError();
      case "approved": {
        const { request } = outcome;
        handler.afterCommit(request);
        await this.roles.audit({ actorAccountId: actor.accountId, action: "change_request.approve", target: requestId, before: { status: "pending" }, after: { status: "approved", kind: request.kind, target: request.target } });
        await this.roles.audit({ actorAccountId: actor.accountId, action: "change_request.apply", target: `${request.kind}:${request.target}`, before: request.before, after: request.after });
        this.log("approved", { requestId, kind: request.kind, target: request.target, author: request.author, approver: actor.accountId });
        return await this.view(request);
      }
    }
  }

  /** Отклонить: другой участник с правом. Автору — только «отозвать». */
  async reject(actor: AccountRef, requestId: string, now = new Date()): Promise<ChangeRequestView> {
    return await this.decide(actor, requestId, "reject", now);
  }

  /** Отозвать: только автор. Исход тот же — `rejected`, но решил сам автор. */
  async withdraw(actor: AccountRef, requestId: string, now = new Date()): Promise<ChangeRequestView> {
    return await this.decide(actor, requestId, "withdraw", now);
  }

  private async decide(actor: AccountRef, requestId: string, decision: Decision, now: Date): Promise<ChangeRequestView> {
    const found = await this.find(requestId);
    await this.roles.require(actor, this.kinds.get(found.kind).permission);
    const own = found.author === actor.accountId;
    if (decision === "reject" && own) throw new ChangeRequestOwnError();
    if (decision === "withdraw" && !own) throw new ChangeRequestNotAuthorError();

    const outcome = await this.repository.locked(found.kind, found.target, async (session) => {
      const request = await session.find(requestId);
      if (request === null) return { type: "missing" } as const;
      if (request.status !== "pending") return { type: "closed", status: request.status } as const;
      if (isExpired(request, now)) {
        await session.close(requestId, "expired", null, now);
        return { type: "expired" } as const;
      }
      if (!(await session.close(requestId, "rejected", actor.accountId, now))) return { type: "closed", status: "expired" } as const;
      return { type: "done", request: { ...request, status: "rejected", decidedBy: actor.accountId, decidedAt: now } satisfies ChangeRequestRow } as const;
    });

    switch (outcome.type) {
      case "missing":
        throw new ChangeRequestNotFoundError();
      case "closed":
        throw new ChangeRequestClosedError(outcome.status);
      case "expired":
        throw new ChangeRequestExpiredError();
      case "done": {
        const action = decision === "reject" ? "change_request.reject" : "change_request.withdraw";
        await this.roles.audit({ actorAccountId: actor.accountId, action, target: requestId, before: { status: "pending" }, after: { status: "rejected", kind: found.kind, target: found.target } });
        this.log(decision === "reject" ? "rejected" : "withdrawn", { requestId, kind: found.kind, target: found.target, actor: actor.accountId });
        return await this.view(outcome.request);
      }
    }
  }

  private async find(requestId: string): Promise<ChangeRequestRow> {
    const row = await withTimeout(this.repository.find(requestId), DB_TIMEOUT_MS, "заявка на правку");
    if (row === null) throw new ChangeRequestNotFoundError();
    return row;
  }

  private async view(row: ChangeRequestRow): Promise<ChangeRequestView> {
    const [view] = await this.views([row]);
    if (view === undefined) throw new Error("заявка не собралась в вид");
    return view;
  }

  /** Заявки с именами людей: в базе только идентификаторы, а панели нужны имена. */
  private async views(rows: readonly ChangeRequestRow[]): Promise<ChangeRequestView[]> {
    const ids = [...new Set(rows.flatMap((row) => (row.decidedBy === null ? [row.author] : [row.author, row.decidedBy])))];
    const names = ids.length === 0 ? new Map<string, string>() : await withTimeout(this.accounts.displayNames(ids), DB_TIMEOUT_MS, "имена участников");
    return rows.map((row) => ({
      ...row,
      authorName: names.get(row.author) ?? null,
      decidedByName: row.decidedBy === null ? null : (names.get(row.decidedBy) ?? null),
      expiresAt: expiresAt(row),
    }));
  }

  /** Не бросает: заявка уже в базе, и упавший чат не должен превращать её в ошибку запроса. */
  private async notify(view: ChangeRequestView): Promise<void> {
    try {
      await withTimeout(this.notifier.requested(view), NOTIFY_TIMEOUT_MS, "уведомление о заявке");
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "change-requests", event: "notify_failed", requestId: view.requestId, reason: error instanceof Error ? error.message : "unknown" }));
    }
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ module: "change-requests", event, ...fields }));
  }
}
