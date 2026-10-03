import { Inject, Injectable, Logger } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { AccountRestrictions } from "./account-restrictions.js";
import { RESTRICTION_CATALOG, RESTRICTION_KINDS, RESTRICTION_REASONS, isRestrictionKind, type RestrictionKind, type RestrictionKindInfo } from "./restriction-catalog.js";
import { banMessage, imposeProblem, isActive, restrictionView, termProblem, type ImposeInput, type RestrictionView } from "./restriction-rules.js";
import { RestrictionAccountNotFoundError, RestrictionNotFoundError } from "./restrictions-errors.js";
import { RESTRICTIONS_REPOSITORY, type RestrictionRow, type RestrictionsRepository } from "./restrictions.repository.js";

/**
 * Наложение и снятие ограничений (docs/35-stage4-plan.md Р75, WP44). Каждое
 * действие — в журнал аудита: кто, кому, что, на сколько и почему.
 *
 * Последствия вне таблицы — у блокировки целиком: `account.banned_at`, по
 * которому вход отказывает. Наложение ставит его сразу, снятие — сразу, а
 * истечение срока убирает задача раз в минуту (`restrictions-settler.ts`):
 * блокировка на сутки длится сутки и не больше минуты сверх.
 *
 * Сессии заблокированного отзывает панель: они живут в модулях входа и
 * панели, а модуль ограничений от них не зависит.
 */

const DB_TIMEOUT_MS = 3_000;
const HISTORY_SHOWN = 100;
const SETTLE_BATCH = 200;

export interface RestrictionCatalogView {
  kinds: (RestrictionKindInfo & { kind: RestrictionKind })[];
  reasons: { reason: string; title: string; player: string }[];
}

@Injectable()
export class RestrictionsService {
  private readonly logger = new Logger(RestrictionsService.name);

  constructor(
    @Inject(RESTRICTIONS_REPOSITORY) private readonly repository: RestrictionsRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    private readonly roles: RolesService,
    private readonly gate: AccountRestrictions,
  ) {}

  catalog(): RestrictionCatalogView {
    return {
      kinds: RESTRICTION_KINDS.map((kind) => ({ kind, ...RESTRICTION_CATALOG[kind] })),
      reasons: Object.entries(RESTRICTION_REASONS).map(([reason, text]) => ({ reason, ...text })),
    };
  }

