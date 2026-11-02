import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { FriendsService } from "../friends/friends.service.js";
import { ProgressService } from "../progress/progress.service.js";
import type { AccountRef } from "../roles/roles.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { STATE_KINDS, isStateKind } from "../tasks/task-rules.js";
import type { TaskDelta } from "../tasks/tasks.repository.js";
import { TasksService } from "../tasks/tasks.service.js";
import { AchievementNotUnlockedError } from "./achievement-errors.js";
import { itemOf, percentOf, summaryItemOf, type AchievementsSummary, type AchievementsView } from "./achievement-rules.js";
import { ACHIEVEMENTS_REPOSITORY, type AchievementsRepository } from "./achievements.repository.js";

/**
 * Витрина достижений (docs/39-retention-mechanics.md К1, tasks/T-0106): список
 * с прогрессом, редкостью «есть у N%» и престижем, три любимых достижения игрока.
 *
 * Определения, прогресс и забор — в модуле заданий: достижение там та же строка
 * каталога. Здесь — то, что видит только витрина. Закрытое скрытое достижение
 * отдаёт одну подсказку (`itemOf`): сервер не показывает то, чего игрок ещё не
 * открыл. Число друзей и уровень аккаунта забег не двигает, поэтому сервер
 * читает их при открытии витрины и дописывает прогресс — «максимум», значение не
 * убывает.
 */

const DB_TIMEOUT_MS = 3_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Друзей и уровень читают до ответа витрины: дольше этого игрок ждать не должен. */
const STATE_TIMEOUT_MS = 3_000;

/** Сколько у игрока друзей — одним запросом, без списка. */
export interface FriendsCounter {
  friendCount(accountId: string): Promise<number>;
}

/** Уровень аккаунта игрока. */
export interface AccountLevels {
  view(accountId: string): Promise<{ level: number }>;
}

@Injectable()
export class AchievementsService {
  private readonly logger = new Logger("achievements");

  constructor(
    private readonly tasks: TasksService,
    @Inject(ACHIEVEMENTS_REPOSITORY) private readonly repository: AchievementsRepository,
    @Inject(FriendsService) private readonly friends: FriendsCounter,
    @Inject(ProgressService) private readonly levels: AccountLevels,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
  ) {}

  async view(account: AccountRef, at = new Date()): Promise<AchievementsView> {
    const { accountId } = account;
    await this.syncState(accountId, at);
    const [defs, rows, prestige, favorites, rarity] = await Promise.all([
      this.tasks.achievementDefs(),
      this.tasks.progressRows(accountId, at),
      this.db(this.repository.prestige(accountId)),
      this.db(this.repository.favorites(accountId)),
      this.db(this.repository.rarity()),
    ]);
    const minPlayers = this.settings.get(SETTINGS.achievementsRarityMinPlayers);
    // Знаменатель один у всех строк прохода: он же — «сколько игроков в счёте».
    const population = Math.max(0, ...[...rarity.rows.values()].map((row) => row.population));
    const cells = new Map(rows.map((row) => [row.taskId, row]));
    // Сравнение строк, а не `localeCompare`: порядок не должен зависеть от локали сервера.
    const ordered = [...defs].sort((a, b) => a.sort - b.sort || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
    return {
      prestige,
      favorites,
      rarity: { population, shown: population > 0 && population >= minPlayers, computedAt: rarity.computedAt?.toISOString() ?? null },
      items: ordered.map((def) => {
        const stat = rarity.rows.get(def.taskId);
        return itemOf(def, cells.get(def.taskId), stat === undefined ? null : percentOf(stat.holders, stat.population, minPlayers));
      }),
    };
  }

  /** Профиль: сумма престижа и три любимых. Список достижений и редкость ему не нужны. */
  async summary(accountId: string): Promise<AchievementsSummary> {
    const [defs, prestige, favorites] = await Promise.all([this.tasks.achievementDefs(), this.db(this.repository.prestige(accountId)), this.db(this.repository.favorites(accountId))]);
    const byId = new Map(defs.map((def) => [def.taskId, def]));
    return {
      prestige,
      favorites: favorites.flatMap((id) => {
        const def = byId.get(id);
        return def === undefined ? [] : [summaryItemOf(def)];
      }),
    };
  }

  /**
   * Заменить любимые достижения. Каждое должно быть выполнено игроком, иначе
   * `AchievementNotUnlockedError` и прежнее избранное остаётся. Повтор того же
   * запроса ничего не меняет и ничего не пишет.
   */
  async setFavorites(accountId: string, ids: readonly string[]): Promise<{ favorites: string[] }> {
    const result = await this.db(this.repository.replaceFavorites(accountId, ids));
    if (result.status === "missing") throw new AchievementNotUnlockedError();
    if (result.changed) this.logger.log(JSON.stringify({ module: "achievements", event: "favorites_set", accountId, count: result.ids.length }));
    return { favorites: result.ids };
  }

  /**
   * Престиж нескольких аккаунтов одним запросом — для рейтинга: у не имеющего
   * достижений ноль. Не-uuid отбрасывается: чужая строка не должна ронять запрос
   * на всю таблицу.
   */
  async prestigeOf(accountIds: readonly string[]): Promise<Map<string, number>> {
    const valid = [...new Set(accountIds.filter((id) => UUID.test(id)))];
    const totals = await this.db(this.repository.prestigeOf(valid));
    return new Map(accountIds.map((id) => [id, totals.get(id) ?? 0]));
  }

  /**
   * Дописать прогресс «друзья» и «уровень аккаунта». Сбой чтения витрину не роняет:
   * прогресс остаётся как был, а следующее открытие допишет.
   */
  private async syncState(accountId: string, at: Date): Promise<void> {
    try {
      // Только друзья и уровень: остальные состояния дописывают их модули (кодекс — `codex`).
      const defs = (await this.tasks.achievementDefs()).filter((def) => def.kind === "friends" || def.kind === "account_level");
      if (defs.length === 0) return;
      const wants = new Set(defs.map((def) => def.kind));
      const [friends, level] = await Promise.all([
        wants.has("friends") ? withTimeout(this.friends.friendCount(accountId), STATE_TIMEOUT_MS, "друзья") : Promise.resolve(0),
        wants.has("account_level") ? withTimeout(this.levels.view(accountId), STATE_TIMEOUT_MS, "уровень аккаунта").then((progress) => progress.level) : Promise.resolve(0),
      ]);
      const deltas = defs.flatMap((def): TaskDelta[] =>
        isStateKind(def.kind) ? [{ taskId: def.taskId, period: def.period, target: def.target, op: STATE_KINDS[def.kind].op, amount: def.kind === "friends" ? friends : level }] : [],
      );
      await this.tasks.applyState(accountId, deltas, at);
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "achievements", event: "state_sync_failed", accountId, reason: error instanceof Error ? error.message : "unknown" }));
    }
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "достижения");
  }
}
