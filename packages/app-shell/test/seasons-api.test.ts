import { describe, expect, it } from "vitest";
import type { ApiFailure, ApiRequest, ApiResult } from "../src/state/api-request";
import { claimPending, createSeasonsApi, type SeasonsApi } from "../src/state/seasons-api";

// Клиент недельного сезона (tasks/T-0111): контракт сервера (T-0110) разбирается
// схемой. Сервер старше клиента не знает части полей, выключенный или ещё не
// выпущенный отвечает 404 (`disabled`) — экран тогда остаётся прежним.

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

function server(sent: Sent[], answer: unknown): ApiRequest {
  return async <T,>(path: string, schema: object, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> => {
    sent.push({ method: init?.method ?? "GET", path, body: init?.body });
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

function failing(failure: ApiFailure, code?: string): ApiRequest {
  return async <T,>(): Promise<ApiResult<T>> => ({ ok: false, failure, ...(code === undefined ? {} : { code }) });
}

const FULL = {
  enabled: true,
  startsAt: null,
  season: { key: "2026-11-02", startsAt: "2026-11-02T00:00:00.000Z", endsAt: "2026-11-09T00:00:00.000Z", secondsLeft: 273_600 },
  minBoard: 10,
  thresholds: { easy: 120, normal: 150, hard: 180 },
  thresholdReward: { coins: 100, prestige: 5 },
  placeLadder: [
    { fromPlace: 1, toPlace: 1, coins: 1000, prestige: 100 },
    { fromPlace: 2, toPlace: 3, coins: 600, prestige: 50 },
  ],
  difficultyMul: { easy: 1, normal: 1.3, hard: 1.7 },
  mine: { easy: null, normal: null, hard: 252.4 },
  pending: [{ seasonKey: "2026-10-26", kind: "place", difficulty: "hard", place: 2, coins: 1020, prestige: 85 }],
  history: [
    {
      seasonKey: "2026-10-26",
      startsAt: "2026-10-26T00:00:00.000Z",
      endsAt: "2026-11-02T00:00:00.000Z",
      results: [{ difficulty: "hard", bestSec: 301, place: 2, boardSize: 14 }],
      reward: { coins: 1020, prestige: 85, claimed: false },
    },
  ],
};

const ENTRY = {
  rank: 1,
  name: "Игрок",
  photoUrl: null,
  survivalSec: 301,
  level: 9,
  startingWeaponId: "bolt",
  enemiesKilled: 120,
  isMe: false,
};

describe("клиент сезона: overview", () => {
  it("полный ответ разбирается и запрос идёт GET /api/v1/seasons", async () => {
    const sent: Sent[] = [];
    const response = await createSeasonsApi(server(sent, FULL)).overview();

    expect(sent).toEqual([{ method: "GET", path: "/api/v1/seasons", body: undefined }]);
    expect(response.ok).toBe(true);
    if (!response.ok || !response.data.enabled) throw new Error("ждали включённый сезон");
    expect(response.data.season?.key).toBe("2026-11-02");
    expect(response.data.thresholds["hard"]).toBe(180);
    expect(response.data.placeLadder).toHaveLength(2);
    expect(response.data.pending).toHaveLength(1);
    expect(response.data.history[0]?.results[0]?.place).toBe(2);
    expect(response.data.mine["hard"]).toBe(252.4);
  });

  it("ответ старого сервера без history и pending — пустые списки", async () => {
    const old: Record<string, unknown> = { ...FULL };
    delete old["history"];
    delete old["pending"];
    const response = await createSeasonsApi(server([], old)).overview();

    expect(response.ok).toBe(true);
    if (!response.ok || !response.data.enabled) throw new Error("ждали включённый сезон");
    expect(response.data.history).toEqual([]);
    expect(response.data.pending).toEqual([]);
  });

  it("сезоны выключены на сервере — enabled: false, хоть и с пустыми списками", async () => {
    const off = { enabled: false, startsAt: null, season: null, minBoard: 10, thresholds: {}, thresholdReward: { coins: 0, prestige: 0 }, placeLadder: [], difficultyMul: {}, mine: {}, pending: [], history: [] };
    const response = await createSeasonsApi(server([], off)).overview();

    expect(response).toEqual({ ok: true, data: { enabled: false } });
  });

  it("первый сезон ещё не начался — включено, сезона нет, дата есть", async () => {
    const response = await createSeasonsApi(server([], { ...FULL, season: null, startsAt: "2026-11-02T00:00:00.000Z" })).overview();

    expect(response.ok).toBe(true);
    if (!response.ok || !response.data.enabled) throw new Error("ждали включённый сезон");
    expect(response.data.season).toBeNull();
    expect(response.data.startsAt).toBe("2026-11-02T00:00:00.000Z");
  });

  it("незнакомая сложность в ключах не ломает разбор", async () => {
    const response = await createSeasonsApi(server([], { ...FULL, thresholds: { ...FULL.thresholds, nightmare: 999 } })).overview();

    expect(response.ok).toBe(true);
  });

  it("404 (сервер старше или сезоны закрыты) — enabled: false, а не ошибка", async () => {
    const response = await createSeasonsApi(failing("disabled", "not_found")).overview();

    expect(response).toEqual({ ok: true, data: { enabled: false } });
  });

  it("битый ответ — ошибка схемы, а не падение", async () => {
    const response = await createSeasonsApi(server([], { enabled: true, season: "вчера" })).overview();

    expect(response).toEqual({ ok: false, failure: "unavailable" });
  });

  it("сеть и сервер упали — отказ пробрасывается как есть", async () => {
    expect(await createSeasonsApi(failing("offline")).overview()).toEqual({ ok: false, failure: "offline" });
    expect(await createSeasonsApi(failing("unavailable")).overview()).toEqual({ ok: false, failure: "unavailable" });
  });
});

describe("клиент сезона: board", () => {
  const BOARD = { seasonKey: "2026-11-02", difficulty: "hard", total: 14, entries: [ENTRY], me: { rank: 5, survivalSec: 252.4 } };

  it("таблица друзей: scope=friends и сложность в запросе", async () => {
    const sent: Sent[] = [];
    const response = await createSeasonsApi(server(sent, BOARD)).board("hard", "friends");
    const url = new URL(sent[0]?.path ?? "", "https://x.test");

    expect(sent[0]?.method).toBe("GET");
    expect(url.pathname).toBe("/api/v1/seasons/board");
    expect(url.searchParams.get("scope")).toBe("friends");
    expect(url.searchParams.get("difficulty")).toBe("hard");
    expect(response.ok && response.data.total).toBe(14);
    expect(response.ok && response.data.entries[0]?.name).toBe("Игрок");
  });

  it("значения экранируются", async () => {
    const sent: Sent[] = [];
    await createSeasonsApi(server(sent, BOARD)).board("a&b=c", "all");

    expect(sent[0]?.path).toContain("difficulty=a%26b%3Dc");
    expect(sent[0]?.path).toContain("scope=all");
  });

  it("игрока в таблице нет — me: null; строки без престижа и тестера разбираются", async () => {
    const response = await createSeasonsApi(server([], { ...BOARD, me: null })).board("hard", "all");

    expect(response.ok && response.data.me).toBeNull();
  });

  it("битая запись таблицы — ошибка схемы", async () => {
    const response = await createSeasonsApi(server([], { ...BOARD, entries: [{ rank: "первый" }] })).board("hard", "all");

    expect(response).toEqual({ ok: false, failure: "unavailable" });
  });
});

describe("клиент сезона: claim", () => {
  it("POST без тела, ключ сезона в адресе экранируется", async () => {
    const sent: Sent[] = [];
    const response = await createSeasonsApi(server(sent, { claimed: true, credited: { coins: 1020, prestige: 85 } })).claim("2026-10-26");

    expect(sent).toEqual([{ method: "POST", path: "/api/v1/seasons/2026-10-26/claim", body: undefined }]);
    expect(response).toEqual({ ok: true, data: { claimed: true, credited: { coins: 1020, prestige: 85 } } });
  });

  it("повторный забор — claimed: false без исключения", async () => {
    const response = await createSeasonsApi(server([], { claimed: false, credited: { coins: 0, prestige: 0 } })).claim("2026-10-26");

    expect(response.ok && response.data.claimed).toBe(false);
  });

  it("404 season_reward_not_found приходит отказом с кодом", async () => {
    const response = await createSeasonsApi(failing("disabled", "season_reward_not_found")).claim("2000-01-03");

    expect(response).toEqual({ ok: false, failure: "disabled", code: "season_reward_not_found" });
  });
});

describe("claimPending: забрать все записи подряд", () => {
  const stub = (answers: Record<string, ApiResult<{ claimed: boolean; credited: { coins: number; prestige: number } }>>, calls: string[]): SeasonsApi => ({
    overview: async () => ({ ok: true, data: { enabled: false } }),
    board: async () => ({ ok: false, failure: "unavailable" }),
    claim: async (key) => {
      calls.push(key);
      return answers[key] ?? { ok: false, failure: "unavailable" };
    },
  });
  const entry = (seasonKey: string) => ({ seasonKey, kind: "place" as const, difficulty: "hard", place: 1, coins: 1, prestige: 1 });

  it("идёт по записям подряд и суммирует начисленное", async () => {
    const calls: string[] = [];
    const api = stub(
      {
        a: { ok: true, data: { claimed: true, credited: { coins: 100, prestige: 5 } } },
        b: { ok: true, data: { claimed: true, credited: { coins: 50, prestige: 2 } } },
      },
      calls,
    );

    expect(await claimPending(api, [entry("a"), entry("b")])).toEqual({ credited: { coins: 150, prestige: 7 }, failed: false });
    expect(calls).toEqual(["a", "b"]);
  });

  it("два начисления за один сезон просят забор один раз", async () => {
    const calls: string[] = [];
    const api = stub({ a: { ok: true, data: { claimed: true, credited: { coins: 100, prestige: 5 } } } }, calls);

    await claimPending(api, [entry("a"), { ...entry("a"), kind: "threshold" }]);
    expect(calls).toEqual(["a"]);
  });

  it("claimed: false (уже забрано) в сумму не идёт и сбоем не считается", async () => {
    const api = stub({ a: { ok: true, data: { claimed: false, credited: { coins: 0, prestige: 0 } } } }, []);

    expect(await claimPending(api, [entry("a")])).toEqual({ credited: { coins: 0, prestige: 0 }, failed: false });
  });

  it("отказ посреди списка останавливает забор и помнит уже начисленное", async () => {
    const calls: string[] = [];
    const api = stub({ a: { ok: true, data: { claimed: true, credited: { coins: 100, prestige: 5 } } } }, calls);

    expect(await claimPending(api, [entry("a"), entry("b"), entry("c")])).toEqual({ credited: { coins: 100, prestige: 5 }, failed: true });
    expect(calls).toEqual(["a", "b"]);
  });
});
