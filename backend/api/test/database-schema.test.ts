import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { DatabaseSchemaCheck, describeDbError } from "../src/infra/database.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";

// Непринятые миграции — самая частая причина «ничего не пишется»: Prisma
// говорит «таблицы нет», но не говорит, что делать.

function config(patch: Record<string, string> = {}) {
  return loadAppConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://unused", EVENTS_INGEST_ENABLED: "true", ...patch });
}

function prismaWith(tables: string[]): PrismaClient {
  return { $queryRaw: async () => tables.map((table) => ({ table_name: table })) } as unknown as PrismaClient;
}

describe("проверка схемы на старте", () => {
  it("называет недостающие таблицы и что сделать", async () => {
    const errors: string[] = [];
    const check = new DatabaseSchemaCheck(config(), prismaWith(["analytics_event"]));
    vi.spyOn(Reflect.get(check, "logger") as { error: (line: string) => void }, "error").mockImplementation((line: string) => void errors.push(line));

    await check.onApplicationBootstrap();

    expect(errors).toHaveLength(1);
    expect(JSON.parse(errors[0] ?? "{}")).toMatchObject({
      event: "schema_incomplete",
      missing: ["diagnostic_report", "data_export"],
      hint: expect.stringContaining("prisma:deploy"),
    });
  });

  it("молчит, когда всё на месте, и не роняет старт без базы", async () => {
    const check = new DatabaseSchemaCheck(config(), prismaWith(["analytics_event", "diagnostic_report", "data_export"]));
    const errors = vi.spyOn(Reflect.get(check, "logger") as { error: (line: string) => void }, "error").mockImplementation(() => undefined);
    await check.onApplicationBootstrap();
    expect(errors).not.toHaveBeenCalled();

    const broken = new DatabaseSchemaCheck(config(), { $queryRaw: async () => Promise.reject(new Error("connect ECONNREFUSED")) } as unknown as PrismaClient);
    vi.spyOn(Reflect.get(broken, "logger") as { warn: (line: string) => void }, "warn").mockImplementation(() => undefined);
    await expect(broken.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it("к «таблицы нет» добавляет подсказку, к остальным ошибкам — нет", () => {
    expect(describeDbError(new Error("The table public.analytics_event does not exist in the current database."))).toContain("prisma:deploy");
    expect(describeDbError(new Error("connect ECONNREFUSED"))).toBe("connect ECONNREFUSED");
    expect(describeDbError("что-то не то")).toBe("unknown");
  });
});
