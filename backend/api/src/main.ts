import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

/**
 * Единая точка входа бэкенда для ВСЕХ платформ — Telegram/MAX/VK/Web
 * бьют в один и тот же API. См. docs/01-tech-stack.md §3.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors(); // TODO: сузить до конкретных доменов мини-апп перед проном
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`API запущен на http://localhost:${port}`);
}

bootstrap();
