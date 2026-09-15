import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { APP_CONFIG, type AppConfig } from "./config/app-config.js";
import { DomainErrorFilter } from "./common/domain-error.filter.js";

/**
 * Сборка HTTP-приложения — одна для `main.ts` и HTTP-тестов: префикс,
 * фильтр ошибок, лимит тела и CORS в тестах те же, что в проде, а не их копия.
 *
 * Платформа — Fastify (docs/16-tech-stack-decisions.md §5): одна на весь
 * бэкенд, второй платформы рядом не держим.
 */

/**
 * Верхняя граница тела запроса. Самое большое, что сейчас приходит, —
 * отчёт стресс-теста: до 600 корзин таймлайна, это сотни килобайт. Без
 * границы эндпоинт превращается в приём произвольных объёмов данных.
 */
export const BODY_LIMIT_BYTES = 2 * 1024 * 1024;

type EntryModule = Parameters<typeof NestFactory.create>[0];

export async function createHttpApp(module: EntryModule, options: { logger?: boolean } = {}): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({ bodyLimit: BODY_LIMIT_BYTES });
  const app = await NestFactory.create<NestFastifyApplication>(module, adapter, options.logger === false ? { logger: false } : {});
  configureHttpApp(app, app.get<AppConfig>(APP_CONFIG));
  return app;
}

function configureHttpApp(app: NestFastifyApplication, config: AppConfig): void {
  // Ошибки разбора тела — битый JSON, тело сверх лимита — Nest передаёт
  // этому же фильтру, поэтому клиент получает их в общей форме, а не в форме
  // ответа Fastify (проверяет test/http-app.test.ts).
  app.useGlobalFilters(new DomainErrorFilter());

  // health остаётся на корне: пробы и мониторинг не должны знать о версии API.
  app.setGlobalPrefix("api/v1", { exclude: ["health"] });

  app.enableCors({
    origin: config.allowedOrigins.length > 0 ? config.allowedOrigins : false,
    credentials: true,
  });
}
