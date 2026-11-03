import { Inject, Injectable } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { FRIENDS_REPOSITORY, type FriendsRepository } from "../friends/friends.repository.js";
import { FRIENDS_RULES } from "../friends/friends-rules.js";
import { scoringOfSeason, type Scoring } from "../rating/rating-switch.js";
import { AccountRestrictions } from "../restrictions/account-restrictions.js";
import { RatingRestrictions } from "../runs/rating-restrictions.js";
import type { Board } from "../runs/leaderboard.store.js";
import type { BestRunRow } from "../runs/runs.repository.js";
import { DIFFICULTIES, isRatedDifficulty, type Difficulty } from "../runs/run-rules.js";
import { boardViewSchema, overviewSchema, type BoardQuery, type BoardView, type Overview } from "./dto/seasons.dto.js";
import { SEASON_BOARD_STORE, type SeasonBoardStore } from "./season-board.store.js";
import { BOARD_LIMIT, DIFFICULTY_MUL, HISTORY_LIMIT, MIN_BOARD, PLACE_LADDER, THRESHOLD_REWARD, THRESHOLD_SEC, type Season } from "./season-rules.js";
import { SeasonSchedule } from "./seasons-schedule.js";
import { SEASONS_REPOSITORY, type SeasonsRepository, type WeekBest } from "./seasons.repository.js";

/**
 * Чтение сезона (tasks/T-0110): обзор для экрана рейтинга и таблица недели.
 * Форма ответов — договор с клиентом, схемы в `dto/seasons.dto.ts`.
 *
 * Таблица недели строится как вечный рейтинг (`runs/runs-view.service.ts`):
 * порядок и места — из проекции в Redis, подробности лучшего забега **недели**
 * — из базы одним запросом на страницу. Идентификаторы чужих аккаунтов наружу
 * не уходят. Игрок под молчаливым ограничением рейтинга видит своё место из
 * тени, как в вечном рейтинге; другие его не видят.
 *
 * Таблица читается по доске зрителя (T-0114, Р104): обычный игрок видит общую —
 * без аккаунтов с отдельной доской, — аккаунт с ней — полную; форма ответа одна.
 * Таблица друзей — как обычно: друзья видны всем друзьям независимо от доски,
 * поэтому читается полная, а `me` считается по той же таблице, что в ответе.
 *
 * Режим таблицы (tasks/T-0294) — по очкам или по времени — решает расписание
 * (`SeasonSchedule.scoringOf`): сезон до понедельника перехода дотягивается по
 * времени, следующий идёт по очкам. В ответе строка несёт и `points`, и
 * `survivalSec`: в сезоне по очкам `survivalSec` — время того же забега,
 * подпись; в сезоне по времени — главное число, как раньше. Старые клиенты
 * читают время до T-0296.
 *
 * Единая сложность (Р126, T-0191): у нерейтинговых сложностей таблица пуста, а
 * лучшее время недели — `null`; форма ответа прежняя, старый клиент ошибки не
 * увидит. Забеги до отсечки рейтинга в недельные времена не входят.
 */

const DB_TIMEOUT_MS = 3_000;
const REDIS_TIMEOUT_MS = 2_000;

@Injectable()
export class SeasonsViewService {
  constructor(
    private readonly schedule: SeasonSchedule,
    @Inject(SEASONS_REPOSITORY) private readonly repository: SeasonsRepository,
    @Inject(SEASON_BOARD_STORE) private readonly store: SeasonBoardStore,
    @Inject(FRIENDS_REPOSITORY) private readonly friends: FriendsRepository,
    private readonly restrictions: AccountRestrictions,
    private readonly rating: RatingRestrictions,
  ) {}

  async overview(accountId: string, at = new Date()): Promise<Overview> {
    const start = this.schedule.startsAt();
    const season = this.schedule.current(at);
    const rules = {
      minBoard: MIN_BOARD,
      thresholds: THRESHOLD_SEC,
      thresholdPoints: this.schedule.thresholdPoints(),
      scoring: season === null ? ("time" as const) : this.schedule.scoringOf(season),
      thresholdReward: THRESHOLD_REWARD,
      placeLadder: PLACE_LADDER.map((step) => ({ ...step })),
      difficultyMul: DIFFICULTY_MUL,
    };
    if (start === null) {
      return overviewSchema.parse({ enabled: false, startsAt: null, season: null, ...rules, mine: nothing(), minePoints: nothing(), pending: [], history: [] });
    }

    const pointsFrom = this.schedule.pointsFrom();
    const [mine, pending, history] = await Promise.all([
      season === null ? { times: nothing(), points: nothing() } : this.mine(accountId, season, at),
      withTimeout(this.repository.pendingRewards(accountId), DB_TIMEOUT_MS, "seasons: ждущие награды"),
      withTimeout(this.repository.history(accountId, HISTORY_LIMIT), DB_TIMEOUT_MS, "seasons: история"),
    ]);
    return overviewSchema.parse({
      enabled: true,
      // Дата нужна, пока первый сезон не начался; потом сезон говорит сам.
      startsAt: season === null ? start.toISOString() : null,
      season: season === null ? null : { key: season.key, startsAt: season.startsAt.toISOString(), endsAt: season.endsAt.toISOString(), secondsLeft: Math.max(0, Math.ceil((season.endsAt.getTime() - at.getTime()) / 1000)) },
      ...rules,
      mine: mine.times,
      minePoints: mine.points,
      pending: pending.map((reward) => ({ seasonKey: reward.seasonKey, kind: reward.kind, difficulty: reward.difficulty, place: reward.place, coins: reward.coins, prestige: reward.prestige })),
      history: history.map((item) => ({
        seasonKey: item.seasonKey,
        startsAt: item.startsAt.toISOString(),
        endsAt: item.endsAt.toISOString(),
        scoring: scoringOfSeason(item.startsAt, pointsFrom),
        results: item.results,
        reward: item.reward,
      })),
    });
  }

