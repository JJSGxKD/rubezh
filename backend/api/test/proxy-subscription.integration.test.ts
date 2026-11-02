import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaSubscriptionRepository, type StoredSubscription } from "../src/modules/proxies/subscription/subscription.repository.js";
import { SubscriptionRoutes } from "../src/modules/proxies/subscription/subscription-routes.js";
import { SubscriptionSync } from "../src/modules/proxies/subscription/subscription.sync.js";
import { openUrl, sealUrl } from "../src/modules/proxies/subscription/subscription-url.js";
import { SecretCipher } from "../src/modules/secrets/secret-cipher.js";
import { panelSettings } from "./helpers/settings.js";
import { MemoryConfigWriter } from "./helpers/memory-subscription.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Подписка Xray на живых Postgres и Redis (tasks/T-0093): адрес лежит
 * шифртекстом и читается тем же ключом, параллельные обновления идут по одному
 * под замком Redis, слот узла уникален, пул восстанавливается из таблицы, а
 * удаление подписки каскадом убирает узлы. Без базы и Redis — пропуск.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 13);
const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const URL_SECRET = "https://sub.example.com/api/v1/client/tok-9f8e7d6c5b4a?key=SECRETKEY";
const UUID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-02T12:00:00.000Z");

const link = (index: number): string => `vless://${UUID}@n${String(index)}.example.org:443?type=ws&security=tls&sni=n${String(index)}.example.org&path=%2Fws#%5BDE%5D%20${String(index)}`;

