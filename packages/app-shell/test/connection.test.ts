import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../src/state/api-request";
import {
  CONNECTION_FAILURE_WINDOW_MS,
  CONNECTION_PROBE_PERIOD_MS,
  INITIAL_CONNECTION,
  PROBER_LOAD_TIMEOUT_MS,
  nextConnection,
  reportBrowserOffline,
  reportReachability,
  resetConnectionForTests,
  retryConnection,
  setProberForTests,
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
    const back = nextConnection({ ...offline, checking: true }, { kind: "reachable", at: T0 + 5_000, sentAt: T0 + 4_000 });
    expect(back).toEqual(INITIAL_CONNECTION);
    // Сбой после возвращения считается с нуля.
    expect(after(back, { kind: "fail", at: T0 + 6_000 }).status).toBe("online");
  });

  it("между сбоями ответ сервера сбрасывает счётчик", () => {
    const state = after(INITIAL_CONNECTION, { kind: "fail", at: T0 }, { kind: "reachable", at: T0 + 1_000, sentAt: T0 + 500 }, { kind: "fail", at: T0 + 2_000 });
    expect(state.status).toBe("online");
  });

  it("запрос ушёл до обрыва: ответ с sentAt не позже события offline связь не возвращает", () => {
    const offline = after(INITIAL_CONNECTION, { kind: "browser_offline", at: T0 });
    // Раньше события и равный ему — запрос ушёл до обрыва, ответ опоздал.
    expect(nextConnection(offline, { kind: "reachable", at: T0 + 100, sentAt: T0 - 500 })).toEqual(offline);
    expect(nextConnection(offline, { kind: "reachable", at: T0 + 100, sentAt: T0 })).toEqual(offline);
    // Позже события — запрос ушёл уже в обрыв и дошёл: связь есть.
    expect(nextConnection(offline, { kind: "reachable", at: T0 + 100, sentAt: T0 + 1 }).status).toBe("online");
  });

  it("опоздавший ответ не гасит плашку и тогда, когда связи уже нет по двум сбоям", () => {
    const state = after(INITIAL_CONNECTION, { kind: "fail", at: T0 }, { kind: "browser_offline", at: T0 + 1_000 }, { kind: "fail", at: T0 + 2_000 });
    expect(state.status).toBe("offline");
    expect(nextConnection(state, { kind: "reachable", at: T0 + 3_000, sentAt: T0 + 500 })).toEqual(state);
  });

  it("событие offline в уже оффлайне время обновляет: поздний ответ всё равно опоздал", () => {
    const first = after(INITIAL_CONNECTION, { kind: "browser_offline", at: T0 });
    const second = nextConnection(first, { kind: "browser_offline", at: T0 + 10_000 });
    expect(second.lastBrowserOfflineAt).toBe(T0 + 10_000);
    expect(second.since).toBe(T0);
    expect(nextConnection(second, { kind: "reachable", at: T0 + 11_000, sentAt: T0 + 5_000 })).toEqual(second);
  });

  it("после двух сбоев без события браузера ответ, пришедший позже, связь возвращает", () => {
    const state = after(INITIAL_CONNECTION, { kind: "fail", at: T0 }, { kind: "fail", at: T0 + 1_000 });
    expect(state.status).toBe("offline");
    // sentAt раньше сбоев: сервер ответил уже после них — значит, он жив.
    expect(nextConnection(state, { kind: "reachable", at: T0 + 5_000, sentAt: T0 - 100 })).toEqual(INITIAL_CONNECTION);
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

describe("проверка связи без окна", () => {
  it("в тестах и на сервере окна нет — ни таймера, ни событий, и ничего не падает", async () => {
    const { watchConnection } = await import("../src/state/api-request");
    expect(() => {
      watchConnection(true);
      watchConnection(false);
    }).not.toThrow();
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
  async function firstFailAfter(respond: () => Promise<Response | null>): Promise<number | null> {
    sessionStub.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await get();
    expect(useConnection.getState().firstFailAt).not.toBeNull();
    sessionStub.fetch.mockImplementationOnce(respond);
    await get();
    return useConnection.getState().firstFailAt;
  }

  it("обрыв сети — сбой", async () => {
    sessionStub.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await get()).toEqual({ ok: false, failure: "offline" });
    expect(useConnection.getState().firstFailAt).not.toBeNull();
  });

  it.each([502, 503, 504])("ответ шлюза %i — сбой", async (status) => {
    sessionStub.fetch.mockResolvedValueOnce(answer(status));
    await get();
    expect(useConnection.getState().firstFailAt).not.toBeNull();
  });

  it("два ответа шлюза подряд — нет связи", async () => {
    sessionStub.fetch.mockResolvedValue(answer(503));
    await get();
    await get();
    expect(useConnection.getState().status).toBe("offline");
  });

  it.each([404, 400, 401, 403, 429, 500])("ответ %i — связь есть", async (status) => {
    expect(await firstFailAfter(async () => answer(status))).toBeNull();
  });

  it("успешный ответ — связь есть", async () => {
    expect(await firstFailAfter(async () => answer(200, { data: { n: 1 } }))).toBeNull();
  });

  it("запрос ушёл, потом событие offline, потом ответ 200 — статус остаётся offline", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      let answerLate: (response: Response) => void = () => undefined;
      sessionStub.fetch.mockImplementationOnce(() => new Promise<Response | null>((resolve) => (answerLate = resolve)));
      const pending = get();
      await vi.advanceTimersByTimeAsync(0);
      vi.setSystemTime(1_002_000);
      reportBrowserOffline();
      expect(useConnection.getState().status).toBe("offline");

      answerLate(answer(200, { data: { n: 1 } }));
      expect(await pending).toEqual({ ok: true, data: { n: 1 } });
      expect(useConnection.getState().status).toBe("offline");
    } finally {
      vi.useRealTimers();
    }
  });

  it("запрос ушёл уже после события offline — ответ связь возвращает", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      reportBrowserOffline();
      vi.setSystemTime(1_005_000);
      sessionStub.fetch.mockResolvedValueOnce(answer(200, { data: { n: 1 } }));
      await get();
      expect(useConnection.getState().status).toBe("online");
    } finally {
      vi.useRealTimers();
    }
  });

  it("нет сессии — запрос не уходил, связь не судится", async () => {
    sessionStub.fetch.mockResolvedValueOnce(null);
    await get();
    expect(useConnection.getState()).toMatchObject({ status: "online", firstFailAt: null });
  });
});

