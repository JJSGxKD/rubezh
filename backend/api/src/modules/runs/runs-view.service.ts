import { Inject, Injectable } from "@nestjs/common";
import { DomainError } from "../../common/domain-error.js";
import { LEADERBOARD_STORE, type LeaderboardStore } from "./leaderboard.store.js";
import { RatingRestrictions } from "./rating-restrictions.js";
import { RunExtras, type RunLootPart, type RunRewardPart } from "./run-details.js";
import { DIFFICULTIES, type Difficulty } from "./run-rules.js";
import { RUNS_REPOSITORY, type ReviewRow, type RunDetailRow, type RunsRepository } from "./runs.repository.js";

/**
 * Чтение забегов (docs/34-stage3-plan.md, WP4): лидерборд, профиль, очередь
 * разбора. Форма ответов повторяет плейтестовую — клиент переедет на модуль,
 * не переписывая экраны.
 *
 * Игрок под молчаливым ограничением рейтинга (docs/35-stage4-plan.md WP44,
 * О40) видит доску и профиль из тени: себя — на месте, которое занял бы
 * лучшим забегом, остальных — как есть. Другие его не видят: в доске его нет.
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
   * с читами разработчика; `review` — не учтён после проверки;
   * `restricted` — не учтён: рейтинг игроку закрыт ограничением, о котором
   * ему сообщили. Под молчаливым — `ranked`: так игрок видит его из тени.
   */
  rating: "ranked" | "cheats" | "review" | "restricted";
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
    private readonly rating: RatingRestrictions,
  ) {}

  async leaderboardFor(accountId: string, difficulty: Difficulty): Promise<LeaderboardView> {
    const [top, total, rank, best, hold] = await Promise.all([
      this.leaderboard.top(difficulty, LEADERBOARD_LIMIT),
      this.leaderboard.count(difficulty),
      this.leaderboard.rank(difficulty, accountId),
      this.leaderboard.best(difficulty, accountId),
      this.rating.hold(accountId),
    ]);

    // Порядок и места — из проекции, подробности лучшего забега — из базы
    // одним запросом на всю страницу.
    const details = new Map((await this.runs.bestRuns(top.map((entry) => entry.accountId), difficulty)).map((row) => [row.accountId, row]));

    const view: LeaderboardView = {
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
    return hold === "silent" ? await this.fromShadow(accountId, difficulty, view) : view;
  }

  /**
   * Доска глазами игрока в тени: он — на месте, которое занял бы лучшим
   * забегом, включая сданные в тени, а те, кто ниже, сдвинуты на строку.
   */
  private async fromShadow(accountId: string, difficulty: Difficulty, view: LeaderboardView): Promise<LeaderboardView> {
    const mine = await this.runs.bestRunOf(accountId, difficulty, true);
    // До обхода игрок мог остаться в доске гонкой с наложением — себя он видит один раз.
    const others = view.entries.filter((entry) => !entry.isMe);
    const players = view.totalPlayers - (view.me === null ? 0 : 1);
    if (mine === null) return { ...view, entries: others, me: null, totalPlayers: players };

    const rank = (await this.leaderboard.countAbove(difficulty, mine.survivalSec)) + 1;
    const own = {
      rank,
      name: mine.displayName,
      photoUrl: mine.photoUrl,
      survivalSec: mine.survivalSec,
      level: mine.level,
      startingWeaponId: mine.startingWeaponId,
      enemiesKilled: mine.enemiesKilled,
      isMe: true,
    };
    const entries = [...others.map((entry) => (entry.rank >= rank ? { ...entry, rank: entry.rank + 1 } : entry)), own]
      .filter((entry) => entry.rank <= LEADERBOARD_LIMIT)
      .sort((left, right) => left.rank - right.rank);
    return { ...view, entries, me: { rank, survivalSec: mine.survivalSec }, totalPlayers: players + 1 };
  }

  /**
   * `team` — карточка игрока в панели: команда видит правду, и в тени игрок
   * у неё без места в рейтинге.
   */
  async profile(accountId: string, audience: "player" | "team" = "player"): Promise<ProfileView> {
    const shadow = audience === "player" && (await this.rating.hold(accountId)) === "silent";
    const [stats, recent, ...bests] = await Promise.all([
      this.runs.stats(accountId),
      this.runs.recent(accountId, RECENT_RUNS_SHOWN),
      ...DIFFICULTIES.map(async (difficulty) => (shadow ? await this.shadowBest(accountId, difficulty) : await this.boardBest(accountId, difficulty))),
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

  /** Сколько игроков в доске глазами игрока: в тени он видит в ней и себя. */
  async boardSize(accountId: string, difficulty: Difficulty): Promise<number> {
    const [total, hold] = await Promise.all([this.leaderboard.count(difficulty), this.rating.hold(accountId)]);
    if (hold !== "silent" || (await this.leaderboard.best(difficulty, accountId)) !== null) return total;
    return (await this.runs.bestRunOf(accountId, difficulty, true)) === null ? total : total + 1;
  }

  private async boardBest(accountId: string, difficulty: Difficulty): Promise<{ survivalSec: number; rank: number } | null> {
    const [best, rank] = await Promise.all([this.leaderboard.best(difficulty, accountId), this.leaderboard.rank(difficulty, accountId)]);
    return best === null || rank === null ? null : { survivalSec: best, rank };
  }

  private async shadowBest(accountId: string, difficulty: Difficulty): Promise<{ survivalSec: number; rank: number } | null> {
    const mine = await this.runs.bestRunOf(accountId, difficulty, true);
    if (mine === null) return null;
    return { survivalSec: mine.survivalSec, rank: (await this.leaderboard.countAbove(difficulty, mine.survivalSec)) + 1 };
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
      rating: ratingOf(run),
      ...extras,
    };
  }

  async review(limit: number): Promise<ReviewRow[]> {
    return await this.runs.review(limit);
  }
}

function ratingOf(run: Pick<RunDetailRow, "ranked" | "ratingRestricted" | "cheats">): RunDetailView["rating"] {
  if (run.ranked || run.ratingRestricted === "silent") return "ranked";
  if (run.ratingRestricted === "notified") return "restricted";
  return run.cheats ? "cheats" : "review";
}