describe.skipIf(DATABASE_URL === "" || REDIS_URL === "")("подписка Xray на живых Postgres и Redis", () => {
  let prisma: PrismaClient;
  let cipher: SecretCipher;
  let redis: Redis;
  let repository: PrismaSubscriptionRepository;

  const row = (): StoredSubscription => ({
    key: "main",
    name: "Основная",
    ...sealUrl(cipher, "main", URL_SECRET),
    enabled: true,
    countries: ["DE", "NL"],
    lastRefreshAt: null,
    lastRefreshOk: null,
    lastRefreshNote: null,
    providerIntervalHours: null,
    trafficUsedBytes: null,
    trafficTotalBytes: null,
    expiresAt: null,
    updatedBy: ACTOR_ID,
    updatedAt: NOW,
  });

  const syncOf = (fetchMock: typeof fetch, writer = new MemoryConfigWriter()) => {
    const routes = new SubscriptionRoutes({ repository, settings: panelSettings(), host: "xray", basePort: 10800 });
    const sync = new SubscriptionSync({
      repository,
      cipher,
      outbound: { forService: () => fetchMock },
      resolve: async () => ["93.184.216.34"],
      writer,
      routes,
      redis,
      changed: async () => undefined,
      xray: { basePort: 10800, slotCount: 8 },
    });
    return { routes, sync, writer };
  };

  const wipe = async (): Promise<void> => {
    await prisma.proxySubscription.deleteMany();
    await redis.del("proxy-subscription:refresh:lock");
  };

  beforeAll(async () => {
    cipher = new SecretCipher([randomBytes(32).toString("base64")]);
    prisma = testPrisma(DATABASE_URL, 5);
    redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    repository = new PrismaSubscriptionRepository(prisma);
    await wipe();
  });

  afterEach(wipe);

  afterAll(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });

  it("адрес в базе — шифртекст, открывается тем же ключом; прочие поля — как записаны", async () => {
    await repository.save(row());

    const stored = await prisma.proxySubscription.findUniqueOrThrow({ where: { key: "main" } });

    expect(stored).toMatchObject({ name: "Основная", enabled: true, countries: ["DE", "NL"], urlKeyId: cipher.currentKeyId, updatedBy: ACTOR_ID });
    expect(Buffer.from(stored.urlCt).toString("utf8")).not.toContain("sub.example.com");
    expect(stored.urlIv).toHaveLength(12);
    expect(stored.urlTag).toHaveLength(16);
    expect(stored.urlHint).not.toContain("tok-9f8e7d6c5b4a");
    const loaded = await repository.load();
    expect(loaded === null ? null : openUrl(cipher, loaded.subscription)).toBe(URL_SECRET);
  });

  it("два параллельных обновления: выполняется одно, замок снят своим токеном", async () => {
    await repository.save(row());
    let release: () => void = () => undefined;
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response([link(1), link(2)].join("\n"), { status: 200 }));
        }),
    );
    const first = syncOf(fetchMock);
    const second = syncOf(fetchMock);

    const running = first.sync.refresh(NOW);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const rejected = await second.sync.refresh(NOW);
    release();

    expect(rejected).toEqual({ status: "busy" });
    expect((await running).status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await redis.get("proxy-subscription:refresh:lock")).toBeNull();
    expect(await prisma.proxySubscriptionNode.count()).toBe(2);
  });

  it("обновление пишет узлы, итог и трафик одной записью; пропавшие узлы удаляются", async () => {
    await repository.save(row());
    const answers = [[link(1), link(2), link(3)], [link(2)]];
    const fetchMock = vi.fn<typeof fetch>(async () => new Response((answers.shift() ?? []).join("\n"), { status: 200, headers: { "subscription-userinfo": "upload=1; download=2; total=100" } }));
    const { sync } = syncOf(fetchMock);

    await sync.refresh(NOW);
    expect(await prisma.proxySubscriptionNode.count()).toBe(3);
    await sync.refresh(new Date(NOW.getTime() + 1000));

    const nodes = await prisma.proxySubscriptionNode.findMany();
    expect(nodes.map((node) => node.host)).toEqual(["n2.example.org"]);
    const subscription = await prisma.proxySubscription.findUniqueOrThrow({ where: { key: "main" } });
    expect(subscription).toMatchObject({ lastRefreshOk: true, trafficUsedBytes: 3n, trafficTotalBytes: 100n });
  });

  it("слот уникален: второй узел с тем же слотом не записывается", async () => {
    await repository.save(row());
    const base = { subscriptionKey: "main", protocol: "vless", name: "n", country: "DE", host: "h.example.org", state: "unknown", failures: 0, nextProbeAt: NOW };
    await prisma.proxySubscriptionNode.create({ data: { ...base, nodeKey: "aaaa", slot: 3 } });

    await expect(prisma.proxySubscriptionNode.create({ data: { ...base, nodeKey: "bbbb", slot: 3 } })).rejects.toThrow();
    expect(await prisma.proxySubscriptionNode.count()).toBe(1);
  });

  it("новый экземпляр восстанавливает пул из таблицы: здоровые узлы сразу в переборе", async () => {
    await repository.save(row());
    const base = { subscriptionKey: "main", protocol: "vless", country: "DE", failures: 0, nextProbeAt: new Date(NOW.getTime() + 300_000), lastProbeAt: NOW };
    await prisma.proxySubscriptionNode.createMany({
      data: [
        { ...base, nodeKey: "aaaa", slot: 0, name: "a", host: "a.example.org", state: "healthy", latencyMs: 120 },
        { ...base, nodeKey: "bbbb", slot: 1, name: "b", host: "b.example.org", state: "healthy", latencyMs: 40 },
        { ...base, nodeKey: "cccc", slot: 2, name: "c", host: "c.example.org", state: "down", failures: 5, latencyMs: null },
      ],
    });

    const fresh = new SubscriptionRoutes({ repository, settings: panelSettings(), host: "xray", basePort: 10800 });
    await fresh.reload();

    expect(fresh.list(0).map((proxy) => [proxy.id, proxy.port])).toEqual([
      ["node:bbbb", 10801],
      ["node:aaaa", 10800],
    ]);
  });

  it("проверки записываются в таблицу, «проверить все» ставит срок на сейчас", async () => {
    await repository.save(row());
    await prisma.proxySubscriptionNode.create({ data: { subscriptionKey: "main", nodeKey: "aaaa", slot: 0, protocol: "vless", name: "a", country: "DE", host: "a.example.org", state: "unknown", failures: 0, nextProbeAt: new Date(NOW.getTime() + 999_999) } });

    await repository.saveProbes("main", [{ nodeKey: "aaaa", state: "healthy", failures: 0, latencyMs: 77, lastProbeAt: NOW, nextProbeAt: new Date(NOW.getTime() + 300_000) }]);
    expect(await prisma.proxySubscriptionNode.findUniqueOrThrow({ where: { subscriptionKey_nodeKey: { subscriptionKey: "main", nodeKey: "aaaa" } } })).toMatchObject({ state: "healthy", latencyMs: 77 });

    await repository.scheduleAllProbes("main", NOW);
    expect((await prisma.proxySubscriptionNode.findUniqueOrThrow({ where: { subscriptionKey_nodeKey: { subscriptionKey: "main", nodeKey: "aaaa" } } })).nextProbeAt).toEqual(NOW);
  });

  it("удаление подписки каскадом убирает узлы; повторное — false", async () => {
    await repository.save(row());
    await prisma.proxySubscriptionNode.create({ data: { subscriptionKey: "main", nodeKey: "aaaa", slot: 0, protocol: "vless", name: "a", country: null, host: "a.example.org", state: "unknown", failures: 0, nextProbeAt: NOW } });

    expect(await repository.remove("main")).toBe(true);

    expect(await prisma.proxySubscriptionNode.count()).toBe(0);
    expect(await repository.load()).toBeNull();
    expect(await repository.remove("main")).toBe(false);
  });

  it("новый адрес с dropNodes: узлы прежней подписки удалены, сама строка осталась", async () => {
    await repository.save(row());
    await prisma.proxySubscriptionNode.create({ data: { subscriptionKey: "main", nodeKey: "aaaa", slot: 0, protocol: "vless", name: "a", country: null, host: "a.example.org", state: "unknown", failures: 0, nextProbeAt: NOW } });

    await repository.save({ ...row(), name: "Другая" }, { dropNodes: true });

    expect(await prisma.proxySubscriptionNode.count()).toBe(0);
    expect((await prisma.proxySubscription.findUniqueOrThrow({ where: { key: "main" } })).name).toBe("Другая");
  });
});
