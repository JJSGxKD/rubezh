import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { AccountRestrictions } from "../restrictions/account-restrictions.js";
import { RestrictionsHooks, type RestrictionChange } from "../restrictions/restrictions-hooks.js";
import { RatingRestrictions } from "../runs/rating-restrictions.js";
import { COMMON_ONLY } from "../runs/leaderboard.store.js";
import { DIFFICULTIES, type Difficulty } from "../runs/run-rules.js";
import { RunsHooks, type RecordedRun } from "../runs/runs-hooks.js";
import { SEASON_BOARD_STORE, type SeasonBoardStore } from "./season-board.store.js";
import { SeasonSchedule } from "./seasons-schedule.js";
import { SEASONS_REPOSITORY, type SeasonsRepository } from "./seasons.repository.js";

/**
 * Что делает живая таблица недели (Redis) с событиями вокруг неё
 * (tasks/T-0110). Модули забегов и ограничений о сезонах не знают: слушатели
 * подписываются сами, как у `RatingRestrictions`.
 *
 * - записан рейтинговый забег — время ложится в таблицу недели;
 * - модератор снял забег или вернул его — таблица игрока пересчитывается из базы;
 * - рейтинг игроку закрыт — он уходит из таблицы сразу, открыт — возвращается;
 * - скрытое ограничение «Отдельная доска» (T-0114, Р104) — игрок уходит из общей
 *   таблицы недели и остаётся в полной, снято — недельное время возвращается в общую.
 *
 * Таблиц две, как у вечного рейтинга: запись идёт по доскам аккаунта
 * (`RatingRestrictions.boardsFor`), пересборка строит обе.
 *
 * Таблица — кеш: закрытие сезона её не читает, а любое расхождение лечит
 * пересборка `rebuild` из базы.
 */

const DB_TIMEOUT_MS = 3_000;
const REDIS_TIMEOUT_MS = 2_000;
/** Виды, которые закрывают рейтинг: свой и блокировка целиком. */
const RATING_KINDS = new Set(["leaderboard", "all"]);

@Injectable()
export class SeasonsProjection implements OnModuleInit {
  private readonly logger = new Logger("seasons");

  constructor(
    private readonly schedule: SeasonSchedule,
    @Inject(SEASON_BOARD_STORE) private readonly store: SeasonBoardStore,
    @Inject(SEASONS_REPOSITORY) private readonly repository: SeasonsRepository,
    private readonly runsHooks: RunsHooks,
    private readonly restrictionsHooks: RestrictionsHooks,
    private readonly restrictions: AccountRestrictions,
    private readonly rating: RatingRestrictions,
  ) {}

  onModuleInit(): void {
    this.runsHooks.onRecorded("seasons", async (run) => await this.recorded(run));
    this.runsHooks.onRankingChanged("seasons", async (change) => await this.refresh(change.accountId, change.difficulty));
    this.restrictionsHooks.onImposed("seasons", async (change) => await this.imposed(change));
    this.restrictionsHooks.onSettled("seasons", async (change) => await this.settled(change));
    // Отдельная доска — свои слушатели: имена слушателей уникальны, а правила у них другие.
    this.restrictionsHooks.onImposed("seasons-board", async (change) => await this.separated(change));
    this.restrictionsHooks.onSettled("seasons-board", async (change) => await this.unseparated(change));
  }

  /**
   * Забег записан. Слушатель зовётся только при первой записи (`RunsHooks`),
   * а повтор итога из очереди клиента второй записи не даёт: `ZADD GT` не
   * опускает и не повторяет лучшее время. До старта сезонов и при выключенных
   * сезонах не пишется ничего.
   */
  async recorded(run: RecordedRun): Promise<void> {
    if (!run.ranked) return;
    const season = this.schedule.current(run.finishedAt);
    if (season === null) return;
    const boards = await withTimeout(this.rating.boardsFor(run.accountId, run.finishedAt), DB_TIMEOUT_MS, "seasons: доски аккаунта");
    await withTimeout(this.store.submit(season, run.difficulty, run.accountId, run.survivalSec, boards), REDIS_TIMEOUT_MS, "seasons: таблица недели");
  }

