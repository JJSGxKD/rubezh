import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { DomainError } from "../../common/domain-error.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { RunScorer } from "../rating/run-scorer.service.js";
import type { StoredScoreInput } from "../rating/score-types.js";
import type { AccountRef } from "../roles/roles.service.js";
import { RolesService } from "../roles/roles.service.js";
import type { StoredDetails } from "./run-details.js";
import { availableActions, decide, returnableToRating, TRANSITIONS, type ReviewAction, type ReviewOutcome } from "./run-review-rules.js";
import { RUN_REVIEW_REPOSITORY, type RunReportRow, type RunReviewRepository } from "./run-review.repository.js";
import { RatingRestrictions } from "./rating-restrictions.js";
import { RunNotFoundError } from "./runs-view.service.js";
import { RunRankingConflictError, RunsService } from "./runs.service.js";

/**
 * Отчёт забега для разбора и три решения команды (Р203, tasks/T-0419):
 * «Честный», «Аннулировать» и «Вернуть забег». Страницу отчёта рисует панель;
 * здесь — что в нём показать и что решения делают с забегом и досками.
 *
 * Решение — одно условное обновление колонки `review_outcome`
 * (`run-review.repository.ts`): два одновременных нажатия дают одну запись
 * журнала, проигравший перечитывает строку и отвечает «то же самое» или
 * отказом по таблице переходов (`run-review-rules.ts`).
 *
 * **Рейтинг не пересчитывается здесь.** Снять забег с досок и вернуть его —
 * дело `RunsService.setRanked`: тот же путь, что у «Не учитывать…» и
 * «Вернуть…» карточки игрока. Доска сложности собирается по лучшему забегу,
 * недельная таблица **текущего** сезона пересчитывается по базе, закрытые
 * сезоны, их итоги (`season_result`), награды и кошелёк не меняются.
 */

/** Решение отклонено состоянием забега: «Честный» не там, где проверка вопросов не нашла, и так далее. */
export class RunReviewConflictError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message, 409);
  }
}

/** Отказ по состоянию забега; ошибка создаётся на каждый отказ, чтобы стек указывал на вызов, а не на загрузку модуля. */
function conflictOf(decision: "not_in_review" | "already_annulled" | "not_annulled"): RunReviewConflictError {
  switch (decision) {
    case "not_in_review":
      return new RunReviewConflictError("run_not_in_review", "Забег не в разборе: проверка не нашла в нём вопросов");
    case "already_annulled":
      return new RunReviewConflictError("run_annulled", "Забег аннулирован — вернуть его можно кнопкой «Вернуть забег»");
    case "not_annulled":
      return new RunReviewConflictError("run_not_annulled", "Забег не аннулирован — возвращать нечего");
  }
}

/** Причина в «Честном» необязательна; в рейтинг и журнал `setRanked` уходит эта строка. */
const HONEST_COMMENT = "Разбор: честный забег";

/** Сколько раз решение перечитывает строку после проигранной гонки: одного хватает, второй — запас на встречное решение. */
const MARK_ATTEMPTS = 3;

export interface RunReportView {
  runId: string;
  accountId: string;
  displayName: string | null;
  difficulty: string;
  mode: string;
  startedAt: string | null;
  finishedAt: string;
  outcome: "died" | "abandoned" | null;
  survivalSec: number | null;
  level: number | null;
  enemiesKilled: number | null;
  deathCause: string | null;
  weapons: { id: string; level: number; damage: number | null }[];
  details: StoredDetails | null;
  continues: number[];
  cheats: boolean;
  contentHash: string;
  rubezh: { reached: boolean; clearedSec: number | null };
  verdict: "ok" | "suspicious" | "rejected" | null;
  verdictReasons: string[];
  /** `returnable` — «Честный» и «Вернуть забег» вернут забег в рейтинг (`returnableToRating`) */
  rating: { ranked: boolean; ratingRestricted: "notified" | "silent" | null; returnable: boolean };
  score: { points: number; axes: { t: number; k: number; h: number; c: number; b: number }; style: string; band: string; expectedPoints: number | null } | null;
  scoreInput: StoredScoreInput | null;
  review: { outcome: ReviewOutcome | null; reviewedAt: string | null; reviewedBy: string | null; reviewerName: string | null };
  /** что разрешает состояние забега; права панель проверяет сама */
  actions: { honest: boolean; annul: boolean; restore: boolean };
}

