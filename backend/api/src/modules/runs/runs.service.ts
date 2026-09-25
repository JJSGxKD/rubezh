import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { ValidationError } from "../../common/domain-error.js";
import type { AccountRef } from "../roles/roles.service.js";
import { RolesService } from "../roles/roles.service.js";
import type { RunFinish, RunStart } from "./dto/runs.dto.js";
import { LEADERBOARD_STORE, type LeaderboardStore } from "./leaderboard.store.js";
import { rebuildLeaderboard } from "./leaderboard-rebuild.js";
import type { Difficulty } from "./run-rules.js";
import { judgeRun, trustedStartMs, type RunVerdict, type VerdictReason } from "./run-verdict.js";
import { RUNS_REPOSITORY, type RunsRepository } from "./runs.repository.js";
import { RunContinues } from "./run-continues.js";
import { RunsHooks } from "./runs-hooks.js";

/**
 * Приём забегов (docs/34-stage3-plan.md, WP4): старт, итог и пересборка
 * рейтинга. Чтение — лидерборд, профиль, очередь разбора — в
 * `runs-view.service.ts`.
 *
 * **Порядок записи: сначала база, потом рейтинг.** Упал Redis после записи в
 * базу — забег не потерян, рейтинг догонится пересборкой. Наоборот было бы
 * хуже: место в рейтинге без забега, который его объясняет.
 */

export interface FinishResult {
  /** `false` — забег не в рейтинге: читы или вердикт не `ok` */
  recorded: boolean;
  verdict: RunVerdict;
  bestSurvivalSec: number;
  isNewBest: boolean;
  rank: number | null;
}

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
  ) {}

  /** Старт забега: сервер ставит свою отметку времени. Повтор из очереди — не ошибка. */
  async start(account: AccountRef, start: RunStart, nowMs = Date.now()): Promise<{ trusted: boolean }> {
    const startedAtMs = trustedStartMs(nowMs, start.elapsedSec, this.config.runs.startMaxDelaySec);
    const outcome = await this.runs.start({
      runId: start.runId,
      accountId: account.accountId,
      difficulty: start.difficultyId,
      startingWeaponId: start.startingWeaponId,
      contentHash: start.contentHash,
      startedAt: startedAtMs === null ? null : new Date(startedAtMs),
    });
    if (outcome === "foreign") throw new ValidationError("Некорректный забег");
    return { trusted: startedAtMs !== null };
  }

  async finish(account: AccountRef, run: RunFinish, nowMs = Date.now()): Promise<FinishResult> {
    const existing = await this.runs.find(run.runId);
    if (existing !== null && existing.accountId !== account.accountId) throw new ValidationError("Некорректный забег");
    // Повтор итога — тот же ответ, что в первый раз, без новой записи.
    if (existing?.status === "finished") return await this.replay(account, run.runId);

    const paid = await this.continues.check(run.runId, run.continues);
    const judged = judgeRun(
      {
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
      },
      this.config.runs,
    );
    const ranked = judged.verdict === "ok" && (!run.cheats || (run.countInRating && (await this.canCountCheats(account))));

    const outcome = await this.runs.finish({
      runId: run.runId,
      accountId: account.accountId,
      difficulty: run.difficultyId,
      startingWeaponId: run.startingWeaponId,
      contentHash: run.contentHash,
      finishedAt: new Date(nowMs),
      outcome: run.outcome,
      survivalSec: run.survivalSec,
      level: run.level,
      enemiesKilled: run.enemiesKilled,
      weapons: run.weapons,
      deathCause: run.deathCause,
      cheats: run.cheats,
      continues: run.continues,
      ranked,
      verdict: judged.verdict,
      verdictReasons: judged.reasons,
    });
    if (outcome === "foreign") throw new ValidationError("Некорректный забег");
    // Параллельный повтор успел раньше — отвечаем тем, что записал он.
    if (outcome === "duplicate") return await this.replay(account, run.runId);

    if (judged.verdict !== "ok") this.logSuspicious(account, run.runId, judged.verdict, judged.reasons);
    const result = await this.resultOf(account, run.difficultyId, run.survivalSec, judged.verdict, ranked);
    // Слушатели — после записи и без ожидания: ответ игроку не ждёт ни
    // сводки, ни очереди уведомлений.
    void this.hooks.emit({
      runId: run.runId,
      accountId: account.accountId,
      difficulty: run.difficultyId,
      outcome: run.outcome,
      survivalSec: run.survivalSec,
      level: run.level,
      enemiesKilled: run.enemiesKilled,
      startingWeaponId: run.startingWeaponId,
      deathCause: run.deathCause,
      cheats: run.cheats,
      continues: run.continues.length,
      ranked,
      verdict: judged.verdict,
      reasons: judged.reasons,
      finishedAt: new Date(nowMs),
    });
    return result;
  }

  /**
   * Пересобрать рейтинг из базы. Проекция в Redis — кеш: потерялась или
   * разошлась с базой — эта команда возвращает её к источнику истины.
   */
  async rebuildLeaderboard(): Promise<Record<string, number>> {
    return await rebuildLeaderboard(this.runs, this.leaderboard);
  }

  /**
   * Ответ на повтор итога — **по записанному забегу, а не по телу повтора**.
   * Иначе забег сдавали бы дважды: первый раз с малым временем, чтобы пройти
   * проверки, второй — тем же ключом с огромным, и `ZADD GT` поднял бы рекорд.
   */
  private async replay(account: AccountRef, runId: string): Promise<FinishResult> {
    const stored = await this.runs.find(runId);
    if (stored === null || stored.survivalSec === null) throw new ValidationError("Некорректный забег");
    return await this.resultOf(account, stored.difficulty, stored.survivalSec, stored.verdict ?? "ok", stored.ranked);
  }

  private async resultOf(
    account: AccountRef,
    difficulty: Difficulty,
    survivalSec: number,
    verdict: RunVerdict,
    ranked: boolean,
  ): Promise<FinishResult> {
    // В рейтинг пишется и на повторе: упал Redis после записи в базу — клиент
    // повторит итог, и именно этот повтор допишет место. Без этого забег
    // остался бы в базе рейтинговым, а в рейтинге отсутствовал бы до ручной
    // пересборки. Повтор безопасен сам по себе: `ZADD GT` не меняет равное
    // время и не отвечает на него «новым рекордом».
    const improved = ranked ? (await this.leaderboard.submit(difficulty, account.accountId, survivalSec)).improved : false;
    const [best, rank] = await Promise.all([
      this.leaderboard.best(difficulty, account.accountId),
      this.leaderboard.rank(difficulty, account.accountId),
    ]);
    return { recorded: ranked, verdict, bestSurvivalSec: best ?? 0, isNewBest: improved, rank };
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
   * шлёт слушатель хуков (`admin-notify`), а очередь целиком — `GET /runs/review`.
   */
  private logSuspicious(account: AccountRef, runId: string, verdict: RunVerdict, reasons: VerdictReason[]): void {
    this.logger.warn(JSON.stringify({ module: "runs", event: "run_flagged", runId, accountId: account.accountId, verdict, reasons }));
  }
}
