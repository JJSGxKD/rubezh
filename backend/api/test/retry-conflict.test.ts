import { describe, expect, it } from "vitest";
import { Prisma } from "../src/generated/prisma/client.js";
import { retryOnConflict } from "./helpers/retry-conflict.js";

// Помощник уборки интеграционных тестов: повторяет только конфликт с соседним тестом (P2034).

const conflict = () => new Prisma.PrismaClientKnownRequestError("Transaction failed due to a write conflict or a deadlock", { code: "P2034", clientVersion: "test" });

describe("retryOnConflict", () => {
  it("конфликт записи повторяется, пока запрос не пройдёт", async () => {
    let calls = 0;
    const result = await retryOnConflict(async () => {
      calls += 1;
      if (calls < 3) throw conflict();
      return { count: 2 };
    });
    expect(result).toEqual({ count: 2 });
    expect(calls).toBe(3);
  });

  it("другая ошибка Prisma не повторяется", async () => {
    let calls = 0;
    const other = new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", { code: "P2003", clientVersion: "test" });
    await expect(
      retryOnConflict(async () => {
        calls += 1;
        throw other;
      }),
    ).rejects.toBe(other);
    expect(calls).toBe(1);
  });

  it("после последней попытки конфликт пробрасывается", async () => {
    let calls = 0;
    await expect(
      retryOnConflict(async () => {
        calls += 1;
        throw conflict();
      }, 3),
    ).rejects.toMatchObject({ code: "P2034" });
    expect(calls).toBe(3);
  });
});
