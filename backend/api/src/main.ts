import "reflect-metadata";
import { json } from "express";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
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

  installShutdownHandlers(app);
  exitWhenOrphaned(app, config.nodeEnv === "development");

  try {
    await app.listen(config.apiPort, config.apiHost);
  } catch (error: unknown) {
    reportListenFailure(error, config.apiPort);
    process.exit(1);
  }

  console.log(`API запущен на http://localhost:${config.apiPort}`);
}

/**
 * Корректное завершение по сигналу.
 *
 * Без этого процесс уходит, не закрыв сокет, и порт остаётся занятым до
 * перезагрузки — на Windows это уже приводило к `EADDRINUSE` после каждого
 * Ctrl+C. `SIGBREAK` в списке не случайно: это Ctrl+Break, и он есть только
 * на Windows, где работает вся команда (CLAUDE.md, «Окружение команды»).
 */
function installShutdownHandlers(app: INestApplication): void {
  app.enableShutdownHooks();

  let closing = false;
  const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;

  for (const signal of signals) {
    process.on(signal, () => {
      // Повторный Ctrl+C во время закрытия не должен запускать вторую попытку:
      // человек жмёт его именно тогда, когда кажется, что процесс завис.
      if (closing) {
        console.log("Повторный сигнал — завершаюсь немедленно");
        process.exit(1);
      }
      closing = true;

      console.log(`Получен ${signal}, закрываю соединения`);
      void app
        .close()
        .catch((error: unknown) => console.error("Ошибка при закрытии:", error))
        .finally(() => process.exit(0));
    });
  }
}

/**
 * Сторож на случай, когда процесс остался сиротой.
 *
 * На Windows Ctrl+C не всегда доходит до внуков в дереве процессов: родитель
 * умирает, а бэкенд продолжает жить и держать порт до перезагрузки. Признак
 * такого состояния — закрытый stdin: поток от родителя оборвался, значит
 * родителя больше нет и работать не для кого.
 *
 * Только в разработке: в проде процессом управляет Docker, там stdin ничего
 * не значит и закрывать себя по нему нельзя.
 */
function exitWhenOrphaned(app: INestApplication, isDevelopment: boolean): void {
  if (!isDevelopment) return;
  // В живом терминале stdin не закроется, а Ctrl+C дойдёт штатно — сторож там
  // не нужен и только мешал бы отладке.
  if (process.stdin.isTTY) return;

  const quit = (): void => {
    console.log("Родительский процесс завершился — освобождаю порт");
    void app.close().finally(() => process.exit(0));
  };

  process.stdin.on("end", quit);
  process.stdin.on("close", quit);
  process.stdin.resume();
}

/**
 * Занятый порт — самая частая ошибка запуска, и штатное сообщение Node о ней
 * не подсказывает, что делать. Поэтому разбираем её отдельно.
 */
function reportListenFailure(error: unknown, port: number): void {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;

  if (code === "EADDRINUSE") {
    console.error(
      [
        `Порт ${port} уже занят.`,
        "Скорее всего остался процесс от прошлого запуска — освободить: pnpm stop",
        "Порт задаётся переменной API_PORT (docs/20-env-and-ports.md §2).",
      ].join("\n"),
    );
    return;
  }

  console.error("Не удалось занять порт:", error);
}

bootstrap();