  /**
   * Пересчитать таблицу игрока по базе: модератор снял с рейтинга забег или
   * вернул его. Закрытые сезоны не трогаются — их итоги уже посчитаны.
   */
  async refresh(accountId: string, difficulty: Difficulty, at = new Date()): Promise<void> {
    const season = this.schedule.current(at);
    if (season === null) return;
    // Игрок с закрытым рейтингом из таблицы убран и вернётся по сроку — уже без снятого забега.
    if ((await this.restrictionOf(accountId, at)) !== null) return;
    const best = await withTimeout(this.repository.bestRun(accountId, difficulty, season, false), DB_TIMEOUT_MS, "seasons: лучший забег недели");
    const boards = await withTimeout(this.rating.boardsFor(accountId, at), DB_TIMEOUT_MS, "seasons: доски аккаунта");
    await withTimeout(this.store.set(season, difficulty, accountId, best?.survivalSec ?? null, boards), REDIS_TIMEOUT_MS, "seasons: таблица недели");
    // Отдельная доска: общая таблица игрока не держит, даже если время из базы осталось.
    if (!boards.includes("common")) await withTimeout(this.store.set(season, difficulty, accountId, null, COMMON_ONLY), REDIS_TIMEOUT_MS, "seasons: таблица недели");
  }

  /** Пересобрать таблицы текущей недели из базы; возвращает, сколько игроков на каждой сложности. */
  async rebuild(at = new Date()): Promise<Record<string, number>> {
    const season = this.schedule.current(at);
    const counts: Record<string, number> = {};
    if (season === null) return counts;
    const [excluded, separate] = await Promise.all([
      withTimeout(this.restrictions.restrictedAccounts("leaderboard", at), DB_TIMEOUT_MS, "seasons: ограничения"),
      withTimeout(this.rating.separate(at), DB_TIMEOUT_MS, "seasons: отдельная доска"),
    ]);
    const apart = new Set(separate);
    for (const difficulty of DIFFICULTIES) {
      // Полная — все рейтинговые, общая — те же без аккаунтов с отдельной доской.
      const entries = await this.repository.weekBests(difficulty, season, excluded);
      await this.store.replace(season, difficulty, entries, "full");
      await this.store.replace(season, difficulty, entries.filter((entry) => !apart.has(entry.accountId)), "common");
      counts[difficulty] = entries.length;
    }
    return counts;
  }

  private async imposed(change: RestrictionChange): Promise<void> {
    if (!change.kinds.some((kind) => RATING_KINDS.has(kind))) return;
    const season = this.schedule.current(change.at);
    if (season === null) return;
    await withTimeout(this.store.remove(season.key, [change.accountId]), REDIS_TIMEOUT_MS, "seasons: таблица недели");
    this.logger.log(JSON.stringify({ module: "seasons", event: "season_restricted", accountId: change.accountId }));
  }

  /** Отдельная доска наложена: из общей таблицы недели — сразу, полная не трогается. */
  private async separated(change: RestrictionChange): Promise<void> {
    if (!change.kinds.includes("separate_board")) return;
    const season = this.schedule.current(change.at);
    if (season === null) return;
    await withTimeout(this.store.remove(season.key, [change.accountId], COMMON_ONLY), REDIS_TIMEOUT_MS, "seasons: таблица недели");
    this.logger.log(JSON.stringify({ module: "seasons", event: "season_board_separated", accountId: change.accountId }));
  }

  /**
   * Отдельная доска снята или вышла: недельное время возвращается в общую из базы. Остаётся отдельной
   * (второе наложение) или рейтинг закрыт — рано: `refresh` смотрит на доски и закрытый рейтинг сам.
   */
  private async unseparated(change: RestrictionChange): Promise<void> {
    if (!change.kinds.includes("separate_board")) return;
    for (const difficulty of DIFFICULTIES) await this.refresh(change.accountId, difficulty, change.at);
  }

  private async settled(change: RestrictionChange): Promise<void> {
    if (!change.kinds.some((kind) => RATING_KINDS.has(kind))) return;
    // Сняли ограничение рейтинга, а блокировка ещё держит — или наоборот: в таблицу рано.
    if ((await this.restrictionOf(change.accountId, change.at)) !== null) return;
    for (const difficulty of DIFFICULTIES) await this.refresh(change.accountId, difficulty, change.at);
  }

  private async restrictionOf(accountId: string, at: Date) {
    return await withTimeout(this.restrictions.status(accountId, "leaderboard", at), DB_TIMEOUT_MS, "seasons: ограничения");
  }
}
