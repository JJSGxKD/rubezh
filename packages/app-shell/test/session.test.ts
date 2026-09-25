import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type PlatformAdapter } from "@bh/shared-types";
import { authorizedFetch, resetSessionForTests, useSession } from "../src/state/session";
import { initShell, type ShellCapabilities } from "../src/state/shell";
import type { AnalyticsEvent, AnalyticsPayload } from "../src/state/analytics";

/**
 * Сессия игрока (docs/34-stage3-plan.md, WP1). Перенос клиента с молчаливой
 * ре-авторизацией из `vpnsibcom_web` (docs/13-reuse-from-vpnsibcom.md §11):
 * здесь проверяются те краевые случаи, ради которых его и брали за основу.
 */

const events: { event: AnalyticsEvent; payload: AnalyticsPayload }[] = [];

function shell(options: { launchData?: string | null; auth?: boolean; devUser?: string } = {}): void {
  const capabilities: ShellCapabilities = {
    platformAvailable: true,
    botUrl: "",
    diagnosticsByDefault: false,
    ...(options.auth === false ? {} : { auth: { baseUrl: "https://api.test", ...(options.devUser === undefined ? {} : { devUser: options.devUser }) } }),
  };

  initShell({
    adapter: {
      ui: createNoopPlatformUi(),
      displayUser: null,
      signedLaunchData: () => (options.launchData === undefined ? "user=%7B%7D&hash=abc" : options.launchData),
      clientInfo: () => ({ platform: "android", version: "8.0" }),
    } as unknown as PlatformAdapter,
    capabilities,
    storage: undefined,
    analytics: (event, payload) => events.push({ event, payload }),
    build: { version: "test", contentHash: "abc", platform: "telegram" },
  });
}

/** Ответ сервера: `data` в конверте — как отдаёт бэкенд. */
function sessionBody(patch: { created?: boolean; expiresInSec?: number; refresh?: string; startKind?: string } = {}): string {
  return JSON.stringify({
    data: {
      ...(patch.startKind === undefined ? {} : { launch: { startKind: patch.startKind } }),
      accessToken: `access-${Math.random()}`,
      expiresInSec: patch.expiresInSec ?? 900,
      refreshToken: patch.refresh ?? `refresh-${Math.random()}`,
      account: {
        accountId: "11111111-1111-1111-1111-111111111111",
        displayName: "Дым",
        photoUrl: null,
        createdAt: "2026-09-23T00:00:00.000Z",
        created: patch.created ?? false,
      },
    },
  });
}

function ok(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

function fail(status: number, code = "unauthorized", message = "нет"): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Что запрашивали и чем отвечаем — по порядку вызовов. */
function stubFetch(responses: ((url: string) => Response)[]): { calls: string[]; bodies: unknown[] } {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  let index = 0;
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
    calls.push(input);
    bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : null);
    const next = responses[Math.min(index, responses.length - 1)];
    index++;
    return Promise.resolve(next(input));
  });
  return { calls, bodies };
}

beforeEach(() => {
  events.length = 0;
  resetSessionForTests();
  vi.unstubAllGlobals();
  shell();
});

