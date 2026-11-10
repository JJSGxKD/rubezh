import { Inject, Injectable } from "@nestjs/common";
import { DomainError, ForbiddenError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { divisionOf } from "../rating/division-rules.js";
import { scoringOfSeason } from "../rating/rating-switch.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { LEADERBOARD_STORE, type Board, type LeaderboardStore } from "../runs/leaderboard.store.js";
import { isRatedDifficulty } from "../runs/run-rules.js";
import { RUNS_REPOSITORY, type BestRunRow, type RunsRepository } from "../runs/runs.repository.js";
import {
  boardsViewSchema,
  playerSeasonsSchema,
  seasonsPageSchema,
  seasonViewSchema,
  type BoardsQuery,
  type BoardsView,
  type PlayerSeasons,
  type SeasonQuery,
  type SeasonRewardView,
  type SeasonsPage,
  type SeasonsQuery,
  type SeasonView,
} from "./dto/seasons-admin.dto.js";
import { SEASON_BOARD_STORE, type SeasonBoardStore } from "./season-board.store.js";
import { SeasonSchedule } from "./seasons-schedule.js";
import { SEASONS_ADMIN_REPOSITORY, type ArchiveReward, type ArchiveSeason, type SeasonsAdminRepository } from "./seasons-admin.repository.js";
import { SEASONS_REPOSITORY, type SeasonsRepository } from "./seasons.repository.js";

/**
 * Рейтинг в панели (tasks/T-0380, docs/35-stage4-plan.md Р189): текущие доски,
 * архив недельных сезонов и места одного игрока. Только чтение, аудита нет.
 *
 * **Текущие доски — те же, что видит игрок** (экран «Рейтинг»): неделя читается
 * из проекции сезона в Redis, всё время — из вечной доски, подписи строк
 * (имя, время) — из базы одним запросом на страницу. Строка без подписи
 * (проекция разошлась с базой, аккаунт удалён) не отдаётся, а места остальных
 * не сдвигаются — как у игрока. Режим числа доски — как у игрока: неделя по
 * расписанию (`SeasonSchedule.scoringOf`), всё время — очки.
 *
 * **Архив** — только накопленные итоги (`season`, `season_result`,
 * `season_reward`); дневных срезов мест нет. `scoring` сезона нужен экрану,
 * чтобы подписать `best`: секунды или очки.
 *
 * **Отдельная доска** (Р104) видна только держателю `players.board.restrict`:
 * без него читается общая доска, строки итогов с `board = 'full'` не
 * отдаются, а запрос `board=full` — 403. Так же прячут метку остальные
 * отчёты панели.
 */

const DB_TIMEOUT_MS = 5_000;
const REDIS_TIMEOUT_MS = 5_000;
/** Сколько недель истории игрока отдаёт карточка: год. */
const PLAYER_SEASONS_LIMIT = 52;

export class SeasonNotFoundError extends DomainError {
  constructor() {
    super("season_not_found", "Сезон не найден", 404);
  }
}

@Injectable()
export class SeasonsAdminService {
  constructor(
    private readonly schedule: SeasonSchedule,
    @Inject(SEASON_BOARD_STORE) private readonly weekBoards: SeasonBoardStore,
    @Inject(LEADERBOARD_STORE) private readonly allTimeBoards: LeaderboardStore,
    @Inject(SEASONS_REPOSITORY) private readonly seasonsRepository: SeasonsRepository,
    @Inject(RUNS_REPOSITORY) private readonly runsRepository: RunsRepository,
    @Inject(SEASONS_ADMIN_REPOSITORY) private readonly archive: SeasonsAdminRepository,
    private readonly roles: RolesService,
  ) {}

  async boards(actor: AccountRef, query: BoardsQuery, at = new Date()): Promise<BoardsView> {
    await this.requireBoard(actor, query.board);
    const { difficulty, period, board, limit } = query;
    const season = period === "week" ? this.schedule.current(at) : null;
    const empty = (scoring: "time" | "points") => boardsViewSchema.parse({ period, difficulty, board, scoring, seasonKey: season?.key ?? null, total: 0, entries: [] });

    if (period === "all") {
      // Нерейтинговая сложность: ни проекции, ни базы — пустая доска, как у игрока.
      if (!isRatedDifficulty(difficulty)) return empty("points");
      const [top, total] = await withTimeout(Promise.all([this.allTimeBoards.top(difficulty, limit, board), this.allTimeBoards.count(difficulty, board)]), REDIS_TIMEOUT_MS, "admin-rating: доска всех времён");
      const rows = await this.labelled(top.map((entry) => entry.accountId), (ids) => this.runsRepository.bestRuns(ids, difficulty, this.schedule.ratingSince()));
      return boardsViewSchema.parse({
        period,
        difficulty,
        board,
        scoring: "points",
        seasonKey: null,
        total,
        entries: top.flatMap((entry, index) => {
          const row = rows.get(entry.accountId);
          return row === undefined ? [] : [{ place: index + 1, accountId: entry.accountId, name: row.displayName, score: entry.score, survivalSec: row.survivalSec, division: null }];
        }),
      });
    }

    if (season === null) return empty("time");
    const scoring = this.schedule.scoringOf(season);
    if (!isRatedDifficulty(difficulty)) return empty(scoring);
    // Доска сезона по очкам лежит под ключом `pts:`; ключ сезона в ответе — дата понедельника.
    const boardKey = this.schedule.boardSeason(season).key;
    const [top, total] = await withTimeout(Promise.all([this.weekBoards.top(boardKey, difficulty, limit, board), this.weekBoards.count(boardKey, difficulty, board)]), REDIS_TIMEOUT_MS, "admin-rating: доска недели");
    const rows = await this.labelled(top.map((entry) => entry.accountId), (ids) => this.seasonsRepository.boardRuns(ids, difficulty, season, this.schedule.ratingSince(), scoring));
    return boardsViewSchema.parse({
      period,
      difficulty,
      board,
      scoring,
      seasonKey: season.key,
      total,
      entries: top.flatMap((entry, index) => {
        const row = rows.get(entry.accountId);
        if (row === undefined) return [];
        // По очкам время — подпись лучшего по очкам забега, по времени — само число доски.
        return [{ place: index + 1, accountId: entry.accountId, name: row.displayName, score: entry.score, survivalSec: scoring === "points" ? row.survivalSec : entry.score, division: divisionOf(index + 1, total) }];
      }),
    });
  }

  async seasons(query: SeasonsQuery): Promise<SeasonsPage> {
    const page = await withTimeout(this.archive.seasons(query.before ?? null, query.limit), DB_TIMEOUT_MS, "admin-rating: архив сезонов");
    const last = page.seasons[page.seasons.length - 1];
    return seasonsPageSchema.parse({ seasons: page.seasons.map((season) => this.cardOf(season)), next: page.more && last !== undefined ? last.key : null });
  }

  async season(actor: AccountRef, key: string, query: SeasonQuery): Promise<SeasonView> {
    await this.requireBoard(actor, query.board);
    const found = await withTimeout(this.archive.season(key), DB_TIMEOUT_MS, "admin-rating: сезон");
    if (found === null) throw new SeasonNotFoundError();
    const { rows, total } = await withTimeout(this.archive.results(key, query.difficulty, query.board, query.offset, query.limit), DB_TIMEOUT_MS, "admin-rating: итоги сезона");
    return seasonViewSchema.parse({
      season: this.cardOf(found),
      difficulty: query.difficulty,
      board: query.board,
      total,
      rows: rows.map((row) => ({ place: row.place, accountId: row.accountId, name: row.name, best: row.best, boardSize: row.boardSize, division: row.division, reward: rewardView(row.reward) })),
    });
  }

  async playerSeasons(actor: AccountRef, accountId: string): Promise<PlayerSeasons> {
    const includeFull = await this.roles.can(actor, "players.board.restrict");
    const seasons = await withTimeout(this.archive.playerSeasons(accountId, includeFull, PLAYER_SEASONS_LIMIT), DB_TIMEOUT_MS, "admin-rating: места игрока");
    const pointsFrom = this.schedule.pointsFrom();
    return playerSeasonsSchema.parse({
      seasons: seasons.map((season) => ({
        key: season.key,
        startsAt: season.startsAt.toISOString(),
        scoring: scoringOfSeason(season.startsAt, pointsFrom),
        // Поле доски — только держателю права: остальным оно выдало бы существование отдельной доски.
        results: season.results.map(({ board, ...result }) => (includeFull ? { ...result, board } : result)),
        reward: season.reward === null ? null : { ...rewardView(season.reward), difficulty: season.reward.difficulty, place: season.reward.place },
      })),
    });
  }

  private cardOf(season: ArchiveSeason) {
    return {
      key: season.key,
      startsAt: season.startsAt.toISOString(),
      endsAt: season.endsAt.toISOString(),
      closedAt: season.closedAt.toISOString(),
      players: season.players,
      rewarded: season.rewarded,
      scoring: scoringOfSeason(season.startsAt, this.schedule.pointsFrom()),
    };
  }

  /** Отдельная доска — только с `players.board.restrict`; об отказе не сообщается, что именно закрыто. */
  private async requireBoard(actor: AccountRef, board: Board): Promise<void> {
    if (board === "full" && !(await this.roles.can(actor, "players.board.restrict"))) throw new ForbiddenError("Недостаточно прав");
  }

  /** Подписи строк страницы одним запросом: аккаунт → строка лучшего забега. */
  private async labelled(ids: readonly string[], read: (ids: readonly string[]) => Promise<BestRunRow[]>): Promise<Map<string, BestRunRow>> {
    const rows = await withTimeout(read(ids), DB_TIMEOUT_MS, "admin-rating: подписи строк доски");
    return new Map(rows.map((row) => [row.accountId, row]));
  }
}

function rewardView(reward: ArchiveReward | null): SeasonRewardView | null {
  if (reward === null) return null;
  return { kind: reward.kind, coins: reward.coins, prestige: reward.prestige, status: reward.status, claimedAt: reward.claimedAt === null ? null : reward.claimedAt.toISOString() };
}
