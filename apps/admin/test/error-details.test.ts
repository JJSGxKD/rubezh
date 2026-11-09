import { describe, expect, it } from "vitest";
import { errorCopyText, errorDetails, type ApiError } from "../src/api/client";

// Строка подробностей ошибки панели (docs/35-stage4-plan.md, Р193):
// «код · статус · №номер» — по номеру запись находится в логе API.

const FULL_ID = "3f2a1b4c-0d5e-4f6a-8b7c-9d0e1f2a3b4c";

function error(patch: Partial<ApiError> = {}): ApiError {
  return { kind: "unavailable", status: 500, code: "internal_error", message: "Внутренняя ошибка сервера", requestId: FULL_ID, reason: null, ...patch };
}

describe("строка подробностей ошибки", () => {
  it("собирает код, статус и первые 8 знаков номера", () => {
    expect(errorDetails(error())).toBe("internal_error · 500 · №3f2a1b4c");
  });

  it("без номера — только код и статус", () => {
    expect(errorDetails(error({ requestId: null, code: "bad_request", status: 400 }))).toBe("bad_request · 400");
  });

  it("берёт только те части, что есть", () => {
    expect(errorDetails(error({ code: null }))).toBe("500 · №3f2a1b4c");
    expect(errorDetails(error({ code: null, status: null }))).toBe("№3f2a1b4c");
  });

  it("нет связи и ничего больше — строки нет", () => {
    expect(errorDetails(error({ kind: "offline", status: null, code: null, requestId: null }))).toBeNull();
  });
});

describe("текст для копирования", () => {
  it("содержит полный номер, текст, причину, код, статус и время по UTC", () => {
    const text = errorCopyText(error({ reason: "db is down" }), Date.UTC(2026, 10, 9, 12, 30, 0));

    expect(text).toContain(FULL_ID);
    expect(text).toContain("Внутренняя ошибка сервера");
    expect(text).toContain("db is down");
    expect(text).toContain("internal_error");
    expect(text).toContain("500");
    expect(text).toContain("2026-11-09T12:30:00.000Z");
  });

  it("без причины и номера не печатает пустых строк с подписями", () => {
    const text = errorCopyText(error({ reason: null, requestId: null }), 0);

    expect(text).not.toMatch(/Причина/);
    expect(text).not.toMatch(/№/);
  });
});
