import { Inject, Injectable } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { FRIENDS_REPOSITORY, type FriendsRepository } from "../friends/friends.repository.js";
import { FRIENDS_RULES } from "../friends/friends-rules.js";
import { AccountRestrictions } from "../restrictions/account-restrictions.js";
import { DIFFICULTIES, type Difficulty } from "../runs/run-rules.js";
import { boardViewSchema, overviewSchema, type BoardQuery, type BoardView, type Overview } from "./dto/seasons.dto.js";
import { SEASON_BOARD_STORE, type SeasonBoardStore } from "./season-board.store.js";
import { BOARD_LIMIT, DIFFICULTY_MUL, HISTORY_LIMIT, MIN_BOARD, PLACE_LADDER, THRESHOLD_REWARD, THRESHOLD_SEC, type Season } from "./season-rules.js";
import { SeasonSchedule } from "./seasons-schedule.js";
import { SEASONS_REPOSITORY, type SeasonsRepository } from "./seasons.repository.js";

/**
 * Чтение сезона (tasks/T-0110): обзор для экрана рейтинга и таблица недели.
 * Форма ответов — договор с клиентом, схемы в `dto/seasons.dto.ts`.
 *
 * Таблица недели строится как вечный рейтинг (`runs/runs-view.service.ts`):
 * порядок и места — из проекции в Redis, подробности лучшего забега **недели**
 * — из базы одним запросом на страницу. Идентификаторы чужих аккаунтов наружу
 * не уходят. Игрок под молчаливым ограничением рейтинга видит своё место из
 * тени, как в вечном рейтинге; другие его не видят.
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
  ) {}

  async overview(accountId: string, at = new Date()): Promise<Overview> {
    const start = this.schedule.startsAt();
    const season = this.schedule.current(at);
    const rules = {
      minBoard: MIN_BOARD,
      thresholds: THRESHOLD_SEC,
      thresholdReward: THRESHOLD_REWARD,
      placeLadder: PLACE_LADDER.map((step) => ({ ...step })),
      difficultyMul: DIFFICULTY_MUL,
    };
    if (start === null) {
      return overviewSchema.parse({ enabled: false, startsAt: null, season: null, ...rules, mine: nothing(), pending: [], history: [] });
    }

    const [mine, pending, history] = await Promise.all([
      season === null ? nothing() : this.mine(accountId, season, at),
      withTimeout(this.repository.pendingRewards(accountId), DB_TIMEOUT_MS, "seasons: ждущие награды"),
      withTimeout(this.repository.history(accountId, HISTORY_LIMIT), DB_TIMEOUT_MS, "seasons: история"),
    ]);
    return overviewSchema.parse({
      enabled: true,
      // Дата нужна, пока первый сезон не начался; потом сезон говорит сам.
      startsAt: season === null ? start.toISOString() : null,
      season: season === null ? null : { key: season.key, startsAt: season.startsAt.toISOString(), endsAt: season.endsAt.toISOString(), secondsLeft: Math.max(0, Math.ceil((season.endsAt.getTime() - at.getTime()) / 1000)) },
      ...rules,
      mine,
      pending: pending.map((reward) => ({ seasonKey: reward.seasonKey, kind: reward.kind, difficulty: reward.difficulty, place: reward.place, coins: reward.coins, prestige: reward.prestige })),
      history: history.map((item) => ({
        seasonKey: item.seasonKey,
        startsAt: item.startsAt.toISOString(),
        endsAt: item.endsAt.toISOString(),
        results: item.results,
        reward: item.reward,
      })),
    });
  }

  async board(accountId: string, query: BoardQuery, at = new Date()): Promise<BoardView> {
    const season = this.schedule.current(at);
    const { difficulty } = query;
    if (season === null) return boardViewSchema.parse({ seasonKey: null, difficulty, total: 0, entries: [], me: null });

    const hold = await this.restrictionOf(accountId, at);
    const shadow = hold !== null && !hold.notify;
    const standing = query.scope === "friends" ? await this.friendsStanding(accountId, season, difficulty) : await this.allStanding(accountId, season, difficulty);
    const rows = new Map((await withTimeout(this.repository.boardRuns(standing.top.map((entry) => entry.accountId), difficulty, season), DB_TIMEOUT_MS, "seasons: забеги недели")).map((row) => [row.accountId, row]));

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
          survivalSec: entry.survivalSec,
          level: row.level,
          startingWeaponId: row.startingWeaponId,
          enemiesKilled: row.enemiesKilled,
          isMe: entry.accountId === accountId,
        },
      ];
    });
    const me = shadow ? await this.shadowStanding(accountId, season, difficulty) : standing.me;
    return boardViewSchema.parse({ seasonKey: season.key, difficulty, total: standing.total, entries, me });
  }

  /** Вся таблица: топ из проекции, свои место и время, сколько игроков. */
  private async allStanding(accountId: string, season: Season, difficulty: Difficulty) {
    const [top, total, rank, best] = await Promise.all([
      this.store.top(season.key, difficulty, BOARD_LIMIT),
      this.store.count(season.key, difficulty),
      this.store.rank(season.key, difficulty, accountId),
      this.store.best(season.key, difficulty, accountId),
    ]);
    return { top, total, me: rank === null || best === null ? null : { rank, survivalSec: best } };
  }

  /**
   * Таблица друзей: принятые друзья и сам игрок. Заявка в друзья дружбой не
   * считается — в списке дружбы её нет. Места — среди этих людей.
   */
  private async friendsStanding(accountId: string, season: Season, difficulty: Difficulty) {
    const friends = await withTimeout(this.friends.friends(accountId, FRIENDS_RULES.maxFriends), DB_TIMEOUT_MS, "seasons: друзья");
    const scores = await withTimeout(this.store.scores(season.key, difficulty, [accountId, ...friends.map((friend) => friend.accountId)]), REDIS_TIMEOUT_MS, "seasons: таблица недели");
    // Как у Redis при равном времени: выше идентификатор.
    const ordered = [...scores.entries()].sort(([leftId, left], [rightId, right]) => right - left || (leftId < rightId ? 1 : -1)).map(([id, survivalSec]) => ({ accountId: id, survivalSec }));
    const place = ordered.findIndex((entry) => entry.accountId === accountId);
    return { top: ordered.slice(0, BOARD_LIMIT), total: ordered.length, me: place < 0 ? null : { rank: place + 1, survivalSec: ordered[place]?.survivalSec ?? 0 } };
  }

  /** Место игрока из тени: лучший забег недели вместе со сданными молча, среди настоящих игроков. */
  private async shadowStanding(accountId: string, season: Season, difficulty: Difficulty): Promise<{ rank: number; survivalSec: number } | null> {
    const mine = await withTimeout(this.repository.bestRun(accountId, difficulty, season, true), DB_TIMEOUT_MS, "seasons: лучший забег недели");
    if (mine === null) return null;
    const above = await withTimeout(this.store.countAbove(season.key, difficulty, mine.survivalSec), REDIS_TIMEOUT_MS, "seasons: таблица недели");
    return { rank: above + 1, survivalSec: mine.survivalSec };
  }

  /** Лучшее время недели игрока на каждой сложности. */
  private async mine(accountId: string, season: Season, at: Date): Promise<Record<Difficulty, number | null>> {
    const hold = await this.restrictionOf(accountId, at);
    const shadow = hold !== null && !hold.notify;
    const times = await Promise.all(
      DIFFICULTIES.map(async (difficulty) =>
        shadow
          ? ((await withTimeout(this.repository.bestRun(accountId, difficulty, season, true), DB_TIMEOUT_MS, "seasons: лучший забег недели"))?.survivalSec ?? null)
          : await withTimeout(this.store.best(season.key, difficulty, accountId), REDIS_TIMEOUT_MS, "seasons: таблица недели"),
      ),
    );
    return { easy: times[0] ?? null, normal: times[1] ?? null, hard: times[2] ?? null };
  }

  private async restrictionOf(accountId: string, at: Date) {
    return await withTimeout(this.restrictions.status(accountId, "leaderboard", at), DB_TIMEOUT_MS, "seasons: ограничения");
  }
}

function nothing(): Record<Difficulty, number | null> {
  return { easy: null, normal: null, hard: null };
}
