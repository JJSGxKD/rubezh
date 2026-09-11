import "reflect-metadata";
import { json } from "express";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { APP_CONFIG, type AppConfig } from "./config/app-config";
import { DomainErrorFilter } from "./common/domain-error.filter";

/**
 * Единая точка входа бэкенда для ВСЕХ платформ — Telegram/MAX/VK/Web
 * бьют в один и тот же API. См. docs/01-tech-stack.md §3.
 *
 * Конфигурация валидируется Zod-схемой при старте: невалидное окружение =
 * процесс не поднимается (docs/20-env-and-ports.md §1, правило 3).
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get<AppConfig>(APP_CONFIG);

  // Отчёт испытания — это сотни корзин таймлайна, дефолтный лимит в 100 КБ
  // его не пропустит. Верхняя граница всё равно нужна: без неё эндпоинт
  // превращается в приём произвольных объёмов данных.
  app.use(json({ limit: "2mb" }));
  app.useGlobalFilters(new DomainErrorFilter());

  // health остаётся на корне: пробы и мониторинг не должны знать о версии API.
  app.setGlobalPrefix("api/v1", { exclude: ["health"] });

  app.enableCors({
    origin: config.allowedOrigins.length > 0 ? config.allowedOrigins : false,
    credentials: true,
  });

  await app.listen(config.apiPort, config.apiHost);

  console.log(`API запущен на http://localhost:${config.apiPort}`);
}

bootstrap();