  async board(accountId: string, query: BoardQuery, at = new Date()): Promise<BoardView> {
    const season = this.schedule.current(at);
    const { difficulty } = query;
    if (season === null) return boardViewSchema.parse({ seasonKey: null, difficulty, scoring: "time", total: 0, entries: [], me: null });
    const scoring = this.schedule.scoringOf(season);
    // Нерейтинговая сложность: ни проекции, ни базы, ни ограничений — пустая таблица недели.
    if (!isRatedDifficulty(difficulty)) return boardViewSchema.parse({ seasonKey: season.key, difficulty, scoring, total: 0, entries: [], me: null });

    // Таблица сезона по очкам лежит под своим ключом (`pts:`); ключ сезона в ответе — дата понедельника.
    const boardKey = this.schedule.boardSeason(season).key;
    const hold = await this.restrictionOf(accountId, at);
    const shadow = hold !== null && !hold.notify;
    const friendsScope = query.scope === "friends";
    const board = await withTimeout(this.rating.boardOf(accountId, at), DB_TIMEOUT_MS, "seasons: доска зрителя");
    const standing = friendsScope ? await this.friendsStanding(accountId, season, boardKey, difficulty, shadow, scoring) : await this.allStanding(accountId, boardKey, difficulty, board);
    // Подписи (время, стиль) своего забега берутся тем же запросом, если игрока нет среди показанных строк.
    const ids = standing.top.map((entry) => entry.accountId);
    const withMe = standing.me !== null && !ids.includes(accountId) ? [...ids, accountId] : ids;
    const rows = new Map((await withTimeout(this.repository.boardRuns(withMe, difficulty, season, this.schedule.ratingSince(), scoring), DB_TIMEOUT_MS, "seasons: забеги недели")).map((row) => [row.accountId, row]));

    const entries = standing.top.flatMap((entry, index) => {
      const row = rows.get(entry.accountId);
      // Проекция и база разошлись — например, аккаунт удалён: такую строку не показываем, пересборка всё выровняет.
      if (row === undefined) return [];
      return [
        {
          rank: index + 1,
          name: row.displayName,
          photoUrl: row.photoUrl,
          ...(row.tester ? { tester: true as const } : {}),
          points: scoring === "points" ? entry.score : row.points,
          // По очкам время — подпись лучшего по очкам забега, по времени — само число таблицы.
          survivalSec: scoring === "points" ? row.survivalSec : entry.score,
          style: row.style,
          level: row.level,
          startingWeaponId: row.startingWeaponId,
          enemiesKilled: row.enemiesKilled,
          isMe: entry.accountId === accountId,
        },
      ];
    });
    // Тень в таблице друзей уже вложена в `standing.me`: свой счёт среди друзей, а не место недели.
    const me = shadow && !friendsScope ? await this.shadowStanding(accountId, season, boardKey, difficulty, board, scoring) : this.meOf(standing.me, rows.get(accountId), scoring);
    return boardViewSchema.parse({ seasonKey: season.key, difficulty, scoring, total: standing.total, entries, me });
  }

  /** Строка «меня»: место и счёт из таблицы, время и стиль — из лучшего забега игрока. */
  private meOf(standing: { rank: number; score: number } | null, row: BestRunRow | undefined, scoring: Scoring) {
    if (standing === null) return null;
    return {
      rank: standing.rank,
      points: scoring === "points" ? standing.score : (row?.points ?? null),
      survivalSec: scoring === "points" ? (row?.survivalSec ?? 0) : standing.score,
      style: row?.style ?? null,
    };
  }

  /** Вся таблица: топ из проекции, свои место и счёт, сколько игроков. */
  private async allStanding(accountId: string, boardKey: string, difficulty: Difficulty, board: Board) {
    const [top, total, rank, best] = await Promise.all([
      this.store.top(boardKey, difficulty, BOARD_LIMIT, board),
      this.store.count(boardKey, difficulty, board),
      this.store.rank(boardKey, difficulty, accountId, board),
      this.store.best(boardKey, difficulty, accountId, board),
    ]);
    return { top, total, me: rank === null || best === null ? null : { rank, score: best } };
  }

