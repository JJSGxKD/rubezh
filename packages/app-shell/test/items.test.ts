import { beforeEach, describe, expect, it } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter } from "@bh/shared-types";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { useItems } from "../src/state/items";
import { createItemsApi, loadInventory, refreshLoadout, runItemAction } from "../src/state/items-api";
import { equippedLoadout, knownModifiers, rememberRunLoadout, runLoadoutOf } from "../src/state/run-loadouts";
import { initShell } from "../src/state/shell";

/**
 * Снаряжение клиента (docs/35-stage4-plan.md §3.4, WP7). Снимок надетого
 * живёт на устройстве — забег без сети начинается с ним; каждое нажатие —
 * свой ключ операции; ответ сервера новее клиента не ломает арсенал.
 */

const LOADOUT = { accountId: "acc", modifiers: { damage: 0.12, maxHp: 30 }, issuedAtMs: 1_000, signature: "подпись" };

const ITEM = {
  itemId: "item-1",
  slot: "weapon",
  rarity: "rare",
  level: 3,
  equipped: true,
  power: 57,
  main: { stat: "damage", value: 0.05 },
  extras: [{ stat: "damageFire", value: 0.07 }],
  upgrade: { coins: 264, shards: 1 },
  reroll: { coins: 172, shards: 0 },
  salvage: 4,
};

const INVENTORY = { items: [ITEM], equipped: { weapon: "item-1" }, power: 57, capacity: 60, levelCap: 6, merge: { common: { coins: 100, shards: 5 } } };

interface Call {
  path: string;
  method: string;
  body: unknown;
}

/** Сервер на ответах: путь → тело; всё, что не описано, — отказ с кодом. */
function server(calls: Call[], answers: Record<string, unknown>, refusal?: { code: string }): ApiRequest {
  return async <T>(path: string, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, init: { method: string; body?: unknown }): Promise<ApiResult<T>> => {
    calls.push({ path, method: init.method, body: init.body ?? null });
    if (!(path in answers)) return refusal === undefined ? { ok: false, failure: "unavailable" } : { ok: false, failure: "rejected", code: refusal.code };
    const parsed = schema.safeParse(answers[path]);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, failure: "unavailable" };
  };
}

function storage(): KeyValueStorage {
  const values: Record<string, string> = {};
  return {
    get: (key) => values[key] ?? null,
    set: (key, value) => {
      values[key] = value;
    },
    remove: (key) => {
      delete values[key];
    },
  };
}

beforeEach(() => {
  initShell({
    adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
    capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false, auth: { baseUrl: "" } },
    storage: storage(),
    analytics: () => undefined,
    build: { version: "test", contentHash: "abcd1234", platform: "web" },
  });
  useItems.setState({ inventory: null });
});

describe("снимок надетого на устройстве", () => {
  it("сохраняется для следующего забега, а пустой набор не хранится", async () => {
    const calls: Call[] = [];
    expect(await refreshLoadout(createItemsApi(server(calls, { "/api/v1/items/loadout": LOADOUT })))).toBeNull();
    expect(equippedLoadout()).toEqual(LOADOUT);

    await refreshLoadout(createItemsApi(server(calls, { "/api/v1/items/loadout": { ...LOADOUT, modifiers: {} } })));
    expect(equippedLoadout()).toBeNull();
  });

  it("неудача запроса оставляет прежний снимок: забег без сети не должен стать голым", async () => {
    await refreshLoadout(createItemsApi(server([], { "/api/v1/items/loadout": LOADOUT })));
    expect(await refreshLoadout(createItemsApi(async () => ({ ok: false, failure: "offline" })))).toBe("offline");
    expect(equippedLoadout()).toEqual(LOADOUT);
  });

  it("забег помнит свой снимок, а движку уходят только известные параметры", () => {
    const withFuture = { ...LOADOUT, modifiers: { ...LOADOUT.modifiers, stealth: 5 } };
    rememberRunLoadout("run-1", withFuture);
    for (let n = 0; n < 25; n++) rememberRunLoadout(`other-${n}`, LOADOUT);

    expect(runLoadoutOf("run-1")).toBeUndefined();
    expect(runLoadoutOf("other-24")).toEqual(LOADOUT);
    expect(knownModifiers(withFuture)).toEqual({ damage: 0.12, maxHp: 30 });
  });
});

describe("операции над предметами", () => {
  const answers = { "/api/v1/items": INVENTORY, "/api/v1/items/loadout": LOADOUT, "/api/v1/items/item-1/upgrade": ITEM };

  it("каждое нажатие — свой ключ в форме UUID; после операции арсенал и снимок перечитаны", async () => {
    const calls: Call[] = [];
    const api = createItemsApi(server(calls, answers));

    expect(await runItemAction({ kind: "upgrade", itemId: "item-1" }, api)).toEqual({ ok: true });
    expect(await runItemAction({ kind: "upgrade", itemId: "item-1" }, api)).toEqual({ ok: true });

    const upgrades = calls.filter((call) => call.path.endsWith("/upgrade"));
    const keys = upgrades.map((call) => (call.body as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(calls.some((call) => call.path === "/api/v1/items" && call.method === "GET")).toBe(true);
    expect(useItems.getState().inventory?.power).toBe(57);
    expect(equippedLoadout()).toEqual(LOADOUT);
  });

  it("отказ сервера приходит с кодом, и арсенал не перечитывается впустую", async () => {
    const calls: Call[] = [];
    const api = createItemsApi(server(calls, {}, { code: "insufficient_funds" }));

    expect(await runItemAction({ kind: "merge", itemIds: ["a", "b", "c"] }, api)).toEqual({ ok: false, failure: "rejected", code: "insufficient_funds" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "/api/v1/items/merge", body: { itemIds: ["a", "b", "c"] } });
  });

  it("слот, редкость и свойство, которых клиент не знает, арсенал не роняют", async () => {
    const future = { ...INVENTORY, items: [{ ...ITEM, slot: "ring", rarity: "ancient", extras: [{ stat: "stealth", value: 1 }] }] };
    expect(await loadInventory(createItemsApi(server([], { "/api/v1/items": future })))).toBeNull();
    expect(useItems.getState().inventory?.items[0]?.slot).toBe("ring");
  });
});
