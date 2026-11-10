import { HttpException, HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { DomainErrorFilter, errorBodyFor, type ErrorContext } from "../src/common/domain-error.filter.js";
import { ForbiddenError, RateLimitedError, ValidationError } from "../src/common/domain-error.js";

// Форма ответа — это контракт, на который завязывается клиент
// (docs/15-engineering-standards.md §3). Он ветвится по коду, а не по тексту,
// поэтому коды проверяются явно.

function capture(exception: unknown): { status: number; body: unknown } {
  let captured: { status: number; body: unknown } = { status: 0, body: null };

  const response = {
    status: (status: number) => ({
      send: (body: unknown) => {
        captured = { status, body };
      },
    }),
  };
  const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({}) }) };

  new DomainErrorFilter().catch(exception, host as never);
  return captured;
}

describe("форма ответа при ошибке", () => {
  it("отдаёт код и текст доменной ошибки", () => {
    const { status, body } = capture(new ValidationError("Некорректный отчёт: reportId"));

    expect(status).toBe(400);
    expect(body).toEqual({
      error: { code: "validation_failed", message: "Некорректный отчёт: reportId" },
    });
  });

  it("сохраняет код ограничения частоты", () => {
    const { status, body } = capture(new RateLimitedError("Слишком много запросов"));

    expect(status).toBe(429);
    expect(body).toMatchObject({ error: { code: "rate_limited" } });
  });

  it("отвечает 413 на слишком большое тело, а не 500", () => {
    // Так ошибку отдаёт разбор тела Fastify: она приходит до маршрутизации
    // и до доменного слоя не доходит.
    const { status, body } = capture({ code: "FST_ERR_CTP_BODY_TOO_LARGE", statusCode: 413 });

    expect(status).toBe(413);
    expect(body).toMatchObject({ error: { code: "payload_too_large" } });
  });

  it("отвечает 400 на битый JSON", () => {
    const { status, body } = capture(Object.assign(new SyntaxError("Unexpected token"), { statusCode: 400 }));

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: "bad_request" } });
  });

  it("не раскрывает внутренние подробности разбора тела", () => {
    const exception = new HttpException(
      "Unexpected token } in JSON at position 42",
      HttpStatus.BAD_REQUEST,
    );

    expect(JSON.stringify(capture(exception).body)).not.toMatch(/position 42/);
  });

  it("не выдаёт серверную ошибку с кодом за ошибку клиента", () => {
    expect(capture({ statusCode: 503, message: "redis down" }).status).toBe(500);
  });

  it("прячет неопознанную ошибку за общим кодом", () => {
    const { status, body } = capture(new Error("подключение к базе отвалилось"));

    expect(status).toBe(500);
    expect(body).toEqual({
      error: { code: "internal_error", message: "Внутренняя ошибка сервера" },
    });
    expect(JSON.stringify(body)).not.toMatch(/база/i);
  });
});

// Номер запроса и причина (docs/35-stage4-plan.md, Р193): номер получают все,
// причину — только аккаунт с `diagnostics.view` на админском маршруте.

const ADMIN_PATH = "/api/v1/admin/proxies";
const REQUEST_ID = "3f2a1b4c-0d5e-4f6a-8b7c-9d0e1f2a3b4c";

function context(patch: Partial<ErrorContext> = {}): ErrorContext {
  return { requestId: REQUEST_ID, path: ADMIN_PATH, permissions: new Set(["diagnostics.view"]), ...patch };
}

describe("номер запроса и причина ошибки", () => {
  it("кладёт номер запроса в тело ошибки домена и не добавляет причину", () => {
    const { body } = errorBodyFor(new ForbiddenError("Недостаточно прав"), context());

    expect(body).toEqual({ error: { code: "forbidden", message: "Недостаточно прав", requestId: REQUEST_ID } });
  });

  it("отдаёт причину необработанной ошибки без стека на админском пути с правом", () => {
    const { status, body } = errorBodyFor(new Error("db is down\n    at query (db.ts:1:1)"), context());

    expect(status).toBe(500);
    expect(body).toEqual({
      error: { code: "internal_error", message: "Внутренняя ошибка сервера", requestId: REQUEST_ID, reason: "db is down" },
    });
    expect(JSON.stringify(body)).not.toMatch(/db\.ts/);
  });

  it("не отдаёт причину на игровом пути", () => {
    const { body } = errorBodyFor(new Error("db is down"), context({ path: "/api/v1/runs" }));

    expect(body).toEqual({ error: { code: "internal_error", message: "Внутренняя ошибка сервера", requestId: REQUEST_ID } });
  });

  it("не принимает путь, который лишь содержит админский префикс", () => {
    const { body } = errorBodyFor(new Error("секрет"), context({ path: "/api/v1/runs?next=/api/v1/admin/x" }));

    expect(body).not.toHaveProperty("error.reason");
  });

  it("не отдаёт причину без права diagnostics.view", () => {
    const { body } = errorBodyFor(new Error("db is down"), context({ permissions: new Set(["players.view"]) }));

    expect(body).not.toHaveProperty("error.reason");
    expect(body).toHaveProperty("error.requestId", REQUEST_ID);
  });

  it("не отдаёт причину, когда права в запросе неизвестны", () => {
    const { body } = errorBodyFor(new Error("db is down"), context({ permissions: null }));

    expect(body).not.toHaveProperty("error.reason");
  });

  it("обрезает причину до 300 знаков", () => {
    const { body } = errorBodyFor(new Error("x".repeat(500)), context());

    expect((body as { error: { reason: string } }).error.reason).toBe("x".repeat(300));
  });

  it("отдаёт причину ошибки HttpException при прежнем общем тексте", () => {
    const { status, body } = errorBodyFor(new HttpException("Unexpected token } in JSON", HttpStatus.BAD_REQUEST), context());

    expect(status).toBe(400);
    expect(body).toEqual({
      error: { code: "bad_request", message: "Некорректный запрос", requestId: REQUEST_ID, reason: "Unexpected token } in JSON" },
    });
  });

  it("отдаёт причину ошибки разбора тела Fastify", () => {
    const { status, body } = errorBodyFor(Object.assign(new Error("Request body is too large"), { statusCode: 413 }), context());

    expect(status).toBe(413);
    expect(body).toMatchObject({ error: { code: "payload_too_large", message: "Тело запроса слишком большое", reason: "Request body is too large" } });
  });

  it("без номера запроса поля requestId в теле нет", () => {
    const { body } = errorBodyFor(new Error("db is down"), context({ requestId: null }));

    expect(body).not.toHaveProperty("error.requestId");
  });

  it("собирает контекст из запроса: номер, путь и права", () => {
    let sent: unknown = null;
    const request = { id: REQUEST_ID, url: ADMIN_PATH, adminPermissions: new Set(["diagnostics.view"]) };
    const response = { status: () => ({ send: (body: unknown) => (sent = body) }) };
    const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }) };

    new DomainErrorFilter().catch(new Error("db is down"), host as never);

    expect(sent).toMatchObject({ error: { requestId: REQUEST_ID, reason: "db is down" } });
  });
});
