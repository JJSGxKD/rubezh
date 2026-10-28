import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { AccountRestrictions } from "../restrictions/account-restrictions.js";
import { RestrictionsHooks, type RestrictionChange } from "../restrictions/restrictions-hooks.js";
import { ALL_BOARDS, COMMON_ONLY, FULL_ONLY, LEADERBOARD_STORE, type Board, type LeaderboardStore } from "./leaderboard.store.js";
import { DIFFICULTIES } from "./run-rules.js";
import { RUNS_REPOSITORY, type RatingRestricted, type RunsRepository } from "./runs.repository.js";

/**
 * Ограничение рейтинга (docs/35-stage4-plan.md WP44, О40): игрок пропадает
 * из досок сразу, забеги за это время в рейтинг не идут ни сейчас, ни потом,
 * а когда ограничение снято или вышло — возвращается с лучшим забегом до
 * него. Блокировка целиком закрывает рейтинг так же.
 *
 * Доски — проекция в Redis, поэтому убрать и вернуть — дело этого модуля:
 * - наложение — сразу, слушателем `RestrictionsHooks`;
 * - снятие и срок — слушателем задачи модуля ограничений: не вернулось —
 *   ограничение не отмечается сведённым, и задача повторит его;
 * - обход раз в минуту под локом убирает из досок всех, кому рейтинг закрыт:
 *   итог забега, принятый в ту же секунду, что наложение, или упавший Redis
 *   не оставят ограниченного в доске дольше минуты.
 *
 * Досок две (docs/35-stage4-plan.md, Р104, T-0113). Закрытый рейтинг убирает
 * аккаунт из обеих. Скрытая «Отдельная доска» оставляет его в полной и убирает
 * из общей: слушатель `board` переносит его туда и обратно, обход добирает
 * гонку «забег принят в ту же секунду, что наложение» — она живёт не дольше
 * минуты.
 */

const LOCK_KEY = "runs:rating-restrictions:lock";
const TICK_MS = 60_000;
const LOCK_TTL_MS = 50_000;
const DB_TIMEOUT_MS = 3_000;
const REDIS_TIMEOUT_MS = 2_000;
/** Виды, которые закрывают рейтинг: свой и блокировка целиком. */
const RATING_KINDS = new Set(["leaderboard", "all"]);

/** Доска, которую читает игрок: полная (с отдельной доской) или общая, без игроков отдельной доски. */
export type BoardView = Board;

/**
 * Доски записи по доске чтения: тот, кто читает полную, пишется только в неё.
 * Отдельной функцией, чтобы приём забега читал ограничение один раз и писал
 * туда же, откуда читает ответ.
 */
export function boardsOf(board: BoardView): readonly Board[] {
  return board === "full" ? FULL_ONLY : ALL_BOARDS;
}

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

