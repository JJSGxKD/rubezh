import { describe, expect, it } from "vitest";
import type { AdWatchResult } from "../src/state/ad-watch";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import {
  RUN_ALREADY_DOUBLED,
  RUN_DOUBLE_COOLDOWN,
  RUN_DOUBLE_UNAVAILABLE,
  createRunDoubleApi,
  doubleButton,
  doubleForAd,
  type RunDoubleApi,
  type RunDoubleView,
} from "../src/state/run-double-api";

/**
 * Удвоение монет за забег за рекламу (docs/35-stage4-plan.md WP12): кнопка
 * экрана итогов — пока открыто окно и есть реклама для площадки, по
 * досмотренной сессии — одно удвоение; устаревший экран перечитывается.
 */

const NOW = Date.UTC(2026, 9, 2, 12);
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function available(patch: { readyAt?: string | null; pass?: string | null; adAvailable?: boolean; until?: string; coins?: number } = {}): RunDoubleView {
  return {
    status: "available",
    coins: patch.coins ?? 120,
    until: patch.until ?? iso(45),
    ad: { available: patch.adAvailable ?? true, readyAt: patch.readyAt ?? null, pass: patch.pass ?? null },
  };
}

describe("кнопка удвоения", () => {
  it("ролик — где площадка его покажет, VIP — везде; кулдаун — отсчётом", () => {
    expect(doubleButton(available(), NOW, true)).toEqual({ kind: "ready", coins: 120, pass: false });
    expect(doubleButton(available(), NOW, false)).toEqual({ kind: "hidden" });
    expect(doubleButton(available({ pass: "vip" }), NOW, false)).toEqual({ kind: "ready", coins: 120, pass: true });
    expect(doubleButton(available({ readyAt: iso(5) }), NOW, true)).toEqual({ kind: "wait", coins: 120, untilMs: NOW + 5 * 60_000, pass: false });
    expect(doubleButton(available({ readyAt: iso(5) }), NOW + 5 * 60_000, true)).toMatchObject({ kind: "ready" });
  });

  it("удваивать нечего, окно прошло, кулдаун переживёт окно или рекламы нет — кнопки нет", () => {
    expect(doubleButton(available({ coins: 0 }), NOW, true)).toEqual({ kind: "hidden" });
    expect(doubleButton(available({ until: iso(0) }), NOW, true)).toEqual({ kind: "hidden" });
    expect(doubleButton(available({ readyAt: iso(50), until: iso(45) }), NOW, true)).toEqual({ kind: "hidden" });
    expect(doubleButton(available({ adAvailable: false }), NOW, true)).toEqual({ kind: "hidden" });
    expect(doubleButton({ status: "unavailable", reason: "pending" }, NOW, true)).toEqual({ kind: "hidden" });
    expect(doubleButton({ status: "doubled", coins: 120 }, NOW, true)).toEqual({ kind: "doubled", coins: 120 });
  });
});

describe("удвоение за рекламу", () => {
  function fakeApi(answer: ApiResult<{ credited: number; coins: number }>): Pick<RunDoubleApi, "double"> & { calls: [string, string][] } {
    const calls: [string, string][] = [];
    return { calls, double: async (runId, sessionId) => (calls.push([runId, sessionId]), answer) };
  }
  const watched = (result: AdWatchResult) => async () => result;

  it("досмотр или VIP — сессия в удвоение забега, награда отмечается источником", async () => {
    const api = fakeApi({ ok: true, data: { credited: 120, coins: 120 } });
    const rewarded: string[] = [];
    expect(await doubleForAd("run-1", watched({ kind: "watched", sessionId: "AAAAAAAAAAAAAAAA", source: "pass" }), api, (via) => rewarded.push(via))).toEqual({
      kind: "doubled",
      result: { credited: 120, coins: 120 },
    });
    expect(api.calls).toEqual([["run-1", "AAAAAAAAAAAAAAAA"]]);
    expect(rewarded).toEqual(["pass"]);
  });

  it("без досмотра — без удвоения; кулдаун места — экран устарел", async () => {
    const api = fakeApi({ ok: true, data: { credited: 1, coins: 1 } });
    const never = () => expect.unreachable("награды без удвоения не бывает");
    expect(await doubleForAd("run-1", watched({ kind: "closed" }), api, never)).toEqual({ kind: "closed" });
    expect(await doubleForAd("run-1", watched({ kind: "no_ads" }), api, never)).toEqual({ kind: "no_ads" });
    expect(await doubleForAd("run-1", watched({ kind: "failed" }), api, never)).toEqual({ kind: "failed" });
    expect(await doubleForAd("run-1", watched({ kind: "cooldown", retryAt: iso(3) }), api, never)).toEqual({ kind: "stale", code: RUN_DOUBLE_COOLDOWN });
    expect(api.calls).toHaveLength(0);
  });

  it("сервер не удвоил: уже удвоено, окно прошло, кулдаун — экран перечитывается; прочее — «попробуйте ещё раз»", async () => {
    const session = watched({ kind: "watched", sessionId: "AAAAAAAAAAAAAAAA", source: "ad" });
    for (const code of [RUN_ALREADY_DOUBLED, RUN_DOUBLE_UNAVAILABLE, RUN_DOUBLE_COOLDOWN]) {
      expect(await doubleForAd("run-1", session, fakeApi({ ok: false, failure: "rejected", code }), () => undefined)).toEqual({ kind: "stale", code });
    }
    expect(await doubleForAd("run-1", session, fakeApi({ ok: false, failure: "offline" }), () => undefined)).toEqual({ kind: "failed" });
  });

  it("запросы: вид — GET, удвоение — POST с сессией; ответ не по схеме — отказ", async () => {
    const sent: { method: string; path: string; body: unknown }[] = [];
    const server = (answer: unknown): ApiRequest =>
      async <T,>(path: string, schema: object, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> => {
        sent.push({ method: init?.method ?? "GET", path, body: init?.body });
        const { z } = await import("zod/mini");
        const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
        return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
      };
    const view = await createRunDoubleApi(server(available())).view("run/1");
    expect(view.ok && view.data.status).toBe("available");
    await createRunDoubleApi(server({ credited: 120, coins: 120 })).double("run-1", "AAAAAAAAAAAAAAAA");
    expect(sent).toEqual([
      { method: "GET", path: "/api/v1/progress/runs/run%2F1/double", body: undefined },
      { method: "POST", path: "/api/v1/progress/runs/run-1/double", body: { sessionId: "AAAAAAAAAAAAAAAA" } },
    ]);
    expect((await createRunDoubleApi(server({ status: "available", coins: 1 })).view("run-1")).ok).toBe(false);
  });
});