  async impose(actor: AccountRef, accountId: string, input: ImposeInput, at = new Date()): Promise<RestrictionView[]> {
    for (const permission of new Set(input.kinds.map((kind) => RESTRICTION_CATALOG[kind].permission))) await this.roles.require(actor, permission);
    if (actor.accountId === accountId) throw new ValidationError("Ограничить себя нельзя");
    const endsAt = input.endsAt === null ? null : new Date(input.endsAt);
    const problem = termProblem(endsAt, at) ?? imposeProblem(input.kinds, input.notify);
    if (problem !== null) throw new ValidationError(problem);
    if ((await this.db(this.accounts.byId(accountId))) === null) throw new RestrictionAccountNotFoundError();

    const rows = input.kinds.map((kind) => ({ accountId, kind, startsAt: at, endsAt, reason: input.reason, comment: input.comment, notify: input.notify, imposedBy: actor.accountId }));
    const { created, replaced } = await this.db(this.repository.impose(rows, at));
    const banned = created.find((row) => row.kind === "all");
    if (banned !== undefined) await this.db(this.accounts.setBan(accountId, { at, reason: banMessage(banned) }));
    // Заменённые снимаются без своих последствий: новое ограничение того же
    // вида их и так держит.
    await this.db(this.repository.markSettled(replaced.map((row) => row.restrictionId), at));
    await this.gate.forget(accountId);

    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "players.restrict",
      target: accountId,
      ...(replaced.length === 0 ? {} : { before: { replaced: replaced.map(auditOf) } }),
      after: { restrictions: created.map(auditOf) },
    });
    for (const row of created) this.log("account_restricted", { accountId, actor: actor.accountId, kind: row.kind, endsAt: row.endsAt?.toISOString() ?? null, reason: row.reason, notify: row.notify });
    return await this.views(created, at);
  }

  /** Снять действующее ограничение — с причиной, она остаётся в истории. */
  async lift(actor: AccountRef, restrictionId: string, comment: string, at = new Date()): Promise<RestrictionView> {
    const row = await this.db(this.repository.byId(restrictionId));
    if (row === null || !isActive(row, at)) throw new RestrictionNotFoundError();
    await this.roles.require(actor, isRestrictionKind(row.kind) ? RESTRICTION_CATALOG[row.kind].permission : "players.ban");
    const lifted = await this.db(this.repository.lift(restrictionId, actor.accountId, comment, at));
    if (lifted === null) throw new RestrictionNotFoundError();
    await this.settle([lifted], at);

    await this.roles.audit({ actorAccountId: actor.accountId, action: "players.unrestrict", target: row.accountId, before: auditOf(row), after: { comment } });
    this.log("account_restriction_lifted", { accountId: row.accountId, actor: actor.accountId, kind: row.kind, early: true });
    const [view] = await this.views([lifted], at);
    if (view === undefined) throw new RestrictionNotFoundError();
    return view;
  }

  /** Снять все действующие ограничения вида — так снимает блокировку прежняя кнопка «Снять блокировку». */
  async liftKind(actor: AccountRef, accountId: string, kind: RestrictionKind, comment: string, at = new Date()): Promise<number> {
    const active = (await this.db(this.repository.active(accountId, at))).filter((row) => row.kind === kind);
    for (const row of active) await this.lift(actor, row.restrictionId, comment, at);
    return active.length;
  }

  /** История аккаунта для карточки в панели — новые сверху. */
  async history(actor: AccountRef, accountId: string, at = new Date()): Promise<RestrictionView[]> {
    await this.roles.require(actor, "players.view");
    return await this.views(await this.db(this.repository.byAccount(accountId, HISTORY_SHOWN)), at);
  }

  /**
   * Снять последствия истёкших и снятых: блокировку убрать, если другой
   * действующей блокировки у игрока нет. Зовёт задача по сроку; повтор
   * безопасен — снятое отмечено и второй раз не выбирается.
   */
  async settleDue(at = new Date()): Promise<number> {
    const due = await this.db(this.repository.unsettled(at, SETTLE_BATCH));
    await this.settle(due, at);
    return due.length;
  }

  private async settle(rows: readonly RestrictionRow[], at: Date): Promise<void> {
    for (const accountId of new Set(rows.map((row) => row.accountId))) {
      const mine = rows.filter((row) => row.accountId === accountId);
      if (mine.some((row) => row.kind === "all")) {
        const stillBanned = (await this.db(this.repository.active(accountId, at))).some((row) => row.kind === "all");
        if (!stillBanned) {
          await this.db(this.accounts.setBan(accountId, null));
          this.log("account_unbanned", { accountId, early: mine.some((row) => row.liftedAt !== null) });
        }
      }
      await this.db(this.repository.markSettled(mine.map((row) => row.restrictionId), at));
      for (const row of mine.filter((candidate) => candidate.liftedAt === null)) this.log("account_restriction_lifted", { accountId, kind: row.kind, early: false });
      await this.gate.forget(accountId);
    }
  }

  /** Строки для панели с именами тех, кто наложил и снял. */
  private async views(rows: readonly RestrictionRow[], at: Date): Promise<RestrictionView[]> {
    const ids = new Set(rows.flatMap((row) => [row.imposedBy, row.liftedBy]).filter((id): id is string => id !== null));
    const names = new Map<string, string>();
    for (const id of ids) {
      const account = await this.db(this.accounts.byId(id));
      if (account !== null) names.set(id, account.displayName);
    }
    return rows.map((row) => restrictionView(row, at, names));
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "restrictions: база");
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ module: "restrictions", event, ...fields }));
  }
}

/** В журнал — вид, срок, причина, комментарий и «сообщить»: этого хватает, чтобы понять решение. */
function auditOf(row: RestrictionRow): Record<string, unknown> {
  return { restrictionId: row.restrictionId, kind: row.kind, endsAt: row.endsAt?.toISOString() ?? null, reason: row.reason, comment: row.comment, notify: row.notify };
}
