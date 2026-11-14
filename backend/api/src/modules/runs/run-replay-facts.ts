import { Inject, Injectable, Optional } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { withTimeout } from "../../common/with-timeout.js";
import { divisionOf, type Division } from "../rating/division-rules.js";
import { scoreOf } from "../rating/rating-switch.js";
import { SEASON_BOARD_STORE, type SeasonBoardStore } from "../seasons/season-board.store.js";
import { SeasonSchedule } from "../seasons/seasons-schedule.js";
import { LEADERBOARD_STORE, type Board, type LeaderboardStore } from "./leaderboard.store.js";
import { RatingRestrictions } from "./rating-restrictions.js";
import type { ReplayFacts } from "./run-replay-rules.js";
import type { ReplayFactsReader } from "./run-replay.service.js";
import type { Difficulty } from "./run-rules.js";
import type { RecordedRun } from "./runs-hooks.js";

/**
 * Факты о забеге для правил перепроверки (tasks/T-0319): какое место он занимает в
 * досках и какому дивизиону недели соответствует. Читает те же Redis-доски, что
 * рейтинг, но **не записывает** в них: решение принимается по тому, где забег стоял бы.
 *
 * Место считается от очков забега, а не от нынешнего места игрока: слабый забег
 * чемпиона в первую сотню не попадает, а забег, которым игрок вошёл в неё, — да.
 * Слушатель таблицы недели работает рядом и мог ещё не записать этот забег, поэтому
 * «стоял бы» — это число игроков строго выше его очков плюс один, и оно не зависит
 * от того, успела ли запись.
 */

const REDIS_TIMEOUT_MS = 2_000;

/** Где забег стоял бы в таблице недели: место и размер таблицы с ним. */
export interface SeasonPlace {
  place: number;
  size: number;
}

export interface SeasonPlaces {
  placeOf(input: { accountId: string; difficulty: Difficulty; finishedAt: Date; survivalSec: number; points: number; board: Board }): Promise<SeasonPlace | null>;
}

export const REPLAY_SEASON_PLACES = Symbol("REPLAY_SEASON_PLACES");

/**
 * Таблица недели и расписание сезонов живут в модуле сезонов, а тот подключает модуль
 * забегов, поэтому статически подключить их сюда нельзя — получился бы круг. Берём их
 * из контейнера по требованию; нет модуля сезонов (старый состав приложения, тесты) —
 * сезонных правил просто нет.
 */
@Injectable()
export class ModuleRefSeasonPlaces implements SeasonPlaces {
  private resolved: { schedule: SeasonSchedule; store: SeasonBoardStore } | null | undefined;

  constructor(private readonly moduleRef: ModuleRef) {}

  async placeOf(input: { accountId: string; difficulty: Difficulty; finishedAt: Date; survivalSec: number; points: number; board: Board }): Promise<SeasonPlace | null> {
    const seasons = this.seasons();
    if (seasons === null) return null;
    const { schedule, store } = seasons;
    const season = schedule.current(input.finishedAt);
    if (season === null) return null;
    const score = scoreOf({ survivalSec: input.survivalSec, points: input.points }, schedule.scoringOf(season));
    if (score === null) return null;
    const key = schedule.boardSeason(season).key;
    const best = await withTimeout(store.best(key, input.difficulty, input.accountId, input.board), REDIS_TIMEOUT_MS, "replay: лучший счёт недели");
    // Забег хуже лучшего забега недели таблицу не двигает — верх ему не засчитывается.
    if (best !== null && best > score) return null;
    const [above, count] = await Promise.all([
      withTimeout(store.countAbove(key, input.difficulty, score, input.board), REDIS_TIMEOUT_MS, "replay: выше в таблице недели"),
      withTimeout(store.count(key, input.difficulty, input.board), REDIS_TIMEOUT_MS, "replay: размер таблицы недели"),
    ]);
    // Игрока в таблице ещё нет или он ниже этого забега — этот забег добавит одну строку или заменит прежнюю.
    return { place: above + 1, size: best === null ? count + 1 : count };
  }

  private seasons(): { schedule: SeasonSchedule; store: SeasonBoardStore } | null {
    if (this.resolved !== undefined) return this.resolved;
    try {
      this.resolved = {
        schedule: this.moduleRef.get(SeasonSchedule, { strict: false }),
        store: this.moduleRef.get<SeasonBoardStore>(SEASON_BOARD_STORE, { strict: false }),
      };
    } catch {
      // Модуля сезонов в приложении нет: не кеш неудачи, а состав приложения — он до перезапуска не меняется.
      this.resolved = null;
    }
    return this.resolved;
  }
}

@Injectable()
export class RunReplayFacts implements ReplayFactsReader {
  constructor(
    @Inject(LEADERBOARD_STORE) private readonly leaderboard: LeaderboardStore,
    private readonly rating: RatingRestrictions,
    @Optional() @Inject(REPLAY_SEASON_PLACES) private readonly seasons: SeasonPlaces | null = null,
  ) {}

  async of(run: RecordedRun): Promise<ReplayFacts> {
    const base: ReplayFacts = {
      mode: run.mode ?? "endless",
      cheats: run.cheats,
      verdict: run.verdict,
      ranked: run.ranked,
      boardPlace: null,
      seasonPlace: null,
      seasonDivision: null,
      // Добыча забега выпадает позже, чем он записан; о ней повтору сообщает `RunReplayService.require`.
      lootRarity: null,
      rubezhCleared: run.rubezhCleared === true,
    };
    if (!run.ranked || run.points === undefined || run.points === null) return base;

    const board = await this.rating.boardOf(run.accountId, run.finishedAt);
    const boardPlace = await this.boardPlace(run, run.points, board);
    const season = this.seasons === null ? null : await this.seasons.placeOf({ accountId: run.accountId, difficulty: run.difficulty, finishedAt: run.finishedAt, survivalSec: run.survivalSec, points: run.points, board });
    const division: Division | null = season === null ? null : divisionOf(season.place, season.size);
    return { ...base, boardPlace, seasonPlace: season?.place ?? null, seasonDivision: division };
  }

  /** Место забега на доске всех времён; `null` — он не лучший забег игрока и верх не двигает. */
  private async boardPlace(run: RecordedRun, points: number, board: Board): Promise<number | null> {
    const best = await withTimeout(this.leaderboard.best(run.difficulty, run.accountId, board), REDIS_TIMEOUT_MS, "replay: лучший счёт доски");
    if (best === null || best > points) return null;
    return (await withTimeout(this.leaderboard.countAbove(run.difficulty, points, board), REDIS_TIMEOUT_MS, "replay: выше в доске")) + 1;
  }
}
