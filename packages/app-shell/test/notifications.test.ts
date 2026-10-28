import { beforeEach, describe, expect, it } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter } from "@bh/shared-types";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { badgeText, useBadges } from "../src/state/badges";
import { createBadgesApi, loadBadges } from "../src/state/badges-api";
import { useItems } from "../src/state/items";
import { createItemsApi, markItemsSeen, type InventoryView, type ItemView } from "../src/state/items-api";
import { createNotificationsApi, formatWhen, loadFeed, markRead } from "../src/state/notifications-api";
import { describeNotification } from "../src/screens/meta/notifications";
import { t } from "../src/i18n";
import "../src/i18n/history";
import { initShell } from "../src/state/shell";

// Знаки меню и лента уведомлений на клиенте (docs/35-stage4-plan.md Р50, Р51,
// §3.17): числа приходят с сервера одним ответом, лента — по курсору,
// прочитанное — до увиденного, открытый лист предмета гасит его «новизну».
// Сеть подменяется: проверяется разбор и то, что попадает в стор.

interface Call {
  path: string;
  method: string;
  body?: unknown;
}

function server(calls: Call[], answers: Record<string, unknown>): ApiRequest {
  return async <T,>(path: string, schema: { parse?: unknown } & object, init: { method: "GET" | "POST" | "DELETE"; body?: unknown }): Promise<ApiResult<T>> => {
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

function item(itemId: string, isNew: boolean): ItemView {
  return { itemId, slot: "weapon", rarity: "rare", level: 1, equipped: false, power: 10, main: { stat: "damage", value: 0.1 }, extras: [], upgrade: null, reroll: null, salvage: 1, isNew };
}

describe("знаки меню и уведомления на клиенте", () => {
  beforeEach(() => {
    mount(true);
    useBadges.setState({ notifications: 0, arsenal: 0, friends: 0 });
  });

  it("знаки — одним ответом сервера; сбой сети оставляет прежние, а не нули", async () => {
    const calls: Call[] = [];
    await loadBadges(createBadgesApi(server(calls, { "/api/v1/me/badges": { arsenal: 2, friends: 1, notifications: 3 } })));
    expect(useBadges.getState()).toMatchObject({ arsenal: 2, friends: 1, notifications: 3 });
    expect(calls).toEqual([{ path: "/api/v1/me/badges", method: "GET" }]);

    await loadBadges(createBadgesApi(server([], {})));
    expect(useBadges.getState()).toMatchObject({ arsenal: 2, friends: 1, notifications: 3 });
  });

  it("текст знака: ноль — знака нет, больше девяти — «9+»", () => {
    expect(badgeText(0)).toBeUndefined();
    expect(badgeText(3)).toBe("3");
    expect(badgeText(12)).toBe("9+");
  });

  it("лента — по курсору; число колокольчика обновляется вместе с ней", async () => {
    const calls: Call[] = [];
    const api = createNotificationsApi(server(calls, { "/api/v1/me/notifications": { items: [ITEM], nextCursor: "c1", unread: 1 } }));
    const first = await loadFeed(null, api);
    expect(first.ok && first.data.items[0]?.kind).toBe("friend_gift");
    expect(useBadges.getState().notifications).toBe(1);
    await loadFeed("c/1", api);
    expect(calls.map((call) => call.path)).toEqual(["/api/v1/me/notifications", "/api/v1/me/notifications?cursor=c%2F1"]);
  });

  it("прочитано до увиденного — граница уходит на сервер, число — оттуда же", async () => {
    const calls: Call[] = [];
    useBadges.setState({ notifications: 4 });
    await markRead("n1", createNotificationsApi(server(calls, { "/api/v1/me/notifications/read": { unread: 1 } })));
    expect(calls).toEqual([{ path: "/api/v1/me/notifications/read", method: "POST", body: { upTo: "n1" } }]);
    expect(useBadges.getState().notifications).toBe(1);
  });

  it("открытый лист гасит новизну сразу у себя и отмечает на сервере; повтор знак не уводит в минус", async () => {
    const calls: Call[] = [];
    const inventory = { items: [item("a", true), item("b", true), item("c", false)], equipped: {}, power: 0, capacity: 60, levelCap: 7, merge: {} } as InventoryView;
    useItems.setState({ inventory });
    useBadges.setState({ arsenal: 2 });
    const api = createItemsApi(server(calls, { "/api/v1/items/seen": { marked: 1 } }));

    await markItemsSeen(["a"], api);
    expect(useItems.getState().inventory?.items.map((entry) => entry.isNew)).toEqual([false, true, false]);
    expect(useBadges.getState().arsenal).toBe(1);
    expect(calls).toEqual([{ path: "/api/v1/items/seen", method: "POST", body: { itemIds: ["a"] } }]);

    await markItemsSeen(["a", "c"], api);
    expect(useBadges.getState().arsenal).toBe(1);
  });

  it("сборка без входа ничего не спрашивает", async () => {
    mount(false);
    expect(await loadFeed(null)).toEqual({ ok: false, failure: "disabled" });
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

describe("уведомление о версии при скрытом журнале (Р125)", () => {
  it("текст остаётся в ленте, но никуда не ведёт", () => {
    const described = describeNotification({ id: "n2", kind: "app_update", data: { version: "0.6.0" }, createdAt: "2026-09-30T10:00:00.000Z", read: false });

    expect(described?.text).toContain("0.6.0");
    expect(described?.target).toBeNull();
    expect(described?.over).toBeUndefined();
  });
});

describe("уведомление об отписке от канала (T-0177)", () => {
  const AT = "2026-10-28T10:00:00.000Z";
  const CLOSED_UNTIL = "2026-11-27T09:00:00.000Z";

  function unsubscribed(data: Record<string, unknown>) {
    return describeNotification({ id: "n3", kind: "task_unsubscribed", data, createdAt: AT, read: false });
  }

  it("награда списана: «Вы отписались от канала «Рубеж»: награда за подписку списана — 100 монет.»; никуда не ведёт, иконка есть", () => {
    const described = unsubscribed({ title: "Рубеж", coins: 100, gems: 0, shards: 0, closedUntil: null });

    expect(described?.text).toBe("Вы отписались от канала «Рубеж»: награда за подписку списана — 100 монет.");
    expect(described?.target).toBeNull();
    expect(described?.icon).toBeDefined();
    expect(described?.title).toBeUndefined();
  });

  it("все суммы нули — награда уже потрачена, списывать нечего", () => {
    const described = unsubscribed({ title: "Рубеж", coins: 0, gems: 0, shards: 0, closedUntil: null });

    expect(described?.text).toBe("Вы отписались от канала «Рубеж»: награда за подписку уже потрачена, списывать нечего.");
  });

  it("срок закрытия задан — строка заканчивается фразой «Партнёрские задания закрыты до …» с датой, а не словом «только что»", () => {
    const taken = unsubscribed({ title: "Рубеж", coins: 100, gems: 0, shards: 0, closedUntil: CLOSED_UNTIL });
    const spent = unsubscribed({ title: "Рубеж", coins: 0, gems: 0, shards: 0, closedUntil: CLOSED_UNTIL });

    expect(taken?.text).toBe("Вы отписались от канала «Рубеж»: награда за подписку списана — 100 монет. Партнёрские задания закрыты до 27 ноября.");
    expect(spent?.text).toBe("Вы отписались от канала «Рубеж»: награда за подписку уже потрачена, списывать нечего. Партнёрские задания закрыты до 27 ноября.");
  });

  it("без названия: «Вы отписались от канала партнёра: …»", () => {
    expect(unsubscribed({ title: null, coins: 100, gems: 0, shards: 0, closedUntil: null })?.text).toBe("Вы отписались от канала партнёра: награда за подписку списана — 100 монет.");
    expect(unsubscribed({ title: null, coins: 0, gems: 0, shards: 0, closedUntil: CLOSED_UNTIL })?.text).toBe(
      "Вы отписались от канала партнёра: награда за подписку уже потрачена, списывать нечего. Партнёрские задания закрыты до 27 ноября.",
    );
  });

  it("части списанного — через «и», ненулевые только; склонение по числу", () => {
    const text = (data: Record<string, unknown>) => unsubscribed({ title: "Рубеж", closedUntil: null, ...data })?.text;

    expect(text({ coins: 1, gems: 0, shards: 0 })).toContain("списана — 1 монета.");
    expect(text({ coins: 2, gems: 0, shards: 0 })).toContain("списана — 2 монеты.");
    expect(text({ coins: 5, gems: 0, shards: 0 })).toContain("списана — 5 монет.");
    expect(text({ coins: 0, gems: 1, shards: 0 })).toContain("списана — 1 самоцвет.");
    expect(text({ coins: 0, gems: 3, shards: 0 })).toContain("списана — 3 самоцвета.");
    expect(text({ coins: 0, gems: 0, shards: 11 })).toContain("списана — 11 осколков.");
    expect(text({ coins: 0, gems: 0, shards: 21 })).toContain("списана — 21 осколок.");
    expect(text({ coins: 100, gems: 5, shards: 0 })).toContain("списана — 100 монет и 5 самоцветов.");
    expect(text({ coins: 100, gems: 5, shards: 2 })).toContain("списана — 100 монет и 5 самоцветов и 2 осколка.");
  });

  it("данные другого вида не роняют ленту: строка вместо числа — нуль, не-дата и не-строка — как «не заданы»", () => {
    expect(() => unsubscribed({ title: 5, coins: "100", gems: null, shards: Number.NaN, closedUntil: 12 })).not.toThrow();
    expect(unsubscribed({ title: 5, coins: "100", gems: null, shards: Number.NaN, closedUntil: 12 })?.text).toBe(
      "Вы отписались от канала партнёра: награда за подписку уже потрачена, списывать нечего.",
    );
    expect(unsubscribed({ title: "Рубеж", coins: 100, gems: 0, shards: 0, closedUntil: "не дата" })?.text).toBe("Вы отписались от канала «Рубеж»: награда за подписку списана — 100 монет.");
    expect(unsubscribed({})?.text).toBe("Вы отписались от канала партнёра: награда за подписку уже потрачена, списывать нечего.");
    expect(unsubscribed({ coins: -5, gems: 1.5, shards: Number.POSITIVE_INFINITY })?.text).toContain("уже потрачена");
  });

  it("лишние поля игнорируются, а название со скобками подстановки читается как текст", () => {
    const described = unsubscribed({ title: "{returned} {closed}", coins: 100, gems: 0, shards: 0, closedUntil: null, extra: "лишнее" });

    expect(described?.text).toBe("Вы отписались от канала «{returned} {closed}»: награда за подписку списана — 100 монет.");
  });

  it("подпись причины в истории игрока — «Списание награды за отписку»", () => {
    expect(t("history.reason.task_revoke")).toBe("Списание награды за отписку");
  });
});
