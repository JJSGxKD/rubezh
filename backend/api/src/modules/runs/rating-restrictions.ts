import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { AccountRestrictions } from "../restrictions/account-restrictions.js";
import { RestrictionsHooks, type RestrictionChange } from "../restrictions/restrictions-hooks.js";
import { LEADERBOARD_STORE, type LeaderboardStore } from "./leaderboard.store.js";
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
 */

const LOCK_KEY = "runs:rating-restrictions:lock";
const TICK_MS = 60_000;
const LOCK_TTL_MS = 50_000;
const DB_TIMEOUT_MS = 3_000;
const REDIS_TIMEOUT_MS = 2_000;
/** Виды, которые закрывают рейтинг: свой и блокировка целиком. */
const RATING_KINDS = new Set(["leaderboard", "all"]);

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

  /** Кому рейтинг закрыт сейчас — пересборка досок их не возвращает. */
  async excluded(at = new Date()): Promise<string[]> {
    return await this.restrictions.restrictedAccounts("leaderboard", at);
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

  /** Убрать из досок всех, кому рейтинг закрыт; возвращает, сколько мест сняло — обычно ноль. */
  async sweep(at = new Date()): Promise<number> {
    const restricted = await this.excluded(at);
    const removed = await this.redisCall(this.leaderboard.remove(restricted));
    // Не ноль — ограниченный успел вернуться в доску гонкой с наложением.
    if (removed > 0) this.log("log", "rating_restricted_swept", { removed });
    return removed;
  }

  private async imposed(change: RestrictionChange): Promise<void> {
    if (!change.kinds.some((kind) => RATING_KINDS.has(kind))) return;
    await this.redisCall(this.leaderboard.remove([change.accountId]));
    this.log("log", "rating_restricted", { accountId: change.accountId });
  }

  private async settled(change: RestrictionChange): Promise<void> {
    if (!change.kinds.some((kind) => RATING_KINDS.has(kind))) return;
    // Сняли ограничение рейтинга, а блокировка ещё держит — или наоборот: в доску рано.
    if ((await this.hold(change.accountId, change.at)) !== null) return;
    let restored = 0;
    for (const difficulty of DIFFICULTIES) {
      // Лучший рейтинговый: сданные под ограничением рейтинговыми не стали.
      const best = await withTimeout(this.runs.bestRunOf(change.accountId, difficulty, false), DB_TIMEOUT_MS, "runs: база");
      if (best === null) continue;
      await this.redisCall(this.leaderboard.submit(difficulty, change.accountId, best.survivalSec));
      restored += 1;
    }
    this.log("log", "rating_restored", { accountId: change.accountId, boards: restored });
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
