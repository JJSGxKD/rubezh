import { Global, Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
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

/** Таблицы, без которых включённая часть бэкенда работать не будет. */
const REQUIRED_TABLES = ["analytics_event", "diagnostic_report", "data_export"] as const;

const MIGRATION_HINT = "примените миграции: pnpm --filter backend-api prisma:deploy";

/**
 * Сообщение об ошибке базы для лога. Prisma на непринятых миграциях говорит
 * «таблицы нет», но не говорит, что делать, — а это самая частая причина:
 * поднятая база без миграций.
 */
export function describeDbError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown";
  return /does not exist in the current database|не существует/i.test(message) ? `${message} (${MIGRATION_HINT})` : message;
}

/**
 * Проверка схемы на старте: непринятые миграции иначе видны только по
 * бесконечным повторам записи пачек событий в логе, и то не сразу.
 */
@Injectable()
export class DatabaseSchemaCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger("database");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.databaseUrl === "") return;
    try {
      const missing = await this.missingTables();
      if (missing.length === 0) return;
      this.logger.error(
        JSON.stringify({ module: "database", event: "schema_incomplete", missing, hint: MIGRATION_HINT }),
      );
    } catch (error: unknown) {
      // База может быть ещё не поднята: это не повод не стартовать — приёмники
      // переживают недоступную базу сами.
      this.logger.warn(JSON.stringify({ module: "database", event: "schema_check_failed", reason: describeDbError(error) }));
    }
  }

  private async missingTables(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public'
    `;
    const present = new Set(rows.map((row) => row.table_name));
    return REQUIRED_TABLES.filter((table) => !present.has(table));
  }
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
  providers: [{ provide: PRISMA, inject: [APP_CONFIG], useFactory: createPrisma }, DatabaseLifecycle, DatabaseSchemaCheck],
  exports: [PRISMA],
})
export class DatabaseModule {}
