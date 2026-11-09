import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { DomainError, ValidationError } from "../../common/domain-error.js";
import { scoreInputOf, storedInputOf, storedScoreOf } from "../rating/run-score-input.js";
import { RunScorer, type ScoredRun } from "../rating/run-scorer.service.js";
import type { RunScoreView } from "../rating/score-types.js";
import type { AccountRef } from "../roles/roles.service.js";
import { RolesService } from "../roles/roles.service.js";
import type { RunFinish, RunStart } from "./dto/runs.dto.js";
import { LEADERBOARD_STORE, type Board, type LeaderboardStore } from "./leaderboard.store.js";
import { rebuildLeaderboard, type BoardCounts } from "./leaderboard-rebuild.js";
import { isRatedRun } from "./rated-runs.js";
import { isPrologueWin } from "./prologue-rules.js";
import { PrologueService } from "./prologue.service.js";
import { countersOf } from "./run-counters.js";
import { isRatedDifficulty, type Difficulty, type RunMode } from "./run-rules.js";
import { judgeRun, rubezhClaimsWin, rubezhWinOf, trustedStartMs, type RunVerdict, type VerdictReason } from "./run-verdict.js";
import { RatingRestrictions, boardsOf } from "./rating-restrictions.js";
import { RUNS_REPOSITORY, type RatingRestricted, type RunsRepository } from "./runs.repository.js";
import { RunContinues } from "./run-continues.js";
import { RunLoadouts } from "./run-loadouts.js";
import { detailsOf } from "./run-details.js";
import { RunsHooks } from "./runs-hooks.js";
import { RunNotFoundError } from "./runs-view.service.js";

/**
 * Приём забегов (docs/34-stage3-plan.md, WP4): старт, итог и пересборка
 * рейтинга. Чтение — лидерборд, профиль, очередь разбора — в
 * `runs-view.service.ts`.
 *
 * **Порядок записи: сначала база, потом рейтинг.** Упал Redis после записи в
 * базу — забег не потерян, рейтинг догонится пересборкой. Наоборот было бы
 * хуже: место в рейтинге без забега, который его объясняет.
 *
 * **Ограничение рейтинга** (docs/35-stage4-plan.md WP44): забег, который
 * попал бы в рейтинг, сдаётся нерейтинговым с пометкой, как ограничили. О
 * котором сообщили — ответ «не в рейтинге». Молчаливое — тень: ответ такой,
 * будто забег засчитан, с местом среди настоящих игроков, а в доски он не
 * идёт.
 *
 * **Единая сложность** (Р126, tasks/T-0191): в рейтинг идёт только забег
 * рейтинговой сложности, законченный не раньше отсечки `rating.since-date`
 * (`rated-runs.ts`). Остальные принимаются, оцениваются антифродом и
 * награждаются по-прежнему, пишутся в историю — но `ranked = false`, а ответ
 * «не в рейтинге» отдаётся без обращения к Redis. Отсечку сервис спрашивает у
 * `RatingRestrictions` на каждый вызов: она читается из памяти настроек, а не
 * из базы.
 */

/** Менять нечего: снимают уже снятый или возвращают тот, что не был снят модератором. */
export class RunRankingConflictError extends DomainError {
  constructor(ranked: boolean) {
    super("run_ranking_conflict", ranked ? "Вернуть можно только забег, снятый с рейтинга модератором" : "Этот забег уже не в рейтинге", 409);
  }
}

export interface FinishResult {
  /** `false` — забег не в рейтинге: читы или вердикт не `ok` */
  recorded: boolean;
  verdict: RunVerdict;
  /**
   * Время лучшего по очкам забега: доска ранжирует по очкам (tasks/T-0294), а
   * время идёт подписью. Поле осталось для старых клиентов до T-0296.
   */
  bestSurvivalSec: number;
  isNewBest: boolean;
  rank: number | null;
  /**
   * Очки эффективности (tasks/T-0293, Р152). Нет поля — очков нет: пролог и
   * обучение, сбой подсчёта.
   */
  score?: RunScoreView;
}

/** Забег, о котором отвечает рейтинг: его время и очки; очков нет — `null`. */
interface OwnRun {
  survivalSec: number;
  points: number | null;
}

/** Ответ без очков: места и рекорд считает рейтинг, очки добавляет приём итога. */
type PlacedResult = Omit<FinishResult, "score">;