/** Имя записи журнала и строка лога у каждого решения. */
const JOURNAL: Record<ReviewAction, { action: string; event: string }> = {
  honest: { action: "players.run.honest", event: "run_review_honest" },
  annul: { action: "players.run.annul", event: "run_review_annulled" },
  restore: { action: "players.run.restore", event: "run_review_restored" },
};

@Injectable()
export class RunReviewService {
  private readonly logger = new Logger("runs");

  constructor(
    @Inject(RUN_REVIEW_REPOSITORY) private readonly repository: RunReviewRepository,
    private readonly runs: RunsService,
    private readonly rating: RatingRestrictions,
    private readonly roles: RolesService,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    // Без подсчёта очков (сбой подключения, тесты) отчёт читается как раньше: ожидаемых очков нет.
    @Optional() @Inject(RunScorer) private readonly scorer: RunScorer | null = null,
  ) {}

  /** Отчёт забега: итог, вердикт и причины, очки и данные подсчёта, состояние разбора. */
  async report(actor: AccountRef, runId: string): Promise<RunReportView> {
    await this.roles.require(actor, "players.view");
    return await this.viewOf(await this.rowOf(runId));
  }

  /** «Честный»: забег снят с очереди; годный для рейтинга — возвращён в текущие доски. */
  async honest(actor: AccountRef, runId: string, comment: string | null): Promise<RunReportView> {
    return await this.decideRun("honest", actor, runId, comment);
  }

  /** «Аннулировать»: забег убран из досок рейтинга и сезона; награды не отнимаются. */
  async annul(actor: AccountRef, runId: string, comment: string): Promise<RunReportView> {
    return await this.decideRun("annul", actor, runId, comment);
  }

  /** «Вернуть забег»: отмена аннулирования; годный для рейтинга забег — снова в текущей доске. */
  async restore(actor: AccountRef, runId: string, comment: string): Promise<RunReportView> {
    return await this.decideRun("restore", actor, runId, comment);
  }

  private async decideRun(action: ReviewAction, actor: AccountRef, runId: string, comment: string | null): Promise<RunReportView> {
    await this.roles.require(actor, "players.restrict");
    let row = await this.rowOf(runId);
    let applied = false;
    let before: ReviewOutcome | null = row.reviewOutcome;

    for (let attempt = 1; ; attempt += 1) {
      const decision = decide(action, row);
      if (decision === "not_in_review" || decision === "already_annulled" || decision === "not_annulled") throw conflictOf(decision);
      if (decision === "same") break;
      before = row.reviewOutcome;
      const { to, from } = TRANSITIONS[action];
      if (await this.repository.mark(runId, to, from, actor.accountId, new Date())) {
        applied = true;
        break;
      }
      // Гонку выиграл другой вызов: что с забегом теперь, решает таблица переходов.
      if (attempt >= MARK_ATTEMPTS) throw new RunReviewConflictError("run_review_busy", "Забег решают одновременно — отчёт нужно открыть заново");
      row = await this.rowOf(runId);
    }

    if (applied) await this.journal(action, actor, row, before, comment);
    await this.syncRating(action, applied, actor, row, comment);
    const current = await this.rowOf(runId);
    if (applied) this.logger.log(JSON.stringify({ module: "runs", event: JOURNAL[action].event, runId, accountId: row.accountId, actor: actor.accountId, ranked: current.ranked }));
    return await this.viewOf(current);
  }