@Injectable()
export class RatingRestrictions implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("runs");
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "eval">,
    @Inject(RUNS_REPOSITORY) private readonly runs: RunsRepository,
    @Inject(LEADERBOARD_STORE) private readonly leaderboard: LeaderboardStore,
    private readonly restrictions: AccountRestrictions,
    private readonly hooks: RestrictionsHooks,
  ) {}

  onModuleInit(): void {
    this.hooks.onImposed("rating", async (change) => await this.imposed(change));
    this.hooks.onSettled("rating", async (change) => await this.settled(change));
    this.hooks.onImposed("board", async (change) => await this.separated(change));
    this.hooks.onSettled("board", async (change) => await this.unseparated(change));
  }

  onApplicationBootstrap(): void {
    if (this.config.databaseUrl === "") return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** Закрыт ли рейтинг игроку сейчас и как: `null` — открыт. */
  async hold(accountId: string, at = new Date()): Promise<RatingRestricted | null> {
    const row = await this.restrictions.status(accountId, "leaderboard", at);
    return row === null ? null : row.notify ? "notified" : "silent";
  }

  /**
   * Какую доску читает аккаунт: `"full"` — только при действующем скрытом
   * ограничении «Отдельная доска» (T-0112). Блокировку целиком `status`
   * подставляет вместо любого вида — это не отдельная доска, а закрытый
   * рейтинг: она `"common"`. Через порт «можно ли», поэтому сброс кеша после
   * наложения действует сразу, а не через полминуты.
   */
  async boardOf(accountId: string, at = new Date()): Promise<BoardView> {
    const row = await this.restrictions.status(accountId, "separate_board", at);
    return row?.kind === "separate_board" ? "full" : "common";
  }

  /**
   * В какие доски писать результат аккаунта: аккаунту с отдельной доской —
   * только в полную, остальным — в обе (лучшее время игрока на досках одно).
   */
  async boardsFor(accountId: string, at = new Date()): Promise<readonly Board[]> {
    return boardsOf(await this.boardOf(accountId, at));
  }

  /** Кому рейтинг закрыт сейчас — пересборка досок их не возвращает. */
  async excluded(at = new Date()): Promise<string[]> {
    return await this.restrictions.restrictedAccounts("leaderboard", at);
  }

  /** У кого сейчас отдельная доска — пересборка кладёт их только в полную. */
  async separate(at = new Date()): Promise<string[]> {
    return await this.restrictions.restrictedAccounts("separate_board", at);
  }

  /** Одна проверка обхода; `null` — не запускался: идёт предыдущий, лок у другой реплики или Redis недоступен. */
  async tick(at = new Date()): Promise<number | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const token = randomUUID();
      if ((await this.redis.set(LOCK_KEY, token, "PX", LOCK_TTL_MS, "NX")) === null) return null;
      try {
        return await this.sweep(at);
      } finally {
        await this.redis.eval(RELEASE_SCRIPT, 1, LOCK_KEY, token);
      }
    } catch (error: unknown) {
      this.log("warn", "rating_sweep_failed", { reason: reasonOf(error) });
      return null;
    } finally {
      this.running = false;
    }
  }

  /**
   * Убрать из досок всех, кому рейтинг закрыт, а из общей — ещё и тех, у кого
   * отдельная доска; возвращает, сколько мест сняло, — обычно ноль.
   */
  async sweep(at = new Date()): Promise<number> {
    const [restricted, separate] = [await this.excluded(at), await this.separate(at)];
    const removed = (await this.redisCall(this.leaderboard.remove(restricted, ALL_BOARDS))) + (await this.redisCall(this.leaderboard.remove(separate, COMMON_ONLY)));
    // Не ноль — ограниченный успел вернуться в доску гонкой с наложением.
    if (removed > 0) this.log("log", "rating_restricted_swept", { removed });
    return removed;
  }

  private async imposed(change: RestrictionChange): Promise<void> {
    if (!change.kinds.some((kind) => RATING_KINDS.has(kind))) return;
    await this.redisCall(this.leaderboard.remove([change.accountId], ALL_BOARDS));
    this.log("log", "rating_restricted", { accountId: change.accountId });
  }

  private async settled(change: RestrictionChange): Promise<void> {
    if (!change.kinds.some((kind) => RATING_KINDS.has(kind))) return;
    // Сняли ограничение рейтинга, а блокировка ещё держит — или наоборот: в доску рано.
    if ((await this.hold(change.accountId, change.at)) !== null) return;
    // Отдельная доска могла остаться при снятии закрытого рейтинга — тогда назад только в полную.
    const restored = await this.restoreInto(change.accountId, await this.boardsFor(change.accountId, change.at));
    this.log("log", "rating_restored", { accountId: change.accountId, boards: restored });
  }

  /** Отдельная доска наложена: из общей — сразу, во всех сложностях; полная не трогается. */
  private async separated(change: RestrictionChange): Promise<void> {
    if (!change.kinds.includes("separate_board")) return;
    await this.redisCall(this.leaderboard.remove([change.accountId], COMMON_ONLY));
    this.log("log", "rating_board_separated", { accountId: change.accountId });
  }

  /**
   * Отдельная доска снята или вышла: в общую назад — лучший рейтинговый забег
   * каждой сложности. Выйти, если доска по-прежнему отдельная (второе
   * наложение) или рейтинг закрыт: тогда в общую рано, а в полную вернёт
   * слушатель закрытого рейтинга.
   */
  private async unseparated(change: RestrictionChange): Promise<void> {
    if (!change.kinds.includes("separate_board")) return;
    if ((await this.boardOf(change.accountId, change.at)) === "full" || (await this.hold(change.accountId, change.at)) !== null) return;
    const restored = await this.restoreInto(change.accountId, COMMON_ONLY);
    this.log("log", "rating_board_restored", { accountId: change.accountId, boards: restored });
  }

  /** Вернуть в доски лучший рейтинговый забег каждой сложности; сколько сложностей вернулось. */
  private async restoreInto(accountId: string, boards: readonly Board[]): Promise<number> {
    let restored = 0;
    for (const difficulty of DIFFICULTIES) {
      // Лучший рейтинговый: сданные под ограничением рейтинговыми не стали.
      const best = await withTimeout(this.runs.bestRunOf(accountId, difficulty, false), DB_TIMEOUT_MS, "runs: база");
      if (best === null) continue;
      await this.redisCall(this.leaderboard.submit(difficulty, accountId, best.survivalSec, boards));
      restored += 1;
    }
    return restored;
  }

  private async redisCall<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, REDIS_TIMEOUT_MS, "runs: рейтинг");
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "runs", event, ...fields }));
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
