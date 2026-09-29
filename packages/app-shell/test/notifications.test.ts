import { beforeEach, describe, expect, it } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter } from "@bh/shared-types";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { useNotifications } from "../src/state/notifications";
import { createNotificationsApi, formatWhen, loadFeed, loadUnread, markRead } from "../src/state/notifications-api";
import { initShell } from "../src/state/shell";

// Лента уведомлений на клиенте (docs/35-stage4-plan.md Р51, §3.17): число для
// колокольчика приходит с сервера, лента — по курсору, прочитанное — до
// увиденного. Сеть подменяется: проверяется разбор и то, что попадает в стор.

interface Call {
  path: string;
  method: string;
  body?: unknown;
}

function server(calls: Call[], answers: Record<string, unknown>): ApiRequest {
  return async <T,>(path: string, schema: { parse?: unknown } & object, init: { method: "GET" | "POST"; body?: unknown }): Promise<ApiResult<T>> => {
    calls.push({ path, method: init.method, ...(init.body === undefined ? {} : { body: init.body }) });
    const key = Object.keys(answers).find((prefix) => path.startsWith(prefix));
    if (key === undefined) return { ok: false, failure: "unavailable" };
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answers[key] });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

const ITEM = { id: "n1", kind: "friend_gift", data: { fromAccountId: "a", fromName: "Дым" }, createdAt: "2026-09-30T10:00:00.000Z", read: false };

function storage(): KeyValueStorage {
  const values: Record<string, string> = {};
  return { get: (key) => values[key] ?? null, set: (key, value) => void (values[key] = value), remove: (key) => void delete values[key] };
}

function mount(auth: boolean): void {
  initShell({
    adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
    capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false, ...(auth ? { auth: { baseUrl: "" } } : {}) },
    storage: storage(),
    analytics: () => undefined,
    build: { version: "test", contentHash: "abcd1234", platform: "web" },
  });
}

describe("уведомления на клиенте", () => {
  beforeEach(() => {
    mount(true);
    useNotifications.setState({ unread: 0 });
  });

  it("число для колокольчика — с сервера", async () => {
    const calls: Call[] = [];
    await loadUnread(createNotificationsApi(server(calls, { "/api/v1/me/notifications/unread": { unread: 3 } })));
    expect(useNotifications.getState().unread).toBe(3);
    expect(calls).toEqual([{ path: "/api/v1/me/notifications/unread", method: "GET" }]);
  });

  it("лента — по курсору; число обновляется вместе с ней", async () => {
    const calls: Call[] = [];
    const api = createNotificationsApi(server(calls, { "/api/v1/me/notifications": { items: [ITEM], nextCursor: "c1", unread: 1 } }));
    const first = await loadFeed(null, api);
    expect(first.ok && first.data.items[0]?.kind).toBe("friend_gift");
    expect(useNotifications.getState().unread).toBe(1);
    await loadFeed("c/1", api);
    expect(calls.map((call) => call.path)).toEqual(["/api/v1/me/notifications", "/api/v1/me/notifications?cursor=c%2F1"]);
  });

  it("прочитано до увиденного — граница уходит на сервер, число — оттуда же", async () => {
    const calls: Call[] = [];
    useNotifications.setState({ unread: 4 });
    await markRead("n1", createNotificationsApi(server(calls, { "/api/v1/me/notifications/read": { unread: 1 } })));
    expect(calls).toEqual([{ path: "/api/v1/me/notifications/read", method: "POST", body: { upTo: "n1" } }]);
    expect(useNotifications.getState().unread).toBe(1);
  });

  it("сбой сети оставляет прежнее число, а сборка без входа ничего не спрашивает", async () => {
    useNotifications.setState({ unread: 2 });
    await loadUnread(createNotificationsApi(server([], {})));
    expect(useNotifications.getState().unread).toBe(2);

    mount(false);
    const result = await loadFeed(null);
    expect(result).toEqual({ ok: false, failure: "disabled" });
  });

  it("время в ленте — «минут назад» для свежего и датой для давнего", () => {
    const now = Date.parse("2026-09-30T12:00:00.000Z");
    expect(formatWhen("2026-09-30T11:59:40.000Z", now)).toBe("только что");
    expect(formatWhen("2026-09-30T11:55:00.000Z", now)).toBe("5 минут назад");
    expect(formatWhen("2026-09-30T09:00:00.000Z", now)).toBe("3 часа назад");
    expect(formatWhen("2026-09-20T09:00:00.000Z", now)).toBe("20 сентября");
    expect(formatWhen("не дата", now)).toBe("");
  });
});
