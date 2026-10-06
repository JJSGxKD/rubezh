import "reflect-metadata";
import { Global, Module, type Type } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { APP_MODULES } from "../src/app.module.js";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { HealthController } from "../src/health/health.controller.js";
import { createHttpApp } from "../src/http-app.js";
import { AUTH_ENV } from "./helpers/auth-env.js";

/**
 * Приложение целиком: все модули, как в `AppModule`, на живых Postgres и
 * Redis (TEST_DATABASE_URL, PLAYTEST_TEST_REDIS_URL; без них — пропуск).
 *
 * Остальные тесты собирают модули по одному, и ошибка связывания — модуль не
 * видит провайдера, глобальный модуль ждёт токен другого — видна только на
 * старте всего приложения. До этого теста её поймал бы лишь сервер.
 *
 * Конфигурация — своя, а не из окружения: `configFromEnvironment` читает
 * `.env` разработчика, а там настоящий токен бота. Bot API направлен на
 * закрытый порт, обновления бот не читает — в Telegram не уходит ничего.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = process.env.PLAYTEST_TEST_REDIS_URL ?? "";

describe.skipIf(DATABASE_URL === "" || REDIS_URL === "")("приложение целиком", () => {
  it("собирается из всех модулей и отвечает на /health", async () => {
    const config = loadAppConfig({
      NODE_ENV: "test",
      ...AUTH_ENV,
      DATABASE_URL,
      REDIS_URL,
      TELEGRAM_API_ROOT: "http://127.0.0.1:9",
      TELEGRAM_BOT_UPDATES: "off",
    } as NodeJS.ProcessEnv);

    @Global()
    @Module({ providers: [{ provide: APP_CONFIG, useValue: config }], exports: [APP_CONFIG] })
    class TestConfigModule {}

    @Module({ imports: [TestConfigModule, ...APP_MODULES], controllers: [HealthController] })
    class BootModule {}

    const app = await createHttpApp(BootModule as Type<unknown>, { logger: false });
    try {
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
