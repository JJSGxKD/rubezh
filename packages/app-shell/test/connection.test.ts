import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../src/state/api-request";
import {
  CONNECTION_FAILURE_WINDOW_MS,
  INITIAL_CONNECTION,
  nextConnection,
  reportReachability,
  resetConnectionForTests,
  useConnection,
  type ConnectionState,
} from "../src/state/connection";
import { initShell, useShell } from "../src/state/shell";
import { z } from "zod/mini";

// Общая плашка «Нет связи с сервером» (tasks/T-0015): статус связи выводится
// из исхода запросов, а не из экранов. Один сбой — ещё не потеря связи,
// ответ сервера с ошибкой — связь есть.

const sessionStub = vi.hoisted(() => ({ fetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response | null>>() }));

vi.mock("../src/state/session", () => ({
  authorizedFetch: sessionStub.fetch,
  useSession: { getState: () => ({ failure: "no_identity" }) },
}));

const T0 = 1_000_000;

function after(state: ConnectionState, ...signals: Parameters<typeof nextConnection>[1][]): ConnectionState {
  return signals.reduce(nextConnection, state);
}

describe("переходы статуса связи", () => {
  it("один сбой — ещё связь есть", () => {
    expect(after(INITIAL_CONNECTION, { kind: "fail", at: T0 }).status).toBe("online");
  });

  it("два сбоя за десять секунд — нет связи", () => {
    const state = after(INITIAL_CONNECTION, { kind: "fail", at: T0 }, { kind: "fail", at: T0 + 10_000 });
    expect(state).toMatchObject({ status: "offline", since: T0 + 10_000 });
  });

  it("два сбоя с разницей сорок секунд — связь есть: окно началось заново", () => {
    const state = after(INITIAL_CONNECTION, { kind: "fail", at: T0 }, { kind: "fail", at: T0 + 40_000 });
    expect(state.status).toBe("online");
    // Новое окно отсчитывается от второго сбоя: третий за 5 секунд уже потеря.
    expect(after(state, { kind: "fail", at: T0 + 45_000 }).status).toBe("offline");
  });

  it("граница окна включена", () => {
    const state = after(INITIAL_CONNECTION, { kind: "fail", at: T0 }, { kind: "fail", at: T0 + CONNECTION_FAILURE_WINDOW_MS });
    expect(state.status).toBe("offline");
  });

  it("событие браузера offline — сразу нет связи", () => {
    expect(after(INITIAL_CONNECTION, { kind: "browser_offline", at: T0 })).toMatchObject({ status: "offline", since: T0 });
  });

  it("ответ сервера возвращает связь и сбрасывает счётчик сбоев", () => {
    const offline = after(INITIAL_CONNECTION, { kind: "browser_offline", at: T0 });
    const back = nextConnection({ ...offline, checking: true }, { kind: "reachable", at: T0 + 5_000 });
    expect(back).toEqual(INITIAL_CONNECTION);
    // Сбой после возвращения считается с нуля.
    expect(after(back, { kind: "fail", at: T0 + 6_000 }).status).toBe("online");
  });

  it("между сбоями ответ сервера сбрасывает счётчик", () => {
    const state = after(INITIAL_CONNECTION, { kind: "fail", at: T0 }, { kind: "reachable", at: T0 + 1_000 }, { kind: "fail", at: T0 + 2_000 });
    expect(state.status).toBe("online");
  });

  it("событие браузера online статус сам не меняет", () => {
    const offline = after(INITIAL_CONNECTION, { kind: "browser_offline", at: T0 });
    expect(nextConnection(offline, { kind: "browser_online", at: T0 + 1_000 })).toEqual(offline);
    expect(nextConnection(INITIAL_CONNECTION, { kind: "browser_online", at: T0 })).toEqual(INITIAL_CONNECTION);
  });

  it("сбои в офлайне время потери не двигают", () => {
    const offline = after(INITIAL_CONNECTION, { kind: "browser_offline", at: T0 });
    expect(nextConnection(offline, { kind: "fail", at: T0 + 5_000 }).since).toBe(T0);
    expect(nextConnection(offline, { kind: "browser_offline", at: T0 + 5_000 }).since).toBe(T0);
  });
});

describe("события связи", () => {
  let events: { event: string; payload: unknown }[];

  beforeEach(() => {
    resetConnectionForTests();
    events = [];
    initShell({ ...useShell.getState(), analytics: (event, payload) => events.push({ event, payload }) });
  });

  afterEach(resetConnectionForTests);

  it("потеря — одно connection_lost, возвращение через 90 с — connection_restored с downtimeSec", () => {
    reportReachability("fail", T0);
    expect(events).toEqual([]);
    reportReachability("fail", T0 + 1_000);
    expect(events).toEqual([{ event: "connection_lost", payload: {} }]);

    // Повторные сбои в офлайне событий не шлют.
    reportReachability("fail", T0 + 2_000);
    reportReachability("fail", T0 + 3_000);
    expect(events).toHaveLength(1);

    reportReachability("reachable", T0 + 91_000);
    expect(events[1]).toEqual({ event: "connection_restored", payload: { downtimeSec: 90 } });
    expect(useConnection.getState().status).toBe("online");

    // Ответ при живой связи — не событие.
    reportReachability("reachable", T0 + 92_000);
    expect(events).toHaveLength(2);
  });
});

describe("исход запроса игрока", () => {
  const schema = z.object({ n: z.number() });
  const get = () => apiRequest("/api/v1/x", schema, { method: "GET" });
  const answer = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

  beforeEach(() => {
    resetConnectionForTests();
    sessionStub.fetch.mockReset();
  });

  afterEach(resetConnectionForTests);

  /** Сбой запоминается счётчиком, любой ответ сервера его сбрасывает. */
  async function failures(respond: () => Promise<Response | null>): Promise<number> {
    sessionStub.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await get();
    expect(useConnection.getState().failures).toBe(1);
    sessionStub.fetch.mockImplementationOnce(respond);
    await get();
    return useConnection.getState().failures;
  }

  it("обрыв сети — сбой", async () => {
    sessionStub.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await get()).toEqual({ ok: false, failure: "offline" });
    expect(useConnection.getState().failures).toBe(1);
  });

  it.each([502, 503, 504])("ответ шлюза %i — сбой", async (status) => {
    sessionStub.fetch.mockResolvedValueOnce(answer(status));
    await get();
    expect(useConnection.getState().failures).toBe(1);
  });

  it("два ответа шлюза подряд — нет связи", async () => {
    sessionStub.fetch.mockResolvedValue(answer(503));
    await get();
    await get();
    expect(useConnection.getState().status).toBe("offline");
  });

  it.each([404, 400, 401, 403, 429, 500])("ответ %i — связь есть", async (status) => {
    expect(await failures(async () => answer(status))).toBe(0);
  });

  it("успешный ответ — связь есть", async () => {
    expect(await failures(async () => answer(200, { data: { n: 1 } }))).toBe(0);
  });

  it("нет сессии — запрос не уходил, связь не судится", async () => {
    sessionStub.fetch.mockResolvedValueOnce(null);
    await get();
    expect(useConnection.getState()).toMatchObject({ status: "online", failures: 0 });
  });
});
