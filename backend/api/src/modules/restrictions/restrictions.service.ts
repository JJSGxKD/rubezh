import { Inject, Injectable, Logger } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { AccountRestrictions } from "./account-restrictions.js";
import { RESTRICTION_CATALOG, RESTRICTION_KINDS, RESTRICTION_LIMITS, RESTRICTION_REASONS, isHiddenKind, isRestrictionKind, type RestrictionKind, type RestrictionKindInfo, type RestrictionReason } from "./restriction-catalog.js";
import { banMessage, imposeProblem, isActive, restrictionView, shownText, termProblem, type ImposeInput, type PreviewInput, type RestrictionView } from "./restriction-rules.js";
import { HIDDEN_KIND_PERMISSION, IMPOSE_INVALID_TEXT, PREVIEW_INVALID_TEXT, hasHiddenKind, imposedAuditAction, liftedAuditAction, visibleRows } from "./restriction-visibility.js";
import { RestrictionAccountNotFoundError, RestrictionNotFoundError } from "./restrictions-errors.js";
import { RestrictionsHooks } from "./restrictions-hooks.js";
import { RESTRICTIONS_REPOSITORY, type NewRestriction, type RestrictionRow, type RestrictionsRepository } from "./restrictions.repository.js";

/**
 * Наложение и снятие ограничений (docs/35-stage4-plan.md Р75, WP44). Каждое
 * действие — в журнал аудита: кто, кому, что, на сколько и почему.
 *
 * Последствия вне таблицы — у блокировки целиком `account.banned_at`, по
 * которому вход отказывает, у рейтинга — место в досках (слушатель
 * `RestrictionsHooks` в модуле забегов). Наложение ставит их сразу, снятие —
 * сразу, а истечение срока снимает задача раз в минуту
 * (`restrictions-settler.ts`): ограничение на сутки длится сутки и не больше
 * минуты сверх. Не снялось — строка не отмечается сведённой, и задача
 * повторит её на следующем проходе.
 *
 * Сессии заблокированного отзывает панель: они живут в модулях входа и
 * панели, а модуль ограничений от них не зависит.
 */

const DB_TIMEOUT_MS = 3_000;
const HISTORY_SHOWN = 100;
const SETTLE_BATCH = 200;