describe("кнопка «Повторить» и загрузка чанка проверки", () => {
  let events: { event: string; payload: unknown }[];

  /** Связь пропала, загрузчик уже позвали при потере — счёт вызовов начинается заново. */
  async function goOffline(loader: { mockClear(): void }): Promise<void> {
    reportReachability("fail", T0);
    reportReachability("fail", T0 + 1_000);
    await vi.advanceTimersByTimeAsync(0);
    loader.mockClear();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    resetConnectionForTests();
    events = [];
    initShell({ ...useShell.getState(), analytics: (event, payload) => events.push({ event, payload }) });
  });

  afterEach(() => {
    setProberForTests(null);
    vi.useRealTimers();
    resetConnectionForTests();
  });

  it("чанк упал: «Проверяем…» с нажатия, ошибки нет, затем снова «Повторить», плашка на месте", async () => {
    const loader = vi.fn(() => Promise.reject(new Error("Failed to fetch")));
    setProberForTests(loader);
    await goOffline(loader);

    const pending = retryConnection();
    expect(useConnection.getState().checking).toBe(true);
    await expect(pending).resolves.toBeUndefined();

    expect(useConnection.getState().checking).toBe(false);
    expect(useConnection.getState().status).toBe("offline");
  });

  it("чанк не отвечает: ждём не дольше PROBER_LOAD_TIMEOUT_MS, потом снова «Повторить»", async () => {
    const loader = vi.fn(() => new Promise<never>(() => undefined));
    setProberForTests(loader);
    await goOffline(loader);

    let done = false;
    const pending = retryConnection().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(PROBER_LOAD_TIMEOUT_MS - 1);
    expect(useConnection.getState().checking).toBe(true);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(useConnection.getState().checking).toBe(false);
    expect(useConnection.getState().status).toBe("offline");
    expect(done).toBe(true);
  });

  it("чанк загрузился: проверка вызвана один раз, и флаг к её началу уже снят", async () => {
    let checkingInside: boolean | null = null;
    const checkConnection = vi.fn(async () => {
      checkingInside = useConnection.getState().checking;
    });
    const loader = vi.fn(async () => ({ checkConnection, watchConnection: () => undefined }));
    setProberForTests(loader);
    await goOffline(loader);

    await retryConnection();

    expect(checkConnection).toHaveBeenCalledTimes(1);
    expect(checkingInside).toBe(false);
  });

  it("связь есть или проверка уже идёт — загрузчик не зовут", async () => {
    const loader = vi.fn(async () => ({ checkConnection: async () => undefined, watchConnection: () => undefined }));
    setProberForTests(loader);

    await retryConnection();
    expect(loader).not.toHaveBeenCalled();

    await goOffline(loader);
    useConnection.setState({ checking: true });
    await retryConnection();
    expect(loader).not.toHaveBeenCalled();
  });

  it("потеря связи при упавшем чанке: ничего не бросает, событие одно, загрузка повторяется через период", async () => {
    const loader = vi.fn(() => Promise.reject(new Error("Failed to fetch")));
    setProberForTests(loader);

    reportReachability("fail", T0);
    reportReachability("fail", T0 + 1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(events.filter((entry) => entry.event === "connection_lost")).toHaveLength(1);
    expect(loader).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CONNECTION_PROBE_PERIOD_MS);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(useConnection.getState().status).toBe("offline");
  });

  it("повторная загрузка чанка не множит таймеры: один перезапуск за период", async () => {
    const loader = vi.fn(() => Promise.reject(new Error("Failed to fetch")));
    setProberForTests(loader);

    reportReachability("fail", T0);
    reportReachability("fail", T0 + 1_000);
    await vi.advanceTimersByTimeAsync(CONNECTION_PROBE_PERIOD_MS * 3);

    // 1 при потере и по одному на каждый из трёх периодов
    expect(loader).toHaveBeenCalledTimes(4);
  });

  it("связь вернулась до срока: возвращение выключает таймер, и после срока загрузки больше нет", async () => {
    const loader = vi.fn(() => Promise.reject(new Error("Failed to fetch")));
    setProberForTests(loader);

    reportReachability("fail", T0);
    reportReachability("fail", T0 + 1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(loader).toHaveBeenCalledTimes(1);

    reportReachability("reachable", T0 + 5_000, T0 + 4_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(useConnection.getState().status).toBe("online");
    expect(loader).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(CONNECTION_PROBE_PERIOD_MS * 2);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
