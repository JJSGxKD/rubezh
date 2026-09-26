import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Module, type Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { $Enums } from "../src/generated/prisma/client.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { itemMergeSchema, itemRerollSchema } from "../src/modules/items/dto/items.dto.js";
import { ITEM_RARITIES, ITEM_SLOTS, RARITY_RULES } from "../src/modules/items/item-catalog.js";
import { loadoutKey, signLoadout, verifyLoadout } from "../src/modules/items/item-loadout.js";
import { ItemNotFoundError, ItemRuleError } from "../src/modules/items/items-errors.js";
import { ItemsController } from "../src/modules/items/items.controller.js";
import { ItemsService } from "../src/modules/items/items.service.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

// Граница снаряжения (docs/35-stage4-plan.md §3.4, WP7): подпись снимка
// надетого, разбор запросов и то, что аккаунт берётся из токена, а не из
// тела. Сами операции — на живом Postgres, `items.integration.test.ts`.

describe("подписанный снимок надетого", () => {
  const key = loadoutKey("cd".repeat(32));

  it("порядок ключей не меняет подпись, а любая правка её ломает", () => {
    const account = randomUUID();
    const one = signLoadout(key, account, { damage: 0.12, maxHp: 30 }, 1_000);
    const two = signLoadout(key, account, { maxHp: 30, damage: 0.12 }, 1_000);
    expect(two.signature).toBe(one.signature);
    expect(verifyLoadout(key, one)).toBe(true);

    expect(verifyLoadout(key, { ...one, accountId: randomUUID() })).toBe(false);
    expect(verifyLoadout(key, { ...one, issuedAtMs: 2_000 })).toBe(false);
    expect(verifyLoadout(key, { ...one, modifiers: { damage: 0.5, maxHp: 30 } })).toBe(false);
    expect(verifyLoadout(key, { ...one, signature: "" })).toBe(false);
  });

  it("ключ подписи — свой, а не секрет сессий как есть", () => {
    const secret = "cd".repeat(32);
    expect(loadoutKey(secret).equals(Buffer.from(secret, "hex"))).toBe(false);
    const snapshot = signLoadout(loadoutKey(secret), randomUUID(), {}, 1);
    expect(verifyLoadout(loadoutKey("ef".repeat(32)), snapshot)).toBe(false);
  });
});

describe("снаряжение: настройки", () => {
  it("слоты и редкости кода совпадают с перечислениями в базе", () => {
    expect([...ITEM_SLOTS].sort()).toEqual(Object.values($Enums.ItemSlot).sort());
    expect([...ITEM_RARITIES].sort()).toEqual(Object.values($Enums.ItemRarity).sort());
  });

  it("номер свойства перековки — в пределах самой щедрой редкости, объединение — ровно три разных uuid", () => {
    const most = Math.max(...Object.values(RARITY_RULES).map((rules) => rules.extras));
    const idempotencyKey = randomUUID();
    expect(itemRerollSchema.safeParse({ idempotencyKey, index: most - 1 }).success).toBe(true);
    expect(itemRerollSchema.safeParse({ idempotencyKey, index: most }).success).toBe(false);
    expect(itemRerollSchema.safeParse({ idempotencyKey, index: -1 }).success).toBe(false);
    expect(itemRerollSchema.safeParse({ idempotencyKey: "раз", index: 0 }).success).toBe(false);
    expect(itemMergeSchema.safeParse({ idempotencyKey, itemIds: [randomUUID(), randomUUID()] }).success).toBe(false);
    expect(itemMergeSchema.safeParse({ idempotencyKey, itemIds: [randomUUID(), randomUUID(), randomUUID()] }).success).toBe(true);
  });
});

/** Лимит частоты уходит на память, когда Redis недоступен, — тестам этого хватает. */
const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

interface Call {
  method: string;
  args: unknown[];
}

function stubService(calls: Call[]): Partial<ItemsService> {
  const record =
    (method: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return result;
    };
  return {
    inventory: record("inventory", { items: [] }),
    equip: async (accountId: string, itemId: string) => {
      calls.push({ method: "equip", args: [accountId, itemId] });
      throw new ItemNotFoundError();
    },
    upgrade: async (...args: unknown[]) => {
      calls.push({ method: "upgrade", args });
      throw new ItemRuleError("item_max_level", "Предмет уже на пределе уровня");
    },
    merge: record("merge", { itemId: "merged" }),
    salvage: record("salvage", { shards: 3, resource: "shard_common" }),
  };
}

function moduleFor(calls: Call[]): Type<unknown> {
  const config = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV });
  @Module({
    controllers: [ItemsController],
    providers: [
      { provide: APP_CONFIG, useValue: config },
      { provide: REDIS, useValue: unavailableRedis },
      { provide: ItemsService, useValue: stubService(calls) },
      {
        provide: RolesService,
        useFactory: (cfg: AppConfig) => new RolesService(cfg, new MemoryRolesRepository(), new MemoryAccountRepository()),
        inject: [APP_CONFIG],
      },
      AuthGuard,
      RateLimiter,
    ],
  })
  class TestModule {}
  return TestModule;
}

describe("снаряжение по HTTP", () => {
  const calls: Call[] = [];
  const accountId = randomUUID();
  let app: NestFastifyApplication;
  let auth: Record<string, string>;

  beforeAll(async () => {
    app = await createHttpApp(moduleFor(calls), { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const token = await signAccessToken({ accountId, platform: "telegram", platformUserId: "777" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    auth = { authorization: `Bearer ${token}` };
  });

  afterAll(async () => {
    await app.close();
  });

  it("без токена — 401, до сервиса не доходит", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/items" });
    expect(response.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("аккаунт — из токена, а не из тела", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/items/merge",
      headers: auth,
      payload: { idempotencyKey: randomUUID(), itemIds: [randomUUID(), randomUUID(), randomUUID()], accountId: randomUUID() },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ data: { itemId: "merged" } });
    expect(calls.at(-1)?.method).toBe("merge");
    expect(calls.at(-1)?.args[0]).toBe(accountId);
  });

  it("кривой идентификатор и тело — 400 с кодом, до сервиса не доходит", async () => {
    const before = calls.length;
    const badId = await app.inject({ method: "POST", url: "/api/v1/items/не-uuid/equip", headers: auth });
    const badBody = await app.inject({ method: "POST", url: `/api/v1/items/${randomUUID()}/salvage`, headers: auth, payload: { idempotencyKey: "раз" } });
    expect(badId.statusCode).toBe(400);
    expect(badBody.statusCode).toBe(400);
    expect(badBody.json()).toMatchObject({ error: { code: "validation_failed" } });
    expect(calls.length).toBe(before);
  });

  it("доменные отказы — 404 и 409 со своими кодами", async () => {
    const missing = await app.inject({ method: "POST", url: `/api/v1/items/${randomUUID()}/equip`, headers: auth });
    const capped = await app.inject({ method: "POST", url: `/api/v1/items/${randomUUID()}/upgrade`, headers: auth, payload: { idempotencyKey: randomUUID() } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "item_not_found" } });
    expect(capped.statusCode).toBe(409);
    expect(capped.json()).toMatchObject({ error: { code: "item_max_level" } });
  });
});