@Injectable()
export class RunsService {
  private readonly logger = new Logger("runs");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RUNS_REPOSITORY) private readonly runs: RunsRepository,
    @Inject(LEADERBOARD_STORE) private readonly leaderboard: LeaderboardStore,
    private readonly roles: RolesService,
    private readonly hooks: RunsHooks,
    private readonly continues: RunContinues,
    private readonly loadouts: RunLoadouts,
    private readonly rating: RatingRestrictions,
    // Нет сервиса пролога (старый состав модуля) — все забеги бесконечные, награды пролога нет.
    @Optional() private readonly prologue?: PrologueService,
    // Без подсчёта очков (сбой подключения, тесты других модулей) забег принимается как раньше: очков нет.
    @Optional() @Inject(RunScorer) private readonly scorer: RunScorer | null = null,
  ) {}

  /** Старт забега: сервер ставит свою отметку времени. Повтор из очереди — не ошибка. */
  async start(account: AccountRef, start: RunStart, nowMs = Date.now()): Promise<{ trusted: boolean }> {
    const startedAtMs = trustedStartMs(nowMs, start.elapsedSec, this.config.runs.startMaxDelaySec);
    const mode = await this.modeOf(account, start.mode, start.difficultyId);
    const outcome = await this.runs.start({
      runId: start.runId,
      accountId: account.accountId,
      difficulty: start.difficultyId,
      mode,
      startingWeaponId: start.startingWeaponId,
      contentHash: start.contentHash,
      startedAt: startedAtMs === null ? null : new Date(startedAtMs),
    });
    if (outcome === "foreign") throw new ValidationError("Некорректный забег");
    if (outcome === "created") void this.hooks.emitStarted({ runId: start.runId, accountId: account.accountId, at: new Date(nowMs) });
    return { trusted: startedAtMs !== null };
  }

  async finish(account: AccountRef, run: RunFinish, nowMs = Date.now()): Promise<FinishResult> {
    const existing = await this.runs.find(run.runId);
    if (existing !== null && existing.accountId !== account.accountId) throw new ValidationError("Некорректный забег");
    // Повтор итога — тот же ответ, что в первый раз, без новой записи.
    if (existing?.status === "finished") return await this.replay(account, run.runId);

    const [paid, loadout, boosts] = await Promise.all([
      this.continues.check(run.runId, run.continues),
      this.loadouts.check(account.accountId, run.loadout),
      this.loadouts.checkBoosts(account.accountId, run.runId, run.boosts),
    ]);
    const counters = countersOf(run.stats);
    const mode = await this.modeOf(account, run.mode, run.difficultyId);
    // Очки считаются только у рейтинговой сложности: пролог и обучение идут на `easy` и очков не получают.
    // Исходные числа кладутся в строку и при сбое подсчёта — `runs:rescore` досчитает по ним.
    const scorable = isRatedDifficulty(run.difficultyId);
    const scored = scorable ? (this.scorer?.score(scoreInputOf(run)) ?? null) : null;
    const judged = judgeRun(
      {
        counters,
        survivalSec: run.survivalSec,
        level: run.level,
        enemiesKilled: run.enemiesKilled,
        weaponCount: run.weapons.length,
        contentHash: run.contentHash,
        startedAtMs: existing?.startedAt?.getTime() ?? null,
        finishedAtMs: nowMs,
        continues: run.continues.length,
        paidContinues: paid.paid,
        underpaidContinues: paid.underpaid,
        cheats: run.cheats,
        loadout,
        boosts,
        rubezh: run.rubezh ?? null,
        axisOutOfRange: scored?.outOfRange ?? false,
      },
      this.config.runs,
    );
    // Победа для рейтинга и награды: заявлена, правдоподобна, без читов. Вердикт `ok` и рейтинговость проверяет `ranked`.
    const rubezhCleared = rubezhWinOf(run.rubezh, judged.reasons);
    // Нерейтинговый забег ограничений рейтинга не касается: `held` для него не нужен и не вычисляется.
    const rated = isRatedRun(run.difficultyId, new Date(nowMs), this.rating.since());
    // Пролог в рейтинг не идёт ни при каких условиях (Р151): сложность у него и так нерейтинговая, но правило не должно зависеть от неё.
    const rankable = rated && mode !== "prologue" && judged.verdict === "ok" && (!run.cheats || (run.countInRating && (await this.canCountCheats(account))));
    const held = rankable ? await this.rating.hold(account.accountId, new Date(nowMs)) : null;
    const ranked = rankable && held === null;
    // Лучшее в тени — до записи этого забега: иначе не понять, новый ли это рекорд.
    const shadowBefore = held === "silent" ? ((await this.runs.bestRunOf(account.accountId, run.difficultyId, true, this.rating.since()))?.points ?? null) : undefined;

    // Награда пролога и признак — до записи забега: упал приём посередине, повтор итога пройдёт этот путь целиком,
    // а начисление по ключу аккаунта не удвоится. Повтор уже записанного итога сюда не доходит (`replay` выше).
    if (this.prologue !== undefined && isPrologueWin({ mode, won: run.prologue?.won, sec: run.prologue?.sec, survivalSec: run.survivalSec, verdict: judged.verdict })) {
      await this.prologue.settle({ accountId: account.accountId, at: new Date(nowMs), ...(run.prologue === undefined ? {} : { sec: run.prologue.sec }) });
    }
    const outcome = await this.runs.finish({
      runId: run.runId,
      accountId: account.accountId,
      difficulty: run.difficultyId,
      mode,
      startingWeaponId: run.startingWeaponId,
      contentHash: run.contentHash,
      finishedAt: new Date(nowMs),
      outcome: run.outcome,
      survivalSec: run.survivalSec,
      level: run.level,
      enemiesKilled: run.enemiesKilled,
      weapons: run.weapons,
      details: detailsOf({ passives: run.passives, stats: run.stats }),
      deathCause: run.deathCause,
      cheats: run.cheats,
      continues: run.continues,
      ranked,
      ratingRestricted: held,
      verdict: judged.verdict,
      verdictReasons: judged.reasons,
      rubezhReached: run.rubezh?.reached ?? false,
      rubezhClearedSec: run.rubezh?.clearedSec ?? null,
      score: scored === null ? null : storedScoreOf(scored),
      scoreInput: scorable ? storedInputOf(run) : null,
    });
    if (outcome === "foreign") throw new ValidationError("Некорректный забег");
    // Параллельный повтор успел раньше — отвечаем тем, что записал он.
    if (outcome === "duplicate") return await this.replay(account, run.runId);

    if (judged.verdict !== "ok") this.logSuspicious(account, run.runId, judged.verdict, judged.reasons);
    const placed = await this.resultOf(account, run.difficultyId, { survivalSec: run.survivalSec, points: scored?.points ?? null }, judged.verdict, ranked, held, rubezhCleared && !run.cheats, shadowBefore);
    const view = this.viewOf(scored);
    const result: FinishResult = view === null ? placed : { ...placed, score: view };
    // Слушатели — после записи и без ожидания: ответ игроку не ждёт ни
    // сводки, ни очереди уведомлений.
    void this.hooks.emit({
      runId: run.runId,
      accountId: account.accountId,
      difficulty: run.difficultyId,
      mode,
      outcome: run.outcome,
      survivalSec: run.survivalSec,
      points: scored?.points ?? null,
      level: run.level,
      enemiesKilled: run.enemiesKilled,
      startingWeaponId: run.startingWeaponId,
      weapons: run.weapons.map((weapon) => ({ id: weapon.id, level: weapon.level })),
      boosts: boosts === "paid" ? [...run.boosts] : [],
      xpCollected: run.stats?.xpCollected ?? null,
      // Неправдоподобные счётчики в задания и достижения не идут.
      counters: judged.reasons.includes("counters_implausible") ? null : counters,
      deathCause: run.deathCause,
      cheats: run.cheats,
      continues: run.continues.length,
      ranked,
      verdict: judged.verdict,
      reasons: judged.reasons,
      finishedAt: new Date(nowMs),
      rubezhCleared,
    });
    if (result.score !== undefined) void this.scorer?.announce(account, run.runId, result.score);
    return result;
  }

  /** Режим записи (`prologue-rules.ts` → `admitMode`); без сервиса пролога любой забег бесконечный. */
  private async modeOf(account: AccountRef, mode: RunMode | undefined, difficulty: Difficulty): Promise<RunMode> {
    return this.prologue === undefined ? "endless" : await this.prologue.admit(account.accountId, mode, difficulty);
  }

  /**
   * Пересобрать рейтинг из базы. Проекция в Redis — кеш: потерялась или
   * разошлась с базой — эта команда возвращает её к источнику истины.
   */
  async rebuildLeaderboard(): Promise<Record<string, BoardCounts>> {
    const [excluded, separate] = await Promise.all([this.rating.excluded(), this.rating.separate()]);
    return await rebuildLeaderboard(this.runs, this.leaderboard, new Set(excluded), new Set(separate), this.rating.since());
  }

  /**
   * Снять забег с рейтинга или вернуть (docs/35-stage4-plan.md WP44, часть
   * 3б): ограничение рейтинга закрывает его на срок, а сомнительный рекорд до
   * ограничения иначе вернулся бы вместе с игроком. Доска сложности
   * пересчитывается по лучшему оставшемуся рейтинговому забегу; игроку с
   * закрытым рейтингом её не трогаем — вернётся по сроку уже без снятого.
   */
  async setRanked(actor: AccountRef, runId: string, ranked: boolean, comment: string): Promise<{ accountId: string; ranked: boolean }> {
    await this.roles.require(actor, "players.restrict");
    const stored = await this.runs.find(runId);
    if (stored === null || stored.status !== "finished") throw new RunNotFoundError();
    // Нерейтинговую сложность и забег раньше отсечки база не меняет: условие — в самом обновлении.
    const since = this.rating.since();
    const changed = await this.runs.setRanked(runId, ranked, since);
    if (changed === null) throw new RunRankingConflictError(ranked);

    if ((await this.rating.hold(changed.accountId)) === null) {
      // Правится то, что положено аккаунту: отдельная доска — только полная, остальные — обе.
      const boards = await this.rating.boardsFor(changed.accountId);
      const best = await this.runs.bestRunOf(changed.accountId, changed.difficulty, false, since);
      await this.leaderboard.set(changed.difficulty, changed.accountId, best?.points ?? null, boards);
      // Отметка рубежа идёт за лучшими забегами: снятый победный забег её не оставляет, если другой победы нет.
      await this.leaderboard.setRubezh(changed.difficulty, changed.accountId, (await this.runs.rubezhWinners(changed.difficulty, since, [changed.accountId])).length > 0);
      // Забег, сданный между чтением и записью, затёрт точной записью; итог пишет базу раньше доски — второе чтение его видит.
      const after = await this.runs.bestRunOf(changed.accountId, changed.difficulty, false, since);
      if (after?.points != null && after.points !== best?.points) await this.leaderboard.submit(changed.difficulty, changed.accountId, after.points, boards);
    }
    // Недельная таблица сезона и другие проекции пересчитываются по базе: решение модератора они узнают отсюда.
    await this.hooks.emitRankingChanged({ accountId: changed.accountId, difficulty: changed.difficulty });
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: ranked ? "players.run.rerank" : "players.run.unrank",
      target: changed.accountId,
      // Направление — в названии действия; в записи — какой забег и почему, чтобы журнал читался без карточки.
      after: { runId, difficulty: changed.difficulty, survivalSec: changed.survivalSec, comment },
    });
    this.logger.log(JSON.stringify({ module: "runs", event: ranked ? "run_reranked" : "run_unranked", runId, accountId: changed.accountId, actor: actor.accountId }));
    return { accountId: changed.accountId, ranked };
  }

  /**
   * Ответ на повтор итога — **по записанному забегу, а не по телу повтора**.
   * Иначе забег сдавали бы дважды: первый раз с малым временем, чтобы пройти
   * проверки, второй — тем же ключом с огромным, и `ZADD GT` поднял бы рекорд.
   */
  private async replay(account: AccountRef, runId: string): Promise<FinishResult> {
    const stored = await this.runs.find(runId);
    if (stored === null || stored.survivalSec === null) throw new ValidationError("Некорректный забег");
    // Отсечку могли сдвинуть, а доску пересобрать после первого ответа: забег, который ей уже не удовлетворяет,
    // в чистую доску не пишется, как бы ни была помечена его строка (легаси: `ranked = true` у всех сложностей).
    const ranked = stored.ranked && stored.finishedAt !== null && isRatedRun(stored.difficulty, stored.finishedAt, this.rating.since());
    // Победа — по записанному забегу: упавший Redis чинится повтором вместе с отметкой.
    const rubezhWon = stored.verdict === "ok" && !stored.cheats && rubezhClaimsWin({ reached: stored.rubezhReached, clearedSec: stored.rubezhClearedSec });
    const placed = await this.resultOf(account, stored.difficulty, { survivalSec: stored.survivalSec, points: stored.score?.points ?? null }, stored.verdict ?? "ok", ranked, stored.ratingRestricted, rubezhWon);
    // Очки — как записаны: повтор не считает их заново и не обращается к таблице.
    if (stored.score === null || this.scorer === null) return placed;
    return { ...placed, score: { ...stored.score, expectedPoints: this.scorer.expectedPointsFor(stored.score.axes.t) } };
  }

  private viewOf(scored: ScoredRun | null): RunScoreView | null {
    return scored === null ? null : { points: scored.points, axes: scored.axes, style: scored.style, band: scored.band, expectedPoints: scored.expectedPoints };
  }

  private async resultOf(
    account: AccountRef,
    difficulty: Difficulty,
    own: OwnRun,
    verdict: RunVerdict,
    ranked: boolean,
    held: RatingRestricted | null,
    rubezhWon: boolean,
    shadowBefore?: number | null,
  ): Promise<PlacedResult> {
    // Нерейтинговая сложность: ни места, ни лучшего, и Redis не нужен — ни на первом ответе, ни на повторе.
    if (!isRatedDifficulty(difficulty)) return { recorded: false, verdict, bestSurvivalSec: 0, isNewBest: false, rank: null };
    // Рейтинговый забег на повторе: ограничение могли наложить между итогом
    // и повтором — тогда в доску его не пишем.
    const hold = held ?? (ranked ? await this.rating.hold(account.accountId) : null);
    // Доска читается один раз: пишется в неё же, оттуда же берутся лучшее и место.
    const board = await this.rating.boardOf(account.accountId);
    if (hold === "silent") return await this.shadowResult(account, difficulty, own, verdict, shadowBefore, board);
    // В рейтинг пишется и на повторе: упал Redis после записи в базу — клиент
    // повторит итог, и именно этот повтор допишет место. Без этого забег
    // остался бы в базе рейтинговым, а в рейтинге отсутствовал бы до ручной
    // пересборки. Повтор безопасен сам по себе: `ZADD GT` не меняет равный
    // счёт и не отвечает на него «новым рекордом».
    const placed = ranked && hold === null;
    // Доска ранжирует по очкам (T-0294): забег без очков (сбой подсчёта) на ней не стоит, но победа над стражем засчитывается.
    const improved = placed && own.points !== null ? (await this.leaderboard.submit(difficulty, account.accountId, own.points, boardsOf(board), rubezhWon)).improved : false;
    if (placed && own.points === null && rubezhWon) await this.leaderboard.setRubezh(difficulty, account.accountId, true);
    const [best, rank] = await Promise.all([this.leaderboard.best(difficulty, account.accountId, board), this.leaderboard.rank(difficulty, account.accountId, board)]);
    // Время лучшего по очкам забега — подпись к доске; в доске его нет, оно читается из базы.
    const caption = best === null ? 0 : ((await this.runs.bestRunOf(account.accountId, difficulty, false, this.rating.since()))?.survivalSec ?? own.survivalSec);
    return { recorded: ranked, verdict, bestSurvivalSec: caption, isNewBest: improved, rank };
  }

  /**
   * Ответ в тени: лучшее — со сданными под молчаливым ограничением, место —
   * среди настоящих игроков его доски, как если бы он в ней был. Повтор итога
   * (`shadowBefore` не передан) рекордом не называется — как и у настоящей
   * доски.
   */
  private async shadowResult(account: AccountRef, difficulty: Difficulty, own: OwnRun, verdict: RunVerdict, shadowBefore: number | null | undefined, board: Board): Promise<PlacedResult> {
    const stored = await this.runs.bestRunOf(account.accountId, difficulty, true, this.rating.since());
    // Лучший по очкам из записанного (в нём уже есть этот забег) и самого забега; время идёт подписью того же забега.
    const options: { points: number; survivalSec: number }[] = [];
    if (stored?.points != null) options.push({ points: stored.points, survivalSec: stored.survivalSec });
    if (own.points !== null) options.push({ points: own.points, survivalSec: own.survivalSec });
    const best = options.reduce((top, next) => (next.points > top.points ? next : top), options[0] ?? { points: 0, survivalSec: own.survivalSec });
    const rank = (await this.leaderboard.countAbove(difficulty, best.points, board)) + 1;
    const isNewBest = shadowBefore !== undefined && own.points !== null && (shadowBefore === null || own.points > shadowBefore);
    return { recorded: true, verdict, bestSurvivalSec: best.survivalSec, isNewBest, rank };
  }

  /**
   * Забег с читами учитывается в рейтинге, только если об этом попросил
   * человек с правом `tools.dev` — так проверяют рейтинг на своих забегах.
   * Флаг клиента сам по себе не решает ничего.
   */
  private async canCountCheats(account: AccountRef): Promise<boolean> {
    return await this.roles.can(account, "tools.dev");
  }

  /**
   * Подозрительный забег — в лог с причинами. Карточку в чат администраторов
   * шлёт слушатель хуков (`admin-notify`), а очередь целиком — в панели (`GET /api/v1/admin/runs/review`).
   */
  private logSuspicious(account: AccountRef, runId: string, verdict: RunVerdict, reasons: VerdictReason[]): void {
    this.logger.warn(JSON.stringify({ module: "runs", event: "run_flagged", runId, accountId: account.accountId, verdict, reasons }));
  }
}