describe("вход в сессию", () => {
  it("меняет данные запуска на сессию и запоминает аккаунт", async () => {
    stubFetch([() => ok(sessionBody({ created: true }))]);

    await useSession.getState().signIn();

    expect(useSession.getState().status).toBe("ready");
    expect(useSession.getState().account?.displayName).toBe("Дым");
  });

  it("о заведении аккаунта сообщает ровно раз, о входе — каждый раз", async () => {
    stubFetch([() => ok(sessionBody({ created: true }))]);
    await useSession.getState().signIn();

    expect(events.map((entry) => entry.event)).toEqual(["user_registered", "user_authenticated"]);
    expect(events[1]?.payload).toEqual({ reason: "launch" });
  });

  it("вход сообщает о себе: платформу клиента и что это запуск, а не повтор посреди работы", async () => {
    const { bodies } = stubFetch([() => ok(sessionBody())]);

    await useSession.getState().signIn();

    expect(bodies[0]).toEqual({ initData: "user=%7B%7D&hash=abc", reason: "launch", client: { platform: "android", version: "8.0" } });
  });

  it("запуск — сессия со снимком атрибуции от сервера: откуда открыли, по подписи", async () => {
    stubFetch([() => ok(sessionBody({ created: true, startKind: "click" }))]);

    await useSession.getState().signIn();

    expect(events.find((entry) => entry.event === "session_started")?.payload).toEqual({ startKind: "click", first: true });
  });

  it("повторный вход посреди работы сессией не считается ни у сервера, ни в событиях", async () => {
    // Сервер не узнал токен, продление тоже не принято — входим заново по данным запуска.
    let runCalls = 0;
    const { calls, bodies } = stubFetch([
      () => ok(sessionBody({ startKind: "organic" })),
      (url) => {
        if (url.endsWith("/refresh")) return fail(401);
        if (url.endsWith("/telegram")) return ok(sessionBody({ startKind: "organic" }));
        runCalls++;
        return runCalls === 1 ? fail(401) : ok("{}");
      },
    ]);
    await useSession.getState().signIn();
    events.length = 0;

    await authorizedFetch("/api/v1/runs");

    const relogin = calls.lastIndexOf(calls.find((url) => url.endsWith("/telegram")) ?? "");
    expect(bodies[relogin]).toMatchObject({ reason: "reauth" });
    expect(events.map((entry) => entry.event)).not.toContain("session_started");
  });

  it("не шлёт регистрацию, когда аккаунт уже был", async () => {
    stubFetch([() => ok(sessionBody({ created: false }))]);

    await useSession.getState().signIn();

    expect(events.map((entry) => entry.event)).toEqual(["user_authenticated"]);
  });

  it("без данных запуска не ходит в сеть вовсе", async () => {
    shell({ launchData: null });
    const { calls } = stubFetch([() => ok(sessionBody())]);

    await useSession.getState().signIn();

    expect(calls).toEqual([]);
    expect(useSession.getState().failure).toBe("no_identity");
  });

  it("мимо площадки входит разработчик по имени, если dev-сервер его передал", async () => {
    // Браузер без Telegram: данных запуска нет, но команда проверяет рейтинг
    // и профиль под своим аккаунтом (docs/34-stage3-plan.md, WP4).
    shell({ launchData: null, devUser: "dev-1:Разработчик" });
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", (input: string, init: RequestInit) => {
      bodies.push({ url: input, body: JSON.parse(String(init.body)) });
      return Promise.resolve(ok(sessionBody()));
    });

    await useSession.getState().signIn();

    expect(useSession.getState().status).toBe("ready");
    expect(bodies).toEqual([{ url: "https://api.test/api/v1/auth/dev", body: { devUser: "dev-1:Разработчик", reason: "launch" } }]);
  });

  it("имя разработчика не заменяет данные запуска: в Telegram входят по подписи", async () => {
    shell({ devUser: "dev-1:Разработчик" });
    const { calls } = stubFetch([() => ok(sessionBody())]);

    await useSession.getState().signIn();

    expect(calls).toEqual(["https://api.test/api/v1/auth/telegram"]);
  });

  it("на блокировку показывает причину от сервера: её знает только он", async () => {
    stubFetch([() => fail(403, "forbidden", "Читы в забегах")]);

    await useSession.getState().signIn();

    expect(useSession.getState().failure).toBe("banned");
    expect(useSession.getState().message).toBe("Читы в забегах");
  });

  it("токен продления не попадает в состояние: туда смотрят компоненты", async () => {
    stubFetch([() => ok(sessionBody({ refresh: "секрет-продления" }))]);

    await useSession.getState().signIn();

    expect(JSON.stringify(useSession.getState())).not.toContain("секрет-продления");
  });
});

