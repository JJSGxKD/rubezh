import { beforeEach, describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { resetConnectionForTests, useConnection } from "../src/state/connection";
import { createFeedApi, FEED_NAME_MAX, forgetFeedForTests, refreshFeed, useFeed, type FeedApi, type FeedData } from "../src/state/feed-api";
import { useShell } from "../src/state/shell";

// Лента на главной (Р114, tasks/T-0176): ответ `GET /api/v1/feed` разбирается
// по одному событию, лишнее отбрасывается, а любая неудача оставляет прежнюю
// ленту. Лента — украшение: ошибки наружу она не бросает.

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const AT = new Date(NOW - 60_000).toISOString();

function server(answer: unknown): ApiRequest {
  return async <T,>(_path: string, schema: object): Promise<ApiResult<T>> => {
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

function event(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, kind: "boss", name: "Ян", at: AT, seconds: null, ...overrides };
}

async function load(answer: unknown): Promise<FeedData> {
  const result = await createFeedApi(server(answer)).feed();
  if (!result.ok) throw new Error("ответ не разобрался");
  return result.data;
}

describe("разбор ответа ленты", () => {
  it("три события и одно незнакомого вида — три события", async () => {
    const data = await load({
      events: [event("a"), event("b", { kind: "long_run", seconds: 700 }), event("x", { kind: "comet" }), event("c", { kind: "chest" })],
      refreshSec: 300,
    });
    expect(data.items.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(data.items[1]).toEqual({ id: "b", kind: "long_run", name: "Ян", atMs: NOW - 60_000, seconds: 700 });
  });

  it("битая дата или пустое имя — событие отброшено, остальные целы", async () => {
    const data = await load({
      events: [event("a", { at: "вчера" }), event("b", { name: "" }), event("c", { name: "   " }), event("d")],
      refreshSec: 300,
    });
    expect(data.items.map((entry) => entry.id)).toEqual(["d"]);
  });

  it("забег и рекорд без секунд показать нечем — отброшены, босс и сундук без секунд остаются", async () => {
    const data = await load({
      events: [event("a", { kind: "long_run" }), event("b", { kind: "week_record" }), event("c", { kind: "boss" }), event("d", { kind: "chest" })],
      refreshSec: 300,
    });
    expect(data.items.map((entry) => entry.id)).toEqual(["c", "d"]);
  });

  it("событие неверной формы не роняет соседей", async () => {
    const data = await load({ events: [event("a"), { id: 7 }, "мусор", null, event("b")], refreshSec: 300 });
    expect(data.items.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("refreshSec держится в 60…3600", async () => {
    expect((await load({ events: [], refreshSec: 5 })).refreshSec).toBe(60);
    expect((await load({ events: [], refreshSec: 999_999 })).refreshSec).toBe(3_600);
    expect((await load({ events: [], refreshSec: 300 })).refreshSec).toBe(300);
  });

  it("имя длиннее 64 знаков обрезается", async () => {
    const data = await load({ events: [event("a", { name: "я".repeat(70) })], refreshSec: 300 });
    expect(FEED_NAME_MAX).toBe(64);
    expect(data.items[0]?.name).toBe("я".repeat(64));
  });

  it("ответ неверной формы — неудача, а не исключение", async () => {
    await expect(createFeedApi(server({ events: "нет", refreshSec: 300 })).feed()).resolves.toEqual({ ok: false, failure: "unavailable" });
    await expect(createFeedApi(server({ refreshSec: 300 })).feed()).resolves.toEqual({ ok: false, failure: "unavailable" });
  });
});

describe("обновление ленты", () => {
  const DATA: FeedData = { items: [{ id: "a", kind: "boss", name: "Ян", atMs: NOW - 1_000, seconds: null }], refreshSec: 300 };

  function counting(results: ApiResult<FeedData>[] = []): FeedApi & { asked: number } {
    const api = {
      asked: 0,
      async feed(): Promise<ApiResult<FeedData>> {
        api.asked += 1;
        return results.shift() ?? { ok: true, data: DATA };
      },
    };
    return api;
  }

  function withAccount(on: boolean): void {
    useShell.setState({
      capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false, ...(on ? { auth: { baseUrl: "" } } : {}) },
    } as never);
  }

  beforeEach(() => {
    forgetFeedForTests();
    resetConnectionForTests();
    withAccount(true);
  });

  it("ответ ложится в стор вместе со временем запроса и частотой", async () => {
    await refreshFeed(NOW, counting());
    expect(useFeed.getState()).toMatchObject({ items: DATA.items, refreshSec: 300, askedAt: NOW });
  });

  it("ошибка при непустой ленте — лента прежняя", async () => {
    await refreshFeed(NOW, counting());
    await refreshFeed(NOW + 1_000, counting([{ ok: false, failure: "offline" }]));
    expect(useFeed.getState()).toMatchObject({ items: DATA.items, askedAt: NOW });
  });

  it("два вызова подряд — один запрос", async () => {
    const api = counting();
    await Promise.all([refreshFeed(NOW, api), refreshFeed(NOW, api)]);
    expect(api.asked).toBe(1);
  });

  it("без входа запроса нет", async () => {
    withAccount(false);
    const api = counting();
    await refreshFeed(NOW, api);
    expect(api.asked).toBe(0);
    expect(useFeed.getState().items).toEqual([]);
  });

  it("офлайн запроса нет", async () => {
    useConnection.setState({ status: "offline", since: NOW });
    const api = counting();
    await refreshFeed(NOW, api);
    expect(api.asked).toBe(0);
  });

  it("запрос, который бросил исключение, наружу не выходит", async () => {
    const api: FeedApi = {
      async feed() {
        throw new Error("сеть");
      },
    };
    await expect(refreshFeed(NOW, api)).resolves.toBeUndefined();
    expect(useFeed.getState().items).toEqual([]);
  });
});
