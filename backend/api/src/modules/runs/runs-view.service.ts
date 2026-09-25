import { Inject, Injectable } from "@nestjs/common";
import { LEADERBOARD_STORE, type LeaderboardStore } from "./leaderboard.store.js";
import { DIFFICULTIES, type Difficulty } from "./run-rules.js";
import { RUNS_REPOSITORY, type ReviewRow, type RunsRepository } from "./runs.repository.js";

/**
 * Чтение забегов (docs/34-stage3-plan.md, WP4): лидерборд, профиль, очередь
 * разбора. Форма ответов повторяет плейтестовую — клиент переедет на модуль,
 * не переписывая экраны.
 */

export const LEADERBOARD_LIMIT = 50;
const RECENT_RUNS_SHOWN = 10;

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
  recent: { difficultyId: Difficulty; survivalSec: number; level: number; startingWeaponId: string; at: number }[];
}

@Injectable()
export class RunsViewService {
  constructor(
    @Inject(RUNS_REPOSITORY) private readonly runs: RunsRepository,
    @Inject(LEADERBOARD_STORE) private readonly leaderboard: LeaderboardStore,
  ) {}

  async leaderboardFor(accountId: string, difficulty: Difficulty): Promise<LeaderboardView> {
    const [top, total, rank, best] = await Promise.all([
      this.leaderboard.top(difficulty, LEADERBOARD_LIMIT),
      this.leaderboard.count(difficulty),
      this.leaderboard.rank(difficulty, accountId),
      this.leaderboard.best(difficulty, accountId),
    ]);

    // Порядок и места — из проекции, подробности лучшего забега — из базы
    // одним запросом на всю страницу.
    const details = new Map((await this.runs.bestRuns(top.map((entry) => entry.accountId), difficulty)).map((row) => [row.accountId, row]));

    return {
      difficultyId: difficulty,
      // Идентификаторы чужих аккаунтов наружу не уходят: строка знает только,
      // «моя» ли она.
      entries: top.flatMap((entry, index) => {
        const row = details.get(entry.accountId);
        // Проекция и база разошлись — например, аккаунт удалён. Такую строку
        // не показываем, а не рисуем пустую: пересборка всё выровняет.
        if (row === undefined) return [];
        return [
          {
            rank: index + 1,
            name: row.displayName,
            photoUrl: row.photoUrl,
            survivalSec: entry.survivalSec,
            level: row.level,
            startingWeaponId: row.startingWeaponId,
            enemiesKilled: row.enemiesKilled,
            isMe: entry.accountId === accountId,
          },
        ];
      }),
      me: rank === null || best === null ? null : { rank, survivalSec: best },
      totalPlayers: total,
    };
  }

  async profile(accountId: string): Promise<ProfileView> {
    const [stats, recent, ...bests] = await Promise.all([
      this.runs.stats(accountId),
      this.runs.recent(accountId, RECENT_RUNS_SHOWN),
      ...DIFFICULTIES.map(async (difficulty) => {
        const [best, rank] = await Promise.all([
          this.leaderboard.best(difficulty, accountId),
          this.leaderboard.rank(difficulty, accountId),
        ]);
        return best === null || rank === null ? null : { survivalSec: best, rank };
      }),
    ]);

    return {
      ...stats,
      best: { easy: bests[0] ?? null, normal: bests[1] ?? null, hard: bests[2] ?? null },
      recent: recent.map((run) => ({
        difficultyId: run.difficulty,
        survivalSec: run.survivalSec,
        level: run.level,
        startingWeaponId: run.startingWeaponId,
        at: run.finishedAt.getTime(),
      })),
    };
  }

  async review(limit: number): Promise<ReviewRow[]> {
    return await this.runs.review(limit);
  }
}
