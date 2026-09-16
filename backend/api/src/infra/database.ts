import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { PrismaClient } from "../generated/prisma/client.js";

/**
 * Postgres через Prisma 7 и драйвер pg (docs/16-tech-stack-decisions.md §5).
 * Клиент — только в репозиториях модулей: запрос из сервиса или контроллера —
 * замечание на ревью (docs/15-engineering-standards.md §2.3).
 *
 * Подключение ленивое: пул открывает соединение на первом запросе, и бэкенд
 * с выключенными приёмниками поднимается без базы.
 */
export const PRISMA = Symbol("PRISMA");

/** Ждать соединения из пула не дольше — недоступная база не вешает запрос игрока. */
const CONNECT_TIMEOUT_MS = 3_000;
/**
 * Потолок запроса на стороне Postgres. Приём пишет пачками в миллисекунды;
 * выгрузка читает постранично, и страница не должна держать базу дольше.
 */
const STATEMENT_TIMEOUT_MS = 15_000;
const POOL_SIZE = 10;

export function createPrisma(config: AppConfig): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    max: POOL_SIZE,
  });
  return new PrismaClient({ adapter });
}

@Injectable()
export class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

@Global()
@Module({
  providers: [{ provide: PRISMA, inject: [APP_CONFIG], useFactory: createPrisma }, DatabaseLifecycle],
  exports: [PRISMA],
})
export class DatabaseModule {}
