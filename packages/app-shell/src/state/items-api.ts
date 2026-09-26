import type { SignedLoadout } from "@bh/shared-types";
import { z } from "zod/mini";
import { apiRequest, type ApiFailure, type ApiRequest, type ApiResult } from "./api-request";
import { useItems } from "./items";
import { saveEquippedLoadout, signedLoadoutSchema } from "./run-loadouts";
import { useShell } from "./shell";
import { loadWallet } from "./wallet-api";

/**
 * Снаряжение с сервера (docs/35-stage4-plan.md §3.4, WP7). Клиент правил
 * снаряжения не знает: значения, мощь и цены приходят посчитанными, а
 * результат операции решает сервер — иначе число на экране и число в забеге
 * однажды разошлись бы.
 *
 * Слоты, редкости и параметры — строками, а не перечислениями: сервер мог
 * обновиться раньше клиента, и новый параметр не должен ронять арсенал.
 */

const costSchema = z.object({ coins: z.number(), shards: z.number() });
const statSchema = z.object({ stat: z.string(), value: z.number() });

const itemSchema = z.object({
  itemId: z.string(),
  slot: z.string(),
  rarity: z.string(),
  level: z.number(),
  equipped: z.boolean(),
  power: z.number(),
  main: statSchema,
  extras: z.array(statSchema),
  upgrade: z.nullable(costSchema),
  reroll: z.nullable(costSchema),
  salvage: z.number(),
});

const inventorySchema = z.object({
  items: z.array(itemSchema),
  equipped: z.record(z.string(), z.string()),
  power: z.number(),
  capacity: z.number(),
  levelCap: z.number(),
  merge: z.record(z.string(), costSchema),
});

const salvageSchema = z.object({ shards: z.number(), resource: z.string() });

export type ItemCost = z.infer<typeof costSchema>;
export type ItemView = z.infer<typeof itemSchema>;
export type InventoryView = z.infer<typeof inventorySchema>;

export interface ItemsApi {
  inventory(): Promise<ApiResult<InventoryView>>;
  loadout(): Promise<ApiResult<SignedLoadout>>;
  equip(itemId: string): Promise<ApiResult<ItemView>>;
  unequip(itemId: string): Promise<ApiResult<ItemView>>;
  upgrade(itemId: string, idempotencyKey: string): Promise<ApiResult<ItemView>>;
  reroll(itemId: string, index: number, idempotencyKey: string): Promise<ApiResult<ItemView>>;
  salvage(itemId: string, idempotencyKey: string): Promise<ApiResult<z.infer<typeof salvageSchema>>>;
  merge(itemIds: readonly string[], idempotencyKey: string): Promise<ApiResult<ItemView>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createItemsApi(request: ApiRequest = apiRequest): ItemsApi {
  const post = <T>(path: string, schema: z.ZodMiniType<T>, body: unknown = {}) => request(`/api/v1/items${path}`, schema, { method: "POST", body });
  const item = (itemId: string) => `/${encodeURIComponent(itemId)}`;
  return {
    inventory: () => request("/api/v1/items", inventorySchema, { method: "GET" }),
    loadout: () => request("/api/v1/items/loadout", signedLoadoutSchema, { method: "GET" }),
    equip: (itemId) => post(`${item(itemId)}/equip`, itemSchema),
    unequip: (itemId) => post(`${item(itemId)}/unequip`, itemSchema),
    upgrade: (itemId, idempotencyKey) => post(`${item(itemId)}/upgrade`, itemSchema, { idempotencyKey }),
    reroll: (itemId, index, idempotencyKey) => post(`${item(itemId)}/reroll`, itemSchema, { idempotencyKey, index }),
    salvage: (itemId, idempotencyKey) => post(`${item(itemId)}/salvage`, salvageSchema, { idempotencyKey }),
    merge: (itemIds, idempotencyKey) => post("/merge", itemSchema, { idempotencyKey, itemIds }),
  };
}

function disabled(api: ItemsApi | undefined): boolean {
  return api === undefined && useShell.getState().capabilities.auth === undefined;
}

export async function loadInventory(api?: ItemsApi): Promise<ApiFailure | null> {
  if (disabled(api)) return "disabled";
  const response = await (api ?? createItemsApi()).inventory();
  if (!response.ok) return response.failure;
  useItems.setState({ inventory: response.data });
  return null;
}

/**
 * Снимок надетого — на устройство, для следующего забега. Пустой набор не
 * хранится: забег без снаряжения ничего не должен доказывать серверу.
 */
export async function refreshLoadout(api?: ItemsApi): Promise<ApiFailure | null> {
  if (disabled(api)) return "disabled";
  const response = await (api ?? createItemsApi()).loadout();
  if (!response.ok) return response.failure;
  saveEquippedLoadout(Object.keys(response.data.modifiers).length === 0 ? null : response.data);
  return null;
}

export type ItemAction =
  | { kind: "equip" | "unequip" | "upgrade" | "salvage"; itemId: string }
  | { kind: "reroll"; itemId: string; index: number }
  | { kind: "merge"; itemIds: readonly string[] };

export type ItemActionResult = { ok: true } | { ok: false; failure: ApiFailure; code?: string };

/**
 * Одно нажатие — один ключ операции: двойное нажатие и повтор после обрыва
 * связи не спишут цену дважды. После операции арсенал, снимок и кошелёк
 * перечитываются: цену и результат знает сервер.
 */
export async function runItemAction(action: ItemAction, api?: ItemsApi): Promise<ItemActionResult> {
  if (disabled(api)) return { ok: false, failure: "disabled" };
  const client = api ?? createItemsApi();
  const key = createUuid();
  const response = await send(client, action, key);
  if (!response.ok) return response.code === undefined ? { ok: false, failure: response.failure } : { ok: false, failure: response.failure, code: response.code };
  await Promise.all([loadInventory(client), refreshLoadout(client), api === undefined ? loadWallet() : null]);
  return { ok: true };
}

function send(client: ItemsApi, action: ItemAction, key: string): Promise<ApiResult<unknown>> {
  switch (action.kind) {
    case "equip":
      return client.equip(action.itemId);
    case "unequip":
      return client.unequip(action.itemId);
    case "upgrade":
      return client.upgrade(action.itemId, key);
    case "salvage":
      return client.salvage(action.itemId, key);
    case "reroll":
      return client.reroll(action.itemId, action.index, key);
    case "merge":
      return client.merge(action.itemIds, key);
  }
}

/**
 * Ключ операции — UUID: другой сервер для предметов не принимает.
 * `crypto.randomUUID` есть не во всех WebView — запасной путь раскладывает
 * случайные байты по полям UUID версии 4 сам. Без `state/ids.ts`: общий с
 * первой загрузкой модуль выделился бы в отдельный чанк.
 */
function createUuid(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
