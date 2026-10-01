import { Inject, Injectable } from "@nestjs/common";
import { DomainError } from "../../common/domain-error.js";
import { LEADERBOARD_STORE, type LeaderboardStore } from "./leaderboard.store.js";
import { RunExtras, type RunLootPart, type RunRewardPart } from "./run-details.js";
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
  recent: { runId: string; difficultyId: Difficulty; survivalSec: number; level: number; startingWeaponId: string; at: number }[];
}

/**
 * Лист забега в профиле. Числа, которых сборка игрока не прислала, — `null`:
 * лист показывает то, что знает, а не нули вместо неизвестного.
 */
export interface RunDetailView {
  runId: string;
  difficultyId: Difficulty;
  startingWeaponId: string;
  at: number;
  outcome: "died" | "abandoned";
  survivalSec: number;
  level: number;
  enemiesKilled: number;
  /** враг, нанёсший смертельный удар; `null` — сдался или неизвестно */
  deathCause: string | null;
  weapons: { id: string; level: number; damage: number | null }[];
  passives: { id: string; level: number }[];
  damageTaken: number | null;
  xpCollected: number | null;
  waveReached: number | null;
  topKills: { enemy: string; count: number }[];
  /** сколько раз продолжал после смерти */
  continues: number;
  /**
   * Рейтинг словами, без кодов антифрода: `ranked` — учтён; `cheats` —
   * с читами разработчика; `review` — не учтён после проверки.
   */
  rating: "ranked" | "cheats" | "review";
  boosts: string[];
  reward: RunRewardPart | null;
  loot: RunLootPart[];
}

export class RunNotFoundError extends DomainError {
  constructor() {
    super("run_not_found", "Забег не найден", 404);
  }
}

@Injectable()
export class RunsViewService {
  constructor(
    @Inject(RUNS_REPOSITORY) private readonly runs: RunsRepository,
    @Inject(LEADERBOARD_STORE) private readonly leaderboard: LeaderboardStore,
    private readonly extras: RunExtras,
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
        runId: run.runId,
        difficultyId: run.difficulty,
        survivalSec: run.survivalSec,
        level: run.level,
        startingWeaponId: run.startingWeaponId,
        at: run.finishedAt.getTime(),
      })),
    };
  }

  async detail(accountId: string, runId: string): Promise<RunDetailView> {
    // Части других модулей — параллельно строке забега: чужой или незнакомый
    // забег они не отдадут сами, ключ у всех — пара аккаунта и забега.
    const [run, extras] = await Promise.all([this.runs.detail(accountId, runId), this.extras.of(accountId, runId)]);
    if (run === null) throw new RunNotFoundError();
    return {
      runId: run.runId,
      difficultyId: run.difficulty,
      startingWeaponId: run.startingWeaponId,
      at: run.finishedAt.getTime(),
      outcome: run.outcome,
      survivalSec: run.survivalSec,
      level: run.level,
      enemiesKilled: run.enemiesKilled,
      deathCause: run.outcome === "died" ? run.deathCause : null,
      weapons: run.weapons,
      passives: run.details?.passives ?? [],
      damageTaken: run.details?.damageTaken ?? null,
      xpCollected: run.details?.xpCollected ?? null,
      waveReached: run.details?.waveReached ?? null,
      topKills: run.details?.topKills ?? [],
      continues: run.continues,
      rating: run.ranked ? "ranked" : run.cheats ? "cheats" : "review",
      ...extras,
    };
  }

  async review(limit: number): Promise<ReviewRow[]> {
    return await this.runs.review(limit);
  }
}
