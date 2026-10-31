import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { Outbound, type OutboundRecord } from "../src/infra/outbound/outbound.js";
import { ROUTE_MEMORY_SEC, type ProxyFetch } from "../src/infra/outbound/outbound-route.js";
import { RedisRouteMemory } from "../src/infra/outbound/route-memory.js";
import { openPassword } from "../src/modules/proxies/proxy-password.js";
import { PrismaProxiesRepository } from "../src/modules/proxies/proxies.repository.js";
import { ProxiesService } from "../src/modules/proxies/proxies.service.js";
import { ProxyRoutes } from "../src/modules/proxies/proxy-routes.service.js";
import type { RolesService } from "../src/modules/roles/roles.service.js";
import { SecretCipher } from "../src/modules/secrets/secret-cipher.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Прокси на живых Postgres и Redis: пароль лежит в `bytea` шифртекстом и
 * читается тем же ключом, режим сервиса из базы сильнее умолчания, правка на
 * одной реплике доходит до другой по сообщению, а память о сработавшем прокси
 * живёт в Redis десять минут. Без базы и Redis — пропуск.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 13);
const ACTOR = { accountId: "00000000-0000-4000-8000-000000000001", platform: "telegram" as const, platformUserId: "700000" };
const PASSWORD = "Интеграционный-пароль-42";

