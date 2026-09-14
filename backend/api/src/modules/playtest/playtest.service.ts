import { Inject, Injectable } from "@nestjs/common";
import { DomainError } from "../../common/domain-error";
import type { TelegramPlayer } from "./telegram-init-data";
import { DIFFICULTIES, PLAYTEST_STORE, type Difficulty, type PlaytestStore, type StoredRun } from "./playtest.store";
import type { RunSubmission } from "./dto/run-submission.dto";

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
  constructor(@Inject(PLAYTEST_STORE) private readonly store: PlaytestStore) {}

  async submitRun(player: TelegramPlayer, submission: RunSubmission, nowMs: number): Promise<SubmitResult> {
    return this.guarded(async () => {
      // Имя обновляется при каждом забеге: игрок мог сменить его в Telegram.
      await this.store.savePlayer(player);
      const recorded = await this.store.recordRun(player.id, { ...submission, at: nowMs });
      const rank = await this.store.rank(submission.difficultyId, player.id);
      return { bestSurvivalSec: recorded.bestSurvivalSec, isNewBest: recorded.isNewBest, rank };
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
