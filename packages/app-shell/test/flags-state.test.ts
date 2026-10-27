import { beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod/mini";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { draftArtAllowed, isFlagOn, loadFlags, resetFlags, useFlags } from "../src/state/flags";
import { useSession } from "../src/state/session";

// Флаги клиента (tasks/T-0230): `GET /api/v1/flags` после входа. Ошибка, обрыв
// и битый ответ — все флаги выключены: игра идёт как без флагов.

function answering(flags: Record<string, boolean>): ApiRequest {
  return async <T>(_path: string, schema: z.ZodMiniType<T>) => {
    const parsed = schema.safeParse({ flags });
    return parsed.success ? ({ ok: true, data: parsed.data } satisfies ApiResult<T>) : ({ ok: false, failure: "unavailable" } satisfies ApiResult<T>);
  };
}

function failing(failure: "offline" | "unavailable" | "unauthorized" | "no_identity"): ApiRequest {
  return async () => ({ ok: false, failure });
}

function signIn(tester: boolean): void {
  useSession.setState({
    status: "ready",
    account: { accountId: "a1", displayName: "Игрок", photoUrl: null, createdAt: "2026-01-01T00:00:00Z", created: false, ...(tester ? { tester: true as const } : {}) },
  });
}

describe("флаги клиента", () => {
  beforeEach(() => {
    resetFlags();
    useSession.setState({ status: "idle", account: null });
  });

  it("до загрузки все флаги выключены", () => {
    expect(isFlagOn("art.sprites")).toBe(false);
    expect(draftArtAllowed()).toBe(false);
  });

  it("art.sprites.testers включает арт тестеру", async () => {
    signIn(true);
    await loadFlags(answering({ "art.sprites.testers": true }));
    expect(isFlagOn("art.sprites.testers")).toBe(true);
    expect(draftArtAllowed()).toBe(true);
  });

  it("тот же ответ не тестеру арт не даёт", async () => {
    signIn(false);
    await loadFlags(answering({ "art.sprites.testers": true }));
    expect(draftArtAllowed()).toBe(false);
  });

  it("art.sprites включает арт всем, и тестеру тоже", async () => {
    signIn(false);
    await loadFlags(answering({ "art.sprites": true }));
    expect(draftArtAllowed()).toBe(true);

    signIn(true);
    await loadFlags(answering({ "art.sprites": true }));
    expect(draftArtAllowed()).toBe(true);
  });

  it("выключенные флаги арта не включают", async () => {
    signIn(true);
    await loadFlags(answering({ "art.sprites": false, "art.sprites.testers": false }));
    expect(draftArtAllowed()).toBe(false);
  });

  it("обрыв сети, отказ сервера и нет входа — все флаги выключены, без падения", async () => {
    signIn(true);
    await loadFlags(answering({ "art.sprites": true }));
    expect(draftArtAllowed()).toBe(true);

    for (const failure of ["offline", "unavailable", "unauthorized", "no_identity"] as const) {
      useFlags.setState({ flags: { "art.sprites": true }, tester: true });
      await expect(loadFlags(failing(failure))).resolves.toBeUndefined();
      expect(draftArtAllowed(), failure).toBe(false);
      expect(useFlags.getState().flags).toEqual({});
    }
  });

  it("битый ответ (не булевы значения) не включает ничего", async () => {
    signIn(true);
    const broken: ApiRequest = async <T>(_path: string, schema: z.ZodMiniType<T>) => {
      const parsed = schema.safeParse({ flags: { "art.sprites": "да" } });
      return parsed.success ? ({ ok: true, data: parsed.data } satisfies ApiResult<T>) : ({ ok: false, failure: "unavailable" } satisfies ApiResult<T>);
    };
    await loadFlags(broken);
    expect(draftArtAllowed()).toBe(false);
  });

  it("спрашивает именно GET /api/v1/flags", async () => {
    signIn(false);
    let asked: { path: string; method: string } | null = null;
    const spy: ApiRequest = async <T>(path: string, _schema: z.ZodMiniType<T>, init: { method: "GET" | "POST" | "DELETE" }) => {
      asked = { path, method: init.method };
      return { ok: false, failure: "offline" } satisfies ApiResult<T>;
    };
    await loadFlags(spy);
    expect(asked).toEqual({ path: "/api/v1/flags", method: "GET" });
  });
});
