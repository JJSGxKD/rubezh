import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import type { RestrictionKind } from "./restriction-catalog.js";
import { isActive, playerMessage, playerView, type PlayerRestrictionView } from "./restriction-rules.js";
import { AccountRestrictedError, RestrictionSilentError } from "./restrictions-errors.js";
import { RESTRICTIONS_REPOSITORY, type RestrictionRow, type RestrictionsRepository } from "./restrictions.repository.js";

/**
 * Порт «можно ли» (docs/35-stage4-plan.md WP44): модуль спрашивает в момент
 * действия, ограничен ли игрок, и сам решает, как отказать. Блокировка
 * целиком закрывает и всё остальное: токен входа живёт свои минуты и после
 * отзыва сессий.
 *
 * Ответ кешируется на реплике на полминуты — его спрашивает каждая награда,
 * а ограничения накладываются единицами в день. Наложение и снятие
 * сбрасывают кеш сразу на всех репликах сообщением в Redis; не дошло
 * сообщение — разойдётся не дольше полуминуты. Истечение срока кеш не
 * держит: строка проверяется по времени в момент вопроса.
 */

export const RESTRICTIONS_CHANNEL = "restrictions:changed";

const CACHE_TTL_MS = 30_000;
/** Больше — сбрасываем целиком: игроков с вопросами за полминуты столько не бывает, а память не резиновая. */
const CACHE_MAX = 50_000;
const DB_TIMEOUT_MS = 3_000;
/** Ограничения накладывают руками — столько действующих разом не бывает; потолок — от ошибки, а не от нормы. */
const ACCOUNTS_LIMIT = 100_000;
const REDIS_TIMEOUT_MS = 1_000;

@Injectable()
export class AccountRestrictions implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccountRestrictions.name);
  private readonly cache = new Map<string, { rows: RestrictionRow[]; until: number }>();
  private subscriber: Redis | null = null;

  constructor(
    @Inject(RESTRICTIONS_REPOSITORY) private readonly repository: RestrictionsRepository,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.config.databaseUrl === "") return;
    await this.subscribe();
  }

  onModuleDestroy(): void {
    this.subscriber?.disconnect();
  }

  /** Действующее ограничение вида — или блокировка целиком; `null` — можно. */
  async status(accountId: string, kind: RestrictionKind, at = new Date()): Promise<RestrictionRow | null> {
    const rows = await this.rows(accountId, at);
    return rows.find((row) => row.kind === kind && isActive(row, at)) ?? rows.find((row) => row.kind === "all" && isActive(row, at)) ?? null;
  }

  /**
   * Отказать, если закрыто. Игроку, которому решили сообщить, — что закрыто,
   * до какого числа и почему; молчаливое — нейтральный отказ, как сбой.
   */
  async ensure(accountId: string, kind: RestrictionKind, at = new Date()): Promise<void> {
    const hit = await this.status(accountId, kind, at);
    if (hit === null) return;
    this.logger.log(JSON.stringify({ module: "restrictions", event: "restriction_refused", accountId, kind, restriction: hit.kind, silent: !hit.notify }));
    throw hit.notify ? new AccountRestrictedError(playerMessage(hit)) : new RestrictionSilentError();
  }

  /** Что игрок видит в профиле: действующие, о которых решили сообщить. */
  async visibleFor(accountId: string, at = new Date()): Promise<PlayerRestrictionView[]> {
    return (await this.rows(accountId, at)).filter((row) => row.notify && isActive(row, at)).map(playerView);
  }

  /**
   * Все, кому вид закрыт сейчас, — своим ограничением или блокировкой. Без
   * кеша: его зовут обход последствий и пересборка рейтинга, а не каждый
   * запрос игрока.
   */
  async restrictedAccounts(kind: RestrictionKind, at = new Date()): Promise<string[]> {
    return await withTimeout(this.repository.activeAccounts([kind, "all"], at, ACCOUNTS_LIMIT), DB_TIMEOUT_MS, "restrictions: база");
  }

  /** Сбросить кеш аккаунта здесь и на соседних репликах. */
  async forget(accountId: string): Promise<void> {
    this.cache.delete(accountId);
    try {
      await withTimeout(this.redis.publish(RESTRICTIONS_CHANNEL, accountId), REDIS_TIMEOUT_MS, "сообщение об ограничении");
    } catch (error: unknown) {
      this.log("warn", "restrictions_not_published", { accountId, reason: reasonOf(error) });
    }
  }

  private async rows(accountId: string, at: Date): Promise<RestrictionRow[]> {
    const cached = this.cache.get(accountId);
    if (cached !== undefined && cached.until > Date.now()) return cached.rows;
    const rows = await withTimeout(this.repository.active(accountId, at), DB_TIMEOUT_MS, "restrictions: база");
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(accountId, { rows, until: Date.now() + CACHE_TTL_MS });
    return rows;
  }

  private async subscribe(): Promise<void> {
    const subscriber = this.redis.duplicate();
    subscriber.on("message", (_channel: string, accountId: string) => this.cache.delete(accountId));
    let down = false;
    subscriber.on("error", (error: Error) => {
      if (!down) this.log("warn", "restrictions_subscriber_down", { reason: error.message });
      down = true;
    });
    // Пропущенные за обрыв сообщения не вернуть — кеш целиком устаревает сам за полминуты, но сбросить сразу честнее.
    subscriber.on("ready", () => {
      if (!down) return;
      down = false;
      this.cache.clear();
    });
    try {
      await withTimeout(subscriber.subscribe(RESTRICTIONS_CHANNEL), REDIS_TIMEOUT_MS, "подписка на ограничения");
      this.subscriber = subscriber;
    } catch (error: unknown) {
      subscriber.disconnect();
      this.log("warn", "restrictions_not_subscribed", { reason: reasonOf(error) });
    }
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "restrictions", event, ...fields }));
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
