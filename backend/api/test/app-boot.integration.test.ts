import "reflect-metadata";
import { Global, Module, type Type } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { APP_MODULES } from "../src/app.module.js";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { HealthController } from "../src/health/health.controller.js";
import { createHttpApp } from "../src/http-app.js";
import { ServerErrorAlarm } from "../src/modules/admin-notify/server-error-alarm.js";
import { AdminModule } from "../src/modules/admin/admin.module.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { SessionRecorder } from "../src/modules/attribution/session-recorder.js";
import { ONLINE_ACTIVITY } from "../src/modules/online/online-activity.js";
import { OnlineModule } from "../src/modules/online/online.module.js";
import { OnlineService } from "../src/modules/online/online.service.js";
import { PartnerLinkBinder } from "../src/modules/partners/partner-links.js";
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
  it("собирается из всех модулей, отвечает на /health и держит тревогу 5xx", async () => {
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
      // Хук 5xx в http-app.ts ставится, только если провайдер найден, и молча:
      // без этой проверки тревога пропала бы из приложения без единой строки в логе.
      expect(app.get(ServerErrorAlarm, { strict: false })).toBeInstanceOf(ServerErrorAlarm);
      // Счётчик онлайна один: гард отмечает активность в том же сервисе, что
      // отвечает на пинг. Равные по виду экземпляры не годятся — у каждого свой lastWarnAt.
      const online = app.get(OnlineService, { strict: false });
      expect(online).toBeInstanceOf(OnlineService);
      expect(app.get(ONLINE_ACTIVITY, { strict: false })).toBe(online);
      // Гард панели у маршрута онлайна — тот же сервис сессий, что в AdminModule.
      const adminSessions = app.select(AdminModule).get(AdminSessionService, { strict: false });
      expect(app.select(OnlineModule).get(AdminSessionService, { strict: false })).toBe(adminSessions);
      // Привязка по ссылке партнёра (T-0067): параметр `SessionRecorder` необязателен, и забытый
      // импорт модуля партнёров молча выключил бы её — запись сессий шла бы как раньше. Привязчик
      // у рекордера — тот же экземпляр, что в модуле партнёров.
      const recorder = app.get(SessionRecorder, { strict: false });
      const binder = app.get(PartnerLinkBinder, { strict: false });
      expect(binder).toBeInstanceOf(PartnerLinkBinder);
      expect((recorder as unknown as { partnerLinks: unknown }).partnerLinks).toBe(binder);
    } finally {
      await app.close();
    }
  });
});