/** Что увидит игрок по каждому виду и что не так с черновиком — до наложения. */
export interface RestrictionPreview {
  problem: string | null;
  shown: { kind: RestrictionKind; title: string; text: string }[];
}

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
    private readonly hooks: RestrictionsHooks,
  ) {}

  /** Скрытые виды в каталоге — только тому, у кого есть право вида (T-0112). */
  async catalog(actor: AccountRef): Promise<RestrictionCatalogView> {
    const withHidden = await this.roles.can(actor, HIDDEN_KIND_PERMISSION);
    return {
      kinds: RESTRICTION_KINDS.filter((kind) => withHidden || !RESTRICTION_CATALOG[kind].hidden).map((kind) => ({ kind, ...RESTRICTION_CATALOG[kind] })),
      reasons: Object.entries(RESTRICTION_REASONS).map(([reason, text]) => ({ reason, ...text })),
    };
  }

  /**
   * Черновик глазами игрока: тексты — тем же кодом, что отказ, а проблема —
   * та же, на которой упадёт наложение. Ничего не пишет.
   */
  async preview(actor: AccountRef, input: PreviewInput, at = new Date()): Promise<RestrictionPreview> {
    await this.hideFromBlind(actor, input.kinds, PREVIEW_INVALID_TEXT);
    const endsAt = input.endsAt === null ? null : new Date(input.endsAt);
    return {
      problem: termProblem(endsAt, at) ?? imposeProblem(input.kinds, input.notify),
      shown: input.kinds.map((kind) => ({ kind, title: RESTRICTION_CATALOG[kind].title, text: shownText(kind, endsAt, input.reason, input.notify) })),
    };
  }

  async impose(actor: AccountRef, accountId: string, input: ImposeInput, at = new Date()): Promise<RestrictionView[]> {
    await this.hideFromBlind(actor, input.kinds, IMPOSE_INVALID_TEXT);
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
    await this.afterImposed(actor.accountId, accountId, created, replaced, at);
    return await this.views(created, at);
  }

  /**
   * Наложить от имени системы — без права и без автора: решение принял не модератор, а правило
   * (возврат оплаты, tasks/T-0024). Бессрочно, с сообщением игроку; снять может человек в панели
   * тем же правом вида. Повторное наложение того же вида заменяет действующее, как у человека.
   * Блокировку целиком система не накладывает — её решает человек.
   */
  async imposeBySystem(accountId: string, kind: RestrictionKind, reason: RestrictionReason, comment: string, at = new Date()): Promise<void> {
    if (kind === "all") throw new ValidationError("Систему блокировать целиком не просим: блокировка — решение человека");
    const row: NewRestriction = { accountId, kind, startsAt: at, endsAt: null, reason, comment: comment.slice(0, RESTRICTION_LIMITS.commentMax), notify: true, imposedBy: null };
    const { created, replaced } = await this.db(this.repository.impose([row], at));
    await this.afterImposed(null, accountId, created, replaced, at);
  }

  /** Что идёт за записью строк: сведение заменённых, кеш, слушатели, журнал аудита и лог. `actorId` — `null`: система. */
  private async afterImposed(actorId: string | null, accountId: string, created: readonly RestrictionRow[], replaced: readonly RestrictionRow[], at: Date): Promise<void> {
    // Заменённые снимаются без своих последствий: новое ограничение того же
    // вида их и так держит.
    await this.db(this.repository.markSettled(replaced.map((row) => row.restrictionId), at));
    await this.gate.forget(accountId);
    await this.hooks.emitImposed({ accountId, kinds: created.map((row) => row.kind), at });

    await this.roles.audit({
      actorAccountId: actorId,
      action: imposedAuditAction(created.map((row) => row.kind)),
      target: accountId,
      ...(replaced.length === 0 ? {} : { before: { replaced: replaced.map(auditOf) } }),
      after: { restrictions: created.map(auditOf) },
    });
    for (const row of created) this.log("account_restricted", { accountId, actor: actorId, kind: row.kind, endsAt: row.endsAt?.toISOString() ?? null, reason: row.reason, notify: row.notify });
  }

  /** Снять действующее ограничение — с причиной, она остаётся в истории. */
  async lift(actor: AccountRef, restrictionId: string, comment: string, at = new Date()): Promise<RestrictionView> {
    const row = await this.db(this.repository.byId(restrictionId));
    if (row === null || !isActive(row, at)) throw new RestrictionNotFoundError();
    // Скрытую строку без права не видно вовсе: ответ тот же, что на несуществующую.
    if (isHiddenKind(row.kind) && !(await this.roles.can(actor, HIDDEN_KIND_PERMISSION))) throw new RestrictionNotFoundError();
    await this.roles.require(actor, isRestrictionKind(row.kind) ? RESTRICTION_CATALOG[row.kind].permission : "players.ban");
    const lifted = await this.db(this.repository.lift(restrictionId, actor.accountId, comment, at));
    if (lifted === null) throw new RestrictionNotFoundError();
    await this.settle([lifted], at);

    await this.roles.audit({ actorAccountId: actor.accountId, action: liftedAuditAction(row.kind), target: row.accountId, before: auditOf(row), after: { comment } });
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
    const rows = await this.db(this.repository.byAccount(accountId, HISTORY_SHOWN));
    return await this.views(visibleRows(rows, await this.roles.can(actor, HIDDEN_KIND_PERMISSION)), at);
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
      try {
        await this.settleAccount(accountId, mine, at);
      } catch (error: unknown) {
        // Снятие уже записано; последствия догонит задача по сроку — строки не отмечены.
        this.logger.warn(JSON.stringify({ module: "restrictions", event: "restriction_settle_failed", accountId, reason: error instanceof Error ? error.message : "unknown" }));
      }
    }
  }

  private async settleAccount(accountId: string, mine: readonly RestrictionRow[], at: Date): Promise<void> {
    if (mine.some((row) => row.kind === "all")) {
      const stillBanned = (await this.db(this.repository.active(accountId, at))).some((row) => row.kind === "all");
      if (!stillBanned) {
        await this.db(this.accounts.setBan(accountId, null));
        this.log("account_unbanned", { accountId, early: mine.some((row) => row.liftedAt !== null) });
      }
    }
    // Сначала забыть ответ «можно ли»: слушатели спросят его заново и
    // должны увидеть, что ограничения больше нет.
    await this.gate.forget(accountId);
    await this.hooks.emitSettled({ accountId, kinds: mine.map((row) => row.kind), at });
    await this.db(this.repository.markSettled(mine.map((row) => row.restrictionId), at));
    for (const row of mine.filter((candidate) => candidate.liftedAt === null)) this.log("account_restriction_lifted", { accountId, kind: row.kind, early: false });
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

  /**
   * Скрытый вид без права отказывает так же, как на кривое тело, а не «нет
   * права»: иначе сам ответ подсказал бы, что вид есть.
   */
  private async hideFromBlind(actor: AccountRef, kinds: readonly RestrictionKind[], message: string): Promise<void> {
    if (!hasHiddenKind(kinds)) return;
    if (!(await this.roles.can(actor, HIDDEN_KIND_PERMISSION))) throw new ValidationError(message);
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
