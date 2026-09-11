import { HttpException, HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { DomainErrorFilter } from "../src/common/domain-error.filter";
import { RateLimitedError, ValidationError } from "../src/common/domain-error";

// Форма ответа — это контракт, на который завязывается клиент
// (docs/15-engineering-standards.md §3). Он ветвится по коду, а не по тексту,
// поэтому коды проверяются явно.

function capture(exception: unknown): { status: number; body: unknown } {
  let captured: { status: number; body: unknown } = { status: 0, body: null };

  const response = {
    status: (status: number) => ({
      json: (body: unknown) => {
        captured = { status, body };
      },
    }),
  };
  const host = { switchToHttp: () => ({ getResponse: () => response }) };

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
    // Так ошибку отдаёт body-parser: она приходит из middleware и до
    // доменного слоя не доходит.
    const { status, body } = capture({ type: "entity.too.large", status: 413 });

    expect(status).toBe(413);
    expect(body).toMatchObject({ error: { code: "payload_too_large" } });
  });

  it("отвечает 400 на битый JSON", () => {
    const { status, body } = capture({ type: "entity.parse.failed", status: 400 });

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

  it("прячет неопознанную ошибку за общим кодом", () => {
    const { status, body } = capture(new Error("подключение к базе отвалилось"));

    expect(status).toBe(500);
    expect(body).toEqual({
      error: { code: "internal_error", message: "Внутренняя ошибка сервера" },
    });
    expect(JSON.stringify(body)).not.toMatch(/база/i);
  });
});