  /**
   * Таблица друзей: принятые друзья и сам игрок. Заявка в друзья дружбой не
   * считается — в списке дружбы её нет. Места — среди этих людей.
   */
  private async friendsStanding(accountId: string, season: Season, boardKey: string, difficulty: Difficulty, shadow: boolean, scoring: Scoring) {
    const friends = await withTimeout(this.friends.friends(accountId, FRIENDS_RULES.maxFriends), DB_TIMEOUT_MS, "seasons: друзья");
    // Полная таблица: друг с отдельной доской виден и обычному игроку, с его счётом недели.
    const scores = await withTimeout(this.store.scores(boardKey, difficulty, [accountId, ...friends.map((friend) => friend.accountId)], "full"), REDIS_TIMEOUT_MS, "seasons: таблица недели");
    // Молчаливо ограниченного в таблице нет, а себя он видит: его счёт из тени встаёт среди друзей.
    if (shadow) {
      const mine = await withTimeout(this.repository.bestRun(accountId, difficulty, season, true, this.schedule.ratingSince(), scoring), DB_TIMEOUT_MS, "seasons: лучший забег недели");
      if (mine !== null) scores.set(accountId, mine.score);
    }
    // Как у Redis при равном счёте: выше идентификатор.
    const ordered = [...scores.entries()].sort(([leftId, left], [rightId, right]) => right - left || (leftId < rightId ? 1 : -1)).map(([id, score]) => ({ accountId: id, score }));
    const place = ordered.findIndex((entry) => entry.accountId === accountId);
    return { top: ordered.slice(0, BOARD_LIMIT), total: ordered.length, me: place < 0 ? null : { rank: place + 1, score: ordered[place]?.score ?? 0 } };
  }

  /** Место игрока из тени: лучший забег недели вместе со сданными молча, среди настоящих игроков. */
  private async shadowStanding(accountId: string, season: Season, boardKey: string, difficulty: Difficulty, board: Board, scoring: Scoring) {
    const mine = await withTimeout(this.repository.bestRun(accountId, difficulty, season, true, this.schedule.ratingSince(), scoring), DB_TIMEOUT_MS, "seasons: лучший забег недели");
    if (mine === null) return null;
    const above = await withTimeout(this.store.countAbove(boardKey, difficulty, mine.score, board), REDIS_TIMEOUT_MS, "seasons: таблица недели");
    return { rank: above + 1, points: scoring === "points" ? mine.score : mine.points, survivalSec: mine.survivalSec, style: mine.style };
  }

  /** Лучший забег недели игрока на каждой сложности: время и очки. */
  private async mine(accountId: string, season: Season, at: Date): Promise<{ times: Record<Difficulty, number | null>; points: Record<Difficulty, number | null> }> {
    const hold = await this.restrictionOf(accountId, at);
    const shadow = hold !== null && !hold.notify;
    const board = await withTimeout(this.rating.boardOf(accountId, at), DB_TIMEOUT_MS, "seasons: доска зрителя");
    const since = this.schedule.ratingSince();
    const scoring = this.schedule.scoringOf(season);
    const boardKey = this.schedule.boardSeason(season).key;
    const bests = await Promise.all(
      DIFFICULTIES.map(async (difficulty): Promise<WeekBest | null> => {
        if (!isRatedDifficulty(difficulty)) return null;
        if (shadow) return await withTimeout(this.repository.bestRun(accountId, difficulty, season, true, since, scoring), DB_TIMEOUT_MS, "seasons: лучший забег недели");
        // В таблице игрока нет (закрыт рейтинг, нет забегов) — и лучшего нет, даже если база что-то помнит.
        const score = await withTimeout(this.store.best(boardKey, difficulty, accountId, board), REDIS_TIMEOUT_MS, "seasons: таблица недели");
        if (score === null) return null;
        // В сезоне по очкам время лучшего забега — подпись к счёту таблицы: читается из базы. По времени счёт и есть время.
        if (scoring === "time") return { score, survivalSec: score, points: null, style: null };
        const run = await withTimeout(this.repository.bestRun(accountId, difficulty, season, false, since, scoring), DB_TIMEOUT_MS, "seasons: лучший забег недели");
        return { score, survivalSec: run?.survivalSec ?? 0, points: score, style: run?.style ?? null };
      }),
    );
    const times = bests.map((best) => best?.survivalSec ?? null);
    const points = bests.map((best) => (scoring === "points" ? (best?.score ?? null) : null));
    return {
      times: { easy: times[0] ?? null, normal: times[1] ?? null, hard: times[2] ?? null },
      points: { easy: points[0] ?? null, normal: points[1] ?? null, hard: points[2] ?? null },
    };
  }

  private async restrictionOf(accountId: string, at: Date) {
    return await withTimeout(this.restrictions.status(accountId, "leaderboard", at), DB_TIMEOUT_MS, "seasons: ограничения");
  }
}

function nothing(): Record<Difficulty, number | null> {
  return { easy: null, normal: null, hard: null };
}