describe("запрос от имени игрока", () => {
  it("подставляет токен и не входит заново, пока он свежий", async () => {
    const { calls } = stubFetch([() => ok(sessionBody()), () => ok("{}")]);
    await useSession.getState().signIn();

    const response = await authorizedFetch("/api/v1/runs", { method: "POST" });

    expect(response?.status).toBe(200);
    expect(calls).toEqual(["https://api.test/api/v1/auth/telegram", "https://api.test/api/v1/runs"]);
  });

  it("протухший токен продлевает молча, до запроса", async () => {
    // Срок меньше запаса: токен считается негодным сразу после выдачи.
    const { calls } = stubFetch([
      () => ok(sessionBody({ expiresInSec: 1 })),
      (url) => (url.endsWith("/refresh") ? ok(sessionBody()) : ok("{}")),
    ]);
    await useSession.getState().signIn();

    await authorizedFetch("/api/v1/runs");

    expect(calls[1]).toBe("https://api.test/api/v1/auth/refresh");
    expect(calls[2]).toBe("https://api.test/api/v1/runs");
  });

  it("десять одновременных запросов продлевают сессию один раз", async () => {
    // Без общего промиса это десять входов подряд — и лимит частоты, который
    // клиент выбил сам себе.
    const { calls } = stubFetch([
      () => ok(sessionBody({ expiresInSec: 1 })),
      (url) => (url.endsWith("/refresh") ? ok(sessionBody()) : ok("{}")),
    ]);
    await useSession.getState().signIn();

    await Promise.all(Array.from({ length: 10 }, () => authorizedFetch("/api/v1/runs")));

    expect(calls.filter((url) => url.endsWith("/refresh"))).toHaveLength(1);
  });

  it("на 401 обновляет сессию и повторяет запрос ровно один раз", async () => {
    let runCalls = 0;
    const { calls } = stubFetch([
      () => ok(sessionBody()),
      (url) => {
        if (url.endsWith("/refresh")) return ok(sessionBody());
        runCalls++;
        return runCalls === 1 ? fail(401) : ok("{}");
      },
    ]);
    await useSession.getState().signIn();

    const response = await authorizedFetch("/api/v1/runs");

    expect(response?.status).toBe(200);
    expect(runCalls).toBe(2);
    expect(calls.filter((url) => url.endsWith("/refresh"))).toHaveLength(1);
  });

  it("если и после обновления 401 — сдаётся, а не ходит по кругу", async () => {
    let runCalls = 0;
    stubFetch([
      () => ok(sessionBody()),
      (url) => {
        if (url.endsWith("/refresh") || url.endsWith("/telegram")) return ok(sessionBody());
        runCalls++;
        return fail(401);
      },
    ]);
    await useSession.getState().signIn();

    const response = await authorizedFetch("/api/v1/runs");

    expect(response?.status).toBe(401);
    expect(runCalls).toBe(2);
  });

  it("непринятый токен продления — повод войти заново, а не потерять сессию", async () => {
    const { calls } = stubFetch([
      () => ok(sessionBody({ expiresInSec: 1 })),
      (url) => {
        if (url.endsWith("/refresh")) return fail(401);
        if (url.endsWith("/telegram")) return ok(sessionBody());
        return ok("{}");
      },
    ]);
    await useSession.getState().signIn();

    await authorizedFetch("/api/v1/runs");

    expect(calls.filter((url) => url.endsWith("/telegram"))).toHaveLength(2);
    expect(useSession.getState().status).toBe("ready");
  });

  it("в сборке без авторизации не ходит в сеть и не падает", async () => {
    shell({ auth: false });
    const { calls } = stubFetch([() => ok("{}")]);

    expect(await authorizedFetch("/api/v1/runs")).toBeNull();
    expect(calls).toEqual([]);
  });
});
