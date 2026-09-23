import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Controller, Get, Header, Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { UnauthorizedError } from "../src/common/domain-error.js";
import { API_SECURITY_HEADERS } from "../src/common/security-headers.js";
import { createHttpApp } from "../src/http-app.js";

/**
 * Заголовки безопасности на настоящем Fastify (docs/34-stage3-plan.md, WP3).
 *
 * Главное здесь — ошибки: ответ 401 несёт то же, что успешный. Иначе отказ
 * во входе можно было бы встроить в чужую страницу, а ответ с ошибкой —
 * закешировать прокси.
 */

@Controller("probe")
class ProbeController {
  @Get("ok")
  ok(): { data: string } {
    return { data: "ok" };
  }

  @Get("denied")
  denied(): never {
    throw new UnauthorizedError("нет");
  }

  @Get("cached")
  @Header("cache-control", "public, max-age=60")
  cached(): { data: string } {
    return { data: "можно кешировать" };
  }
}

@Module({
  controllers: [ProbeController],
  providers: [{ provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test" }) }],
})
class ProbeModule {}

describe("заголовки безопасности API", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createHttpApp(ProbeModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("ставит весь набор на успешный ответ", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/probe/ok" });

    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
      expect(response.headers[name], name).toBe(value);
    }
  });

  it("и на ошибку тоже: отказ во входе не встраивается и не кешируется", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/probe/denied" });

    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });

  it("и на неизвестный маршрут", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/нет-такого" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("не перебивает заголовок, выставленный маршрутом сам", async () => {
    // Общая защита не должна молча отменять решение, принятое в конкретном
    // месте: иначе однажды кеш картинки шеринга окажется «no-store».
    const response = await app.inject({ method: "GET", url: "/api/v1/probe/cached" });

    expect(response.headers["cache-control"]).toBe("public, max-age=60");
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });

  it("не выдаёт, на чём написан сервер", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/probe/ok" });

    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(response.headers.server).toBeUndefined();
  });
});
