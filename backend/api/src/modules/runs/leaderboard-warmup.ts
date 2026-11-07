import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { RUN_SCORES_REPOSITORY, type RunScoresRepository } from "../rating/run-scores.repository.js";
import { RunScorer } from "../rating/run-scorer.service.js";
import { rescoreRuns } from "../rating/runs-rescore.js";
import { rebuildLeaderboard } from "./leaderboard-rebuild.js";
import { LEADERBOARD_STORE, type LeaderboardStore } from "./leaderboard.store.js";
import { RELEASE_SCRIPT, RatingRestrictions } from "./rating-restrictions.js";
import { RATED_DIFFICULTIES } from "./run-rules.js";
import { RUNS_REPOSITORY, type RunsRepository } from "./runs.repository.js";

/**
 * Первое наполнение доски всех времён по очкам (tasks/T-0294). Доска живёт под
 * ключами `runs:leaderboard:pts:…`, и после выката они пусты: забеги до очков
 * очков не имеют, а в проекции лежат только новые. Окна «доска пуста, пока
 * владелец не вспомнит про две команды» быть не должно, поэтому при старте
 * сервис сам проверяет, пуста ли доска рейтинговой сложности, и если да —
 * досчитывает очки забегов без них и пересобирает доску из базы, то есть делает
 * то же, что `runs:rescore --only-unscored`, а затем `runs:rebuild-leaderboard`.
 *
 * - **Идемпотентно.** Очки — функция строки и настроек, пересборка подменяет
 *   ключ одной командой: повторный старт ничего не портит, а заполненная доска
 *   (ключ есть) останавливает проверку на первой же команде.
 * - **Одна реплика.** Лок `SET NX PX`; после взятия лока проверка повторяется —
 *   соседняя реплика могла успеть наполнить доску, пока эта ждала.
 * - **Не держит старт.** Проверка идёт до приёма запросов, а долгая часть — в
 *   фоне: приложение не ждёт пересчёта большой таблицы забегов, и пока он идёт,
 *   доска всех времён наполняется. Сбой пишется в лог, а команды остаются
 *   запасным путём.
 * - Игроки с закрытым рейтингом и с отдельной доской раскладываются так же,
 *   как в команде пересборки.
 */

const LOCK_KEY = "runs:leaderboard-warmup:lock";
/** Пересчёт большой таблицы идёт долго; лок отпускается в конце, а срок — страховка от упавшей реплики. */
const LOCK_TTL_MS = 15 * 60_000;
const BATCH_SIZE = 500;
const REDIS_TIMEOUT_MS = 2_000;

export interface WarmupReport {
  /** забегов без очков, которым очки поставлены */
  rescored: number;
  /** забегов, которым очки поставить не удалось (таблица ожидаемого не загрузилась) */
  unscored: number;
  /** игроков в полной доске каждой рейтинговой сложности */
  boards: Record<string, number>;
}

@Injectable()
export class LeaderboardWarmup implements OnApplicationBootstrap {
  private readonly logger = new Logger("runs");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "eval">,
    @Inject(RUNS_REPOSITORY) private readonly runs: RunsRepository,
    @Inject(LEADERBOARD_STORE) private readonly leaderboard: LeaderboardStore,
    @Inject(RUN_SCORES_REPOSITORY) private readonly scores: RunScoresRepository,
    private readonly scorer: RunScorer,
    private readonly rating: RatingRestrictions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.databaseUrl === "") return;
    try {
      // Дешёвая проверка — до приёма запросов, чтобы забег, принятый первым, не создал ключ раньше неё.
      if (!(await this.needed())) return;
    } catch (error: unknown) {
      this.log("warn", "leaderboard_warmup_check_failed", { reason: reasonOf(error) });
      return;
    }
    void this.warm();
  }

  /** Пуста ли полная доска хотя бы одной рейтинговой сложности: ключа нет или в нём никого. */
  async needed(): Promise<boolean> {
    for (const difficulty of RATED_DIFFICULTIES) {
      if ((await withTimeout(this.leaderboard.count(difficulty, "full"), REDIS_TIMEOUT_MS, "runs: рейтинг")) === 0) return true;
    }
    return false;
  }

  /**
   * Наполнить доску: `null` — не запускалось (доска уже есть, лок у другой
   * реплики) или упало (причина в логе), иначе отчёт. Никогда не бросает.
   */
  async warm(): Promise<WarmupReport | null> {
    let token: string | null = null;
    try {
      token = randomUUID();
      if ((await withTimeout(this.redis.set(LOCK_KEY, token, "PX", LOCK_TTL_MS, "NX"), REDIS_TIMEOUT_MS, "runs: лок наполнения")) === null) {
        token = null;
        return null;
      }
      // Пока ждали лок, соседняя реплика могла уже всё наполнить.
      if (!(await this.needed())) return null;
      return await this.fill();
    } catch (error: unknown) {
      this.log("warn", "leaderboard_warmup_failed", { reason: reasonOf(error) });
      return null;
    } finally {
      if (token !== null) await this.release(token);
    }
  }

  private async fill(): Promise<WarmupReport> {
    const since = this.rating.since();
    const rescore = await rescoreRuns(this.scores, this.scorer, { since, batchSize: BATCH_SIZE, onlyUnscored: true });
    const [excluded, separate] = await Promise.all([this.rating.excluded(), this.rating.separate()]);
    const counts = await rebuildLeaderboard(this.runs, this.leaderboard, new Set(excluded), new Set(separate), since);
    const boards = Object.fromEntries(Object.entries(counts).map(([difficulty, count]) => [difficulty, count.full]));
    this.log("log", "leaderboard_warmed_up", { rescored: rescore.rescored, unscored: rescore.unscored, boards });
    return { rescored: rescore.rescored, unscored: rescore.unscored, boards };
  }

  private async release(token: string): Promise<void> {
    try {
      await withTimeout(this.redis.eval(RELEASE_SCRIPT, 1, LOCK_KEY, token), REDIS_TIMEOUT_MS, "runs: лок наполнения");
    } catch (error: unknown) {
      // Лок истечёт сам по сроку; на результат наполнения это не влияет.
      this.log("warn", "leaderboard_warmup_unlock_failed", { reason: reasonOf(error) });
    }
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "runs", event, ...fields }));
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
