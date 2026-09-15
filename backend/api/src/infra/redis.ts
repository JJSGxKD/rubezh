import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";

/**
 * Одно подключение к Redis на весь бэкенд: хранилища плейтеста, лимиты
 * частоты, локи и кэш бота ходят через него, а не открывают по своему
 * соединению (docs/16-tech-stack-decisions.md §5, «один клиент Redis»).
 * Очереди BullMQ открывают свои соединения сами — у блокирующего чтения
 * другие требования к таймаутам.
 *
 * Каждая команда — с таймаутом клиента: недоступный Redis не должен вешать
 * запрос игрока (CLAUDE.md, «Стиль кода»).
 */
export const REDIS = Symbol("REDIS");

export function createRedis(config: AppConfig): Redis {
  return new Redis(config.redisUrl, {
    lazyConnect: true,
    connectTimeout: 2_000,
    commandTimeout: 2_000,
    maxRetriesPerRequest: 1,
  });
}

/**
 * Подключение закрывается последним — на `onApplicationShutdown`, а не
 * `onModuleDestroy`: модули на своём `onModuleDestroy` ещё отпускают локи в
 * Redis, а порядок хуков внутри одной фазы Nest не гарантирует.
 */
@Injectable()
export class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

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

@Global()
@Module({
  providers: [{ provide: REDIS, inject: [APP_CONFIG], useFactory: createRedis }, RedisLifecycle],
  exports: [REDIS],
})
export class RedisModule {}