describe.skipIf(DATABASE_URL === "" || REDIS_URL === "")("прокси на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let cipher: SecretCipher;
  const clients: Redis[] = [];
  const replicas: ProxyRoutes[] = [];

  const redisClient = (): Redis => {
    const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    clients.push(redis);
    return redis;
  };

  /** Права и аудит здесь не предмет проверки: проверяется хранение. */
  const roles = { require: async () => undefined, audit: async () => undefined } as unknown as RolesService;

  const replica = async (): Promise<{ routes: ProxyRoutes; service: ProxiesService }> => {
    const repository = new PrismaProxiesRepository(prisma);
    const redis = redisClient();
    const routes = new ProxyRoutes(config, repository, cipher, redis);
    await routes.onModuleInit();
    replicas.push(routes);
    return { routes, service: new ProxiesService(repository, cipher, roles, routes) };
  };

  const wipe = async (): Promise<void> => {
    await prisma.outboundProxy.deleteMany();
    await prisma.outboundServiceMode.deleteMany();
  };

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, REDIS_URL, SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv);
    cipher = new SecretCipher(config.secrets.encryptionKeys);
    prisma = testPrisma(DATABASE_URL, 5);
    await wipe();
  });

  afterEach(async () => {
    for (const routes of replicas.splice(0)) routes.onModuleDestroy();
    await wipe();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    for (const redis of clients) redis.disconnect();
  });

  it("пароль в базе — шифртекст, читается тем же ключом; остальные поля — как введены", async () => {
    const { service } = await replica();

    const view = await service.create(ACTOR, { name: "Туннель", scheme: "socks5", host: "tunnel", port: 1080, username: "farmer", password: PASSWORD, country: "NL", note: "тест" });

    const row = await prisma.outboundProxy.findUniqueOrThrow({ where: { proxyId: view.proxyId } });
    expect(row).toMatchObject({ name: "Туннель", scheme: "socks5", host: "tunnel", port: 1080, username: "farmer", country: "NL", enabled: true, note: "тест", updatedBy: ACTOR.accountId });
    expect(Buffer.from(row.passwordCt ?? []).toString("utf8")).not.toContain("Интеграционный");
    expect(row.passwordIv).toHaveLength(12);
    expect(row.passwordTag).toHaveLength(16);
    expect(row.passwordKeyId).toBe(cipher.currentKeyId);
    expect(openPassword(cipher, row)).toBe(PASSWORD);
    expect(JSON.stringify(view)).not.toContain(PASSWORD);
  });

  it("правка без пароля оставляет шифртекст как есть, «удалить пароль» — стирает колонки", async () => {
    const { service } = await replica();
    const { proxyId } = await service.create(ACTOR, { name: "П", scheme: "http", host: "proxy.example.com", port: 3128, username: "u", password: PASSWORD, country: "DE" });
    const before = await prisma.outboundProxy.findUniqueOrThrow({ where: { proxyId } });

    await service.update(ACTOR, proxyId, { note: "правка", password: "" });
    const kept = await prisma.outboundProxy.findUniqueOrThrow({ where: { proxyId } });
    expect(Buffer.from(kept.passwordCt ?? [])).toEqual(Buffer.from(before.passwordCt ?? []));
    expect(kept.note).toBe("правка");

    await service.update(ACTOR, proxyId, { clearPassword: true });
    const cleared = await prisma.outboundProxy.findUniqueOrThrow({ where: { proxyId } });
    expect([cleared.passwordIv, cleared.passwordTag, cleared.passwordCt, cleared.passwordKeyId]).toEqual([null, null, null, null]);
  });

  it("режим сервиса из базы сильнее умолчания; сервисы без строки — по умолчанию", async () => {
    const { routes, service } = await replica();
    expect(routes.modeOf("telegram.bot")).toBe("direct_only");

    await service.setMode(ACTOR, "telegram.bot", "proxy_only");
    await routes.refresh();

    expect(routes.modeOf("telegram.bot")).toBe("proxy_only");
    expect(routes.modeOf("fx.cbr")).toBe("direct_first");
    expect(await prisma.outboundServiceMode.findUniqueOrThrow({ where: { service: "telegram.bot" } })).toMatchObject({ mode: "proxy_only", updatedBy: ACTOR.accountId });

    await service.setMode(ACTOR, "telegram.bot", "direct_only");
    await routes.refresh();
    expect(routes.modeOf("telegram.bot")).toBe("direct_only");
    expect(await prisma.outboundServiceMode.count()).toBe(1);
  });

  it("правка на одной реплике видна другой по сообщению в Redis, не дожидаясь перечитывания", async () => {
    const first = await replica();
    const second = await replica();
    expect(second.routes.list()).toEqual([]);

    const { proxyId } = await first.service.create(ACTOR, { name: "П", scheme: "http", host: "proxy.example.com", port: 3128, username: "u", password: PASSWORD, country: "DE" });

    await expect.poll(() => second.routes.list().map((proxy) => proxy.id), { timeout: 3_000 }).toEqual([proxyId]);
    expect(second.routes.list()[0]).toMatchObject({ username: "u", password: PASSWORD });

    await first.service.update(ACTOR, proxyId, { enabled: false });
    await expect.poll(() => second.routes.list(), { timeout: 3_000 }).toEqual([]);

    await first.service.setMode(ACTOR, "fx.cbr", "proxy_only");
    await expect.poll(() => second.routes.modeOf("fx.cbr"), { timeout: 3_000 }).toBe("proxy_only");
  });

  it("память о сработавшем прокси — в Redis под outbound:route:<сервис>, срок десять минут", async () => {
    const redis = redisClient();
    const memory = new RedisRouteMemory(redis);
    await redis.del("outbound:route:fx.cbr");
    expect(await memory.get("fx.cbr")).toBeNull();

    await memory.remember("fx.cbr", "proxy-1");

    expect(await redis.get("outbound:route:fx.cbr")).toBe("proxy-1");
    expect(await memory.get("fx.cbr")).toBe("proxy-1");
    const ttl = await redis.ttl("outbound:route:fx.cbr");
    expect(ttl).toBeGreaterThan(ROUTE_MEMORY_SEC - 5);
    expect(ttl).toBeLessThanOrEqual(ROUTE_MEMORY_SEC);
    await redis.del("outbound:route:fx.cbr");
  });

  it("клиент целиком: прямая попытка упала, сработавший прокси запомнен в Redis и идёт первым на следующем вызове", async () => {
    const { routes, service } = await replica();
    const first = await service.create(ACTOR, { name: "Первый", scheme: "http", host: "one.example.com", port: 3128, country: "DE", priority: 10 });
    const second = await service.create(ACTOR, { name: "Второй", scheme: "http", host: "two.example.com", port: 3128, country: "NL", priority: 20 });
    await routes.refresh();

    const redis = redisClient();
    await redis.del("outbound:route:fx.erapi");
    const records: OutboundRecord[] = [];
    const order: string[] = [];
    const proxyFetch: ProxyFetch = async (proxy) => {
      order.push(proxy.id);
      // Первый прокси недоступен, второй работает.
      if (proxy.id === first.proxyId) throw new TypeError("fetch failed");
      return new Response("ok");
    };
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
    try {
      const client = new Outbound({ write: (record) => void records.push(record) }, undefined, routes, new RedisRouteMemory(redis), proxyFetch).forService("fx.erapi");

      expect((await client("https://api.example.com/rates")).status).toBe(200);
      expect(order).toEqual([first.proxyId, second.proxyId]);
      await expect.poll(() => redis.get("outbound:route:fx.erapi"), { timeout: 3_000 }).toBe(second.proxyId);

      order.length = 0;
      expect((await client("https://api.example.com/rates")).status).toBe(200);
      expect(order).toEqual([second.proxyId]);
      expect(records.map((record) => [record.via === second.proxyId ? "second" : record.via === first.proxyId ? "first" : record.via, record.attempt])).toEqual([
        ["direct", 1],
        ["first", 2],
        ["second", 3],
        ["direct", 1],
        ["second", 2],
      ]);
    } finally {
      vi.unstubAllGlobals();
      await redis.del("outbound:route:fx.erapi");
    }
  });
});
