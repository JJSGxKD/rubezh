import { Inject, Injectable } from "@nestjs/common";
import { DomainError } from "../../common/domain-error";
import type { TelegramPlayer } from "./telegram-init-data";
import { DIFFICULTIES, PLAYTEST_STORE, type Difficulty, type PlaytestStore, type StoredRun } from "./playtest.store";
import type { RunSubmission, SessionReport, StressReport } from "./dto/run-submission.dto";
import { PLAYTEST_STATS_STORE, type PlaytestStatsStore } from "./playtest-stats.store";

/**
 * Сохранения и лидерборд плейтеста. Антифрода нет сознательно: это временная
 * витрина «для интереса» на время закрытого теста, данные после него
 * стираются (docs/26-stage2-plan.md, WP13). Проверяется только, что игрок —
 * настоящий пользователь Telegram, и что числа правдоподобны по форме.
 *
 * Сервис не знает об HTTP: контроллер разбирает запрос, фильтр переводит
 * ошибки в ответ (docs/15-engineering-standards.md §2.3).
 */

export const LEADERBOARD_LIMIT = 50;
const RECENT_RUNS_SHOWN = 10;

export class StoreUnavailableError extends DomainError {
  constructor() {
    super("store_unavailable", "Хранилище плейтеста недоступно, попробуйте позже", 503);
  }
}

export interface SubmitResult {
  bestSurvivalSec: number;
  isNewBest: boolean;
  rank: number | null;
  /** `false` — забег с читами без права учесть его: ни рейтинг, ни статистика не тронуты */
  recorded: boolean;
}

export interface LeaderboardView {
  difficultyId: Difficulty;
  entries: {
    rank: number;
    name: string;
    photoUrl: string | null;
    survivalSec: number;
    level: number;
    startingWeaponId: string;
    enemiesKilled: number;
    isMe: boolean;
  }[];
  me: { rank: number; survivalSec: number } | null;
  totalPlayers: number;
}

export interface ProfileView {
  runs: number;
  totalKills: number;
  totalSurvivalSec: number;
  best: Record<Difficulty, { survivalSec: number; rank: number } | null>;
  recent: Pick<StoredRun, "difficultyId" | "survivalSec" | "level" | "startingWeaponId" | "at">[];
}

@Injectable()
export class PlaytestService {
  constructor(
    @Inject(PLAYTEST_STORE) private readonly store: PlaytestStore,
    @Inject(PLAYTEST_STATS_STORE) private readonly statsStore: PlaytestStatsStore,
  ) {}

  /**
   * `admin` решает контроллер по Telegram ID, а не клиент: забег с читами
   * попадает в рейтинг, только если администратор явно попросил об этом.
   */
  async submitRun(
    player: TelegramPlayer,
    submission: RunSubmission,
    nowMs: number,
    admin = false,
  ): Promise<SubmitResult> {
    return this.guarded(async () => {
      const { cheats, countInRating, ...run } = submission;
      if (cheats && !(admin && countInRating)) {
        const [best, rank] = await Promise.all([
          this.store.best(run.difficultyId, player.id),
          this.store.rank(run.difficultyId, player.id),
        ]);
        return { bestSurvivalSec: best ?? 0, isNewBest: false, rank, recorded: false };
      }

      // Имя обновляется при каждом забеге: игрок мог сменить его в Telegram.
      await this.store.savePlayer(player);
      const stored = { ...run, at: nowMs };
      const recorded = await this.store.recordRun(player.id, stored);
      if (!recorded.duplicate) await this.statsStore.recordRun(player.id, stored, nowMs);
      const rank = await this.store.rank(run.difficultyId, player.id);
      return { bestSurvivalSec: recorded.bestSurvivalSec, isNewBest: recorded.isNewBest, rank, recorded: true };
    });
  }

  async recordSession(player: TelegramPlayer, report: SessionReport, nowMs: number): Promise<void> {
    await this.guarded(async () => {
      await this.store.savePlayer(player);
      await this.statsStore.recordSession(player.id, report, nowMs);
    });
  }

  /**
   * Итог стресс-теста. Кадры по секундам не хранятся: сводке и разбору по
   * устройствам хватает пика и причины остановки, а таймлайн на сотни корзин
   * при каждом прогоне раздул бы Redis плейтеста без пользы.
   */
  async recordStress(player: TelegramPlayer, report: StressReport, nowMs: number): Promise<{ recorded: boolean }> {
    return this.guarded(async () => {
      const { report: bench, verdict, reportId } = report.submission;
      const totals = bench.totals;
      const recorded = await this.statsStore.recordStress(
        player.id,
        {
          reportId,
          build: report.build,
          mode: bench.profile.mode,
          loadout: bench.profile.loadout,
          outcome: bench.stoppedBy ?? "duration",
          device: report.device,
          peakObjects: Math.round(totals.peakObjects ?? totals.peakLoad),
          peakEnemies: Math.round(totals.peakLoad),
          peakProjectiles: Math.round(totals.peakProjectiles ?? 0),
          avgFps: round1(totals.avgFps),
          p95FrameMs: round1(totals.p95FrameMs),
          displayHz: totals.displayHz ?? null,
          durationSec: round1(totals.durationSec),
          interruptions: bench.interruptions ?? 0,
          breakingLoad: verdict.breakingPoint === null ? null : Math.round(verdict.breakingPoint.load),
        },
        nowMs,
      );
      return { recorded };
    });
  }

  async leaderboard(playerId: string, difficulty: Difficulty): Promise<LeaderboardView> {
    return this.guarded(async () => {
      const [rows, total, rank, best] = await Promise.all([
        this.store.leaderboard(difficulty, LEADERBOARD_LIMIT),
        this.store.playerCount(difficulty),
        this.store.rank(difficulty, playerId),
        this.store.best(difficulty, playerId),
      ]);
      return {
        difficultyId: difficulty,
        // Telegram ID других игроков наружу не уходят: строка знает только,
        // «моя» ли она.
        entries: rows.map(({ playerId: id, ...row }, index) => ({ ...row, rank: index + 1, isMe: id === playerId })),
        me: rank === null || best === null ? null : { rank, survivalSec: best },
        totalPlayers: total,
      };
    });
  }

  async profile(playerId: string): Promise<ProfileView> {
    return this.guarded(async () => {
      const [stats, recent, ...bests] = await Promise.all([
        this.store.stats(playerId),
        this.store.recentRuns(playerId, RECENT_RUNS_SHOWN),
        ...DIFFICULTIES.map(async (difficulty) => {
          const [best, rank] = await Promise.all([
            this.store.best(difficulty, playerId),
            this.store.rank(difficulty, playerId),
          ]);
          return best === null || rank === null ? null : { survivalSec: best, rank };
        }),
      ]);
      return {
        ...stats,
        best: { easy: bests[0] ?? null, normal: bests[1] ?? null, hard: bests[2] ?? null },
        recent: recent.map(({ difficultyId, survivalSec, level, startingWeaponId, at }) => ({
          difficultyId,
          survivalSec,
          level,
          startingWeaponId,
          at,
        })),
      };
    });
  }

  /**
   * Недоступный Redis — не «внутренняя ошибка», а понятный ответ: клиент
   * отложит забег и отправит позже.
   */
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error: unknown) {
      if (error instanceof DomainError) throw error;
      throw new StoreUnavailableError();
    }
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