  /**
   * Запись решения в журнал действий команды: какой забег, что в нём
   * нашла проверка и почему решили. Пишется один раз — только тем вызовом,
   * чьё обновление прошло.
   */
  private async journal(action: ReviewAction, actor: AccountRef, row: RunReportRow, before: ReviewOutcome | null, comment: string | null): Promise<void> {
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: JOURNAL[action].action,
      target: row.accountId,
      // Прежнее состояние — там, где оно говорит что-то помимо названия действия: строже, чем «честный», и отмена аннулирования.
      ...(action === "restore" || (action === "annul" && before === "honest") ? { before: { reviewOutcome: before } } : {}),
      after: { runId: row.runId, verdict: row.verdict, reasons: row.verdictReasons, comment, ...(action === "annul" ? { wasRanked: row.ranked } : {}) },
    });
  }

  /**
   * Рейтинг — тем же путём, что у «Не учитывать…» и «Вернуть…» карточки игрока.
   * `RunRankingConflictError` — не ошибка решения: забег уже там, куда его
   * ведут, или не годен по базе (условие в самом обновлении); решение записано,
   * ответ покажет нынешний `rating.ranked`.
   */
  private async syncRating(action: ReviewAction, applied: boolean, actor: AccountRef, row: RunReportRow, comment: string | null): Promise<void> {
    if (action === "annul") {
      // Повтор уже аннулированного, но ещё рейтингового забега доделывает снятие: прошлый вызов мог упасть посередине.
      if (row.ranked) await this.setRanked(actor, row.runId, false, comment ?? "");
      return;
    }
    // Повтор «Честного» и «Вернуть забег» рейтинг не трогает: сорвавшийся возврат делается в карточке игрока кнопкой «Вернуть…».
    if (applied && !row.ranked && returnableToRating(row, this.rating.since())) await this.setRanked(actor, row.runId, true, comment ?? HONEST_COMMENT);
  }

  private async setRanked(actor: AccountRef, runId: string, ranked: boolean, comment: string): Promise<void> {
    try {
      await this.runs.setRanked(actor, runId, ranked, comment);
    } catch (error: unknown) {
      if (!(error instanceof RunRankingConflictError)) throw error;
    }
  }

  private async rowOf(runId: string): Promise<RunReportRow> {
    const row = await this.repository.report(runId);
    if (row === null) throw new RunNotFoundError();
    return row;
  }

  private async viewOf(row: RunReportRow): Promise<RunReportView> {
    const names = await this.accounts.displayNames(row.reviewedBy === null ? [row.accountId] : [row.accountId, row.reviewedBy]);
    return {
      runId: row.runId,
      accountId: row.accountId,
      displayName: names.get(row.accountId) ?? null,
      difficulty: row.difficulty,
      mode: row.mode,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt.toISOString(),
      outcome: row.outcome,
      survivalSec: row.survivalSec,
      level: row.level,
      enemiesKilled: row.enemiesKilled,
      deathCause: row.deathCause,
      weapons: row.weapons,
      details: row.details,
      continues: row.continues,
      cheats: row.cheats,
      contentHash: row.contentHash,
      rubezh: { reached: row.rubezhReached, clearedSec: row.rubezhClearedSec },
      verdict: row.verdict,
      verdictReasons: row.verdictReasons,
      rating: { ranked: row.ranked, ratingRestricted: row.ratingRestricted, returnable: returnableToRating(row, this.rating.since()) },
      score: row.score === null ? null : { ...row.score, expectedPoints: this.scorer?.expectedPointsFor(row.score.axes.t) ?? null },
      scoreInput: row.scoreInput,
      review: {
        outcome: row.reviewOutcome,
        reviewedAt: row.reviewedAt?.toISOString() ?? null,
        reviewedBy: row.reviewedBy,
        reviewerName: row.reviewedBy === null ? null : (names.get(row.reviewedBy) ?? null),
      },
      actions: availableActions(row),
    };
  }
}
