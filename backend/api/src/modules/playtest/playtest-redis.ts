import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";

/**
 * Одно подключение к Redis на весь модуль плейтеста: хранилище забегов,
 * статистика и бот ходят через него, а не открывают по своему соединению.
 *
 * Каждая команда — с таймаутом клиента: недоступный Redis не должен вешать
 * запрос игрока (CLAUDE.md, «Стиль кода»).
 */
export const PLAYTEST_REDIS = Symbol("PLAYTEST_REDIS");

export function createPlaytestRedis(config: AppConfig): Redis {
  return new Redis(config.redisUrl, {
    lazyConnect: true,
    connectTimeout: 2_000,
    commandTimeout: 2_000,
    maxRetriesPerRequest: 1,
  });
}

/**
 * Подключение закрывается последним — на `onApplicationShutdown`, а не
 * `onModuleDestroy`: бот сводки на своём `onModuleDestroy` ещё отпускает лок
 * в Redis, а порядок хуков внутри одной фазы Nest не гарантирует.
 */
@Injectable()
export class PlaytestRedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PLAYTEST_REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await closeRedis(this.redis);
  }
}

/**
 * С ленивым подключением клиент мог так и не подключиться: `quit` тогда
 * сперва подключился бы, чтобы попрощаться.
 */
export async function closeRedis(redis: Redis): Promise<void> {
  if (redis.status === "wait") {
    redis.disconnect();
    return;
  }
  await redis.quit().catch(() => redis.disconnect());
}

export const playtestRedisProvider = {
  provide: PLAYTEST_REDIS,
  inject: [APP_CONFIG],
  useFactory: createPlaytestRedis,
};
