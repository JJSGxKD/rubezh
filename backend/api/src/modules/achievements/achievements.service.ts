import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { FriendsService } from "../friends/friends.service.js";
import { ProgressService } from "../progress/progress.service.js";
import type { AccountRef } from "../roles/roles.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { STATE_KINDS, isEmblemKind, isStateKind, type TaskDef } from "../tasks/task-rules.js";
import type { TaskDelta } from "../tasks/tasks.repository.js";
import { TasksService } from "../tasks/tasks.service.js";
import { AchievementNotUnlockedError } from "./achievement-errors.js";
import { itemOf, percentOf, summaryItemOf, type AchievementsSummary, type AchievementsView, type ProgressCell } from "./achievement-rules.js";
import { ACHIEVEMENTS_REPOSITORY, type AchievementsRepository } from "./achievements.repository.js";
import { EmblemsService } from "./emblems.service.js";

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
    // Знаки у имени (T-0235): без сервиса статусных и сезонных знаков в витрине и «любимых» нет.
    @Optional() private readonly emblems?: EmblemsService,
  ) {}

  async view(account: AccountRef, at = new Date()): Promise<AchievementsView> {
    const { accountId } = account;
    await this.syncState(accountId, at);
    const [defs, rows, prestige, stored, rarity, specials] = await Promise.all([
      this.tasks.achievementDefs(),
      this.tasks.progressRows(accountId, at),
      this.db(this.repository.prestige(accountId)),
      this.db(this.repository.favorites(accountId)),
      this.db(this.repository.rarity()),
      this.heldSpecial(accountId, at),
    ]);
    const favorites = withoutLostEmblems(stored, defs, specials);
    const minPlayers = this.settings.get(SETTINGS.achievementsRarityMinPlayers);
    // Знаменатель один у всех строк прохода: он же — «сколько игроков в счёте».
    const population = Math.max(0, ...[...rarity.rows.values()].map((row) => row.population));
    const cells = new Map<string, ProgressCell>(rows.map((row) => [row.taskId, row]));
    // Статусный и сезонный знак выполнен, пока игрок его держит: прогресса и награды у него нет.
    for (const def of defs) if (isEmblemKind(def.kind) && specials.has(def.taskId)) cells.set(def.taskId, { value: def.target, done: true, claimed: true });
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
    const [defs, prestige, stored] = await Promise.all([this.tasks.achievementDefs(), this.db(this.repository.prestige(accountId)), this.db(this.repository.favorites(accountId))]);
    // Знаки читаются, только если среди любимых есть статусный или сезонный: остальным профилям лишний запрос не нужен.
    const hasEmblem = stored.some((id) => defs.some((def) => def.taskId === id && isEmblemKind(def.kind)));
    const favorites = withoutLostEmblems(stored, defs, hasEmblem ? await this.heldSpecial(accountId, new Date()) : new Set<string>());
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
    // Статусный и сезонный знак выполнять нечем: «получено» значит «держится сейчас», и это решает сервис знаков.
    const defs = await this.tasks.achievementDefs();
    const emblemIds = new Set(defs.filter((def) => isEmblemKind(def.kind)).map((def) => def.taskId));
    const asked = ids.filter((id) => emblemIds.has(id));
    if (asked.length > 0) {
      const held = await this.heldSpecial(accountId, new Date());
      if (asked.some((id) => !held.has(id))) throw new AchievementNotUnlockedError();
    }
    const result = await this.db(this.repository.replaceFavorites(accountId, ids, asked));
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

  /** Статусные и сезонные знаки, которые игрок держит сейчас; без сервиса знаков — никакие. */
  private async heldSpecial(accountId: string, at: Date): Promise<ReadonlySet<string>> {
    return this.emblems === undefined ? new Set<string>() : await this.db(this.emblems.heldSpecial(accountId, at));
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "достижения");
  }
}

/**
 * Любимые без статусных и сезонных знаков, которые игрок больше не держит: VIP истёк — знака нет, и
 * снимать ничего не нужно. Строка избранного остаётся и возвращается вместе со знаком.
 */
function withoutLostEmblems(favorites: readonly string[], defs: readonly TaskDef[], held: ReadonlySet<string>): string[] {
  const emblemIds = new Set(defs.filter((def) => isEmblemKind(def.kind)).map((def) => def.taskId));
  return favorites.filter((id) => !emblemIds.has(id) || held.has(id));
}
