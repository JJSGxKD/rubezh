import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

/**
 * Единая точка входа бэкенда для ВСЕХ платформ — Telegram/MAX/VK/Web
 * бьют в один и тот же API. См. docs/01-tech-stack.md §3.
 *
 * Порт и список разрешённых origin берутся из окружения — карта портов и
 * различия dev/staging/prod в docs/20-env-and-ports.md. Значения по
 * умолчанию здесь только для локального запуска: в staging и production
 * переменные задаются явно, и приложение не должно полагаться на дефолты
 * (docs/15-engineering-standards.md §9).
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // TODO(участник 1): заменить на валидированную Zod-схемой конфигурацию,
  // когда появится модуль config — docs/16-tech-stack-decisions.md §6.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    credentials: true,
  });

  const port = Number(process.env.API_PORT ?? 4000);
  const host = process.env.API_HOST ?? "0.0.0.0";

  await app.listen(port, host);
  console.log(`API запущен на http://localhost:${port}`);
}

bootstrap();
