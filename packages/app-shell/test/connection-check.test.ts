import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkConnection, watchConnection } from "../src/state/api-request";
import {
  CONNECTION_PROBE_PERIOD_MS,
  reportBrowserOffline,
  reportReachability,
  resetConnectionForTests,
  setProberForTests,
  useConnection,
} from "../src/state/connection";
import { initShell, useShell } from "../src/state/shell";

// Проверка связи и её таймер (tasks/T-0077): живут в отдельном чанке, который
// грузится, только когда связь пропала. Раньше их не покрывал ни один тест.

const sessionStub = vi.hoisted(() => ({ fetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response | null>>() }));

vi.mock("../src/state/session", () => ({
  authorizedFetch: sessionStub.fetch,
  useSession: { getState: () => ({ failure: "no_identity" }) },
}));

const T0 = 1_000_000;
const answer = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

const SIGNED_IN = { platformAvailable: true, botUrl: "", diagnosticsByDefault: false, auth: { baseUrl: "" } } as const;
const GUEST = { platformAvailable: true, botUrl: "", diagnosticsByDefault: false } as const;

function signedIn(): void {
  initShell({ ...useShell.getState(), capabilities: SIGNED_IN });
}

function guest(): void {
  initShell({ ...useShell.getState(), capabilities: GUEST });
}

/** Связь пропала по двум сбоям подряд — без события браузера: ответ позже него связь вернёт. */
function goOffline(): void {
  reportReachability("fail", T0);
  reportReachability("fail", T0 + 1_000);
  expect(useConnection.getState().status).toBe("offline");
}

beforeEach(() => {
  resetConnectionForTests();
  sessionStub.fetch.mockReset();
  setProberForTests(async () => ({ checkConnection: async () => undefined, watchConnection: () => undefined }));
  vi.stubGlobal("navigator", { onLine: true });
});

afterEach(() => {
  watchConnection(false);
  setProberForTests(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetConnectionForTests();
});

describe("checkConnection", () => {
  it("связь есть — запрос не уходит", async () => {
    signedIn();
    await checkConnection();
    expect(sessionStub.fetch).not.toHaveBeenCalled();
    expect(useConnection.getState().checking).toBe(false);
  });

  it("проверка уже идёт — второй запрос не уходит", async () => {
    signedIn();
    goOffline();
    useConnection.setState({ checking: true });
    await checkConnection();
    expect(sessionStub.fetch).not.toHaveBeenCalled();
  });

  it("вошедший, 200 — связь есть; спрашивает самый лёгкий запрос", async () => {
    signedIn();
    goOffline();
    sessionStub.fetch.mockResolvedValueOnce(answer(200, { data: {} }));
    await checkConnection();
    expect(useConnection.getState().status).toBe("online");
    expect(String(sessionStub.fetch.mock.calls[0]?.[0])).toContain("/api/v1/me/badges");
    expect(useConnection.getState().checking).toBe(false);
  });

  it("вошедший, 500 — сервер ответил, связь есть", async () => {
    signedIn();
    goOffline();
    sessionStub.fetch.mockResolvedValueOnce(answer(500));
    await checkConnection();
    expect(useConnection.getState().status).toBe("online");
    expect(useConnection.getState().checking).toBe(false);
  });

  it("вошедший, 503 — связи по-прежнему нет", async () => {
    signedIn();
    goOffline();
    sessionStub.fetch.mockResolvedValueOnce(answer(503));
    await checkConnection();
    expect(useConnection.getState().status).toBe("offline");
    expect(useConnection.getState().checking).toBe(false);
  });

  it("вошедший, обрыв сети — связи по-прежнему нет", async () => {
    signedIn();
    goOffline();
    sessionStub.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await checkConnection();
    expect(useConnection.getState().status).toBe("offline");
    expect(useConnection.getState().checking).toBe(false);
  });

  it("вошедший без сессии: сеть браузера есть — связь есть, сети нет — плашка остаётся", async () => {
    signedIn();
    goOffline();
    sessionStub.fetch.mockResolvedValue(null);

    vi.stubGlobal("navigator", { onLine: false });
    await checkConnection();
    expect(useConnection.getState().status).toBe("offline");

    vi.stubGlobal("navigator", { onLine: true });
    await checkConnection();
    expect(useConnection.getState().status).toBe("online");
  });

  it("гость: запрос не уходит, довольно сети браузера", async () => {
    guest();
    goOffline();

    vi.stubGlobal("navigator", { onLine: false });
    await checkConnection();
    expect(useConnection.getState().status).toBe("offline");

    vi.stubGlobal("navigator", { onLine: true });
    await checkConnection();
    expect(useConnection.getState().status).toBe("online");
    expect(sessionStub.fetch).not.toHaveBeenCalled();
  });

  it("пока запрос висит, флаг стоит и второй вызов запроса не шлёт", async () => {
    signedIn();
    goOffline();
    let reply: (response: Response) => void = () => undefined;
    sessionStub.fetch.mockImplementationOnce(() => new Promise<Response | null>((resolve) => (reply = resolve)));

    const first = checkConnection();
    // Запрос уходит не в этот же тик: до него apiRequest ждёт сессию.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useConnection.getState().checking).toBe(true);
    await checkConnection();
    expect(sessionStub.fetch).toHaveBeenCalledTimes(1);

    reply(answer(200, { data: {} }));
    await first;
    expect(useConnection.getState().checking).toBe(false);
    expect(useConnection.getState().status).toBe("online");
  });
});

describe("watchConnection", () => {
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();

  beforeEach(() => {
    addEventListener.mockClear();
    removeEventListener.mockClear();
    vi.stubGlobal("window", { addEventListener, removeEventListener });
    vi.useFakeTimers();
    guest();
  });

  it("включение дважды подписывает событие online один раз", () => {
    watchConnection(true);
    watchConnection(true);
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(addEventListener.mock.calls[0]?.[0]).toBe("online");
  });

  it("проверка идёт раз в период: за миллисекунду до срока связи нет, на сроке она вернулась", async () => {
    goOffline();
    watchConnection(true);

    await vi.advanceTimersByTimeAsync(CONNECTION_PROBE_PERIOD_MS - 1);
    expect(useConnection.getState().status).toBe("offline");

    await vi.advanceTimersByTimeAsync(1);
    expect(useConnection.getState().status).toBe("online");
  });

  it("событие браузера online запускает проверку сразу", async () => {
    goOffline();
    watchConnection(true);
    const listener = addEventListener.mock.calls[0]?.[1] as () => void;

    listener();
    await vi.advanceTimersByTimeAsync(0);

    expect(useConnection.getState().status).toBe("online");
  });

  it("выключение снимает тот же слушатель и останавливает таймер", async () => {
    watchConnection(true);
    const listener = addEventListener.mock.calls[0]?.[1];

    watchConnection(false);
    expect(removeEventListener).toHaveBeenCalledWith("online", listener);

    reportBrowserOffline(T0);
    await vi.advanceTimersByTimeAsync(CONNECTION_PROBE_PERIOD_MS * 3);
    expect(useConnection.getState().status).toBe("offline");
  });
});
