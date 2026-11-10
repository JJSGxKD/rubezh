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
 * Подписка Xray на живых Postgres и Redis (tasks/T-0093, несколько подписок —
 * tasks/T-0384): адрес лежит шифртекстом и читается тем же ключом, параллельные
 * обновления идут по одному под замком Redis, слот узла уникален между всеми
 * подписками, пул восстанавливается из таблицы, а удаление подписки каскадом
 * убирает только её узлы. Ключ подписки — строчные латиница и цифры (CHECK
 * миграции); исходная подписка сохранила ключ `main`. Без базы и Redis — пропуск.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
// Сдвиг 7: соседи по базе не делают `flushdb` (на сдвиге 13 её чистят другие файлы).
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 7);
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

  const row = (key = "main", patch: Partial<StoredSubscription> = {}): StoredSubscription => ({
    key,
    name: "Основная",
    ...sealUrl(cipher, key, URL_SECRET),
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
    createdAt: NOW,
    ...patch,
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
    await repository.create(row());

    const stored = await prisma.proxySubscription.findUniqueOrThrow({ where: { key: "main" } });

    expect(stored).toMatchObject({ name: "Основная", enabled: true, countries: ["DE", "NL"], urlKeyId: cipher.currentKeyId, updatedBy: ACTOR_ID });
    expect(Buffer.from(stored.urlCt).toString("utf8")).not.toContain("sub.example.com");
    expect(stored.urlIv).toHaveLength(12);
    expect(stored.urlTag).toHaveLength(16);
    expect(stored.urlHint).not.toContain("tok-9f8e7d6c5b4a");
    const loaded = await repository.load("main");
    expect(loaded === null ? null : openUrl(cipher, loaded.subscription)).toBe(URL_SECRET);
  });

  it("два параллельных обновления: выполняется одно, замок снят своим токеном", async () => {
    await repository.create(row());
    let release: () => void = () => undefined;
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response([link(1), link(2)].join("\n"), { status: 200 }));
        }),
    );
    const first = syncOf(fetchMock);
    const second = syncOf(fetchMock);

    const running = first.sync.refresh("main", NOW);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const rejected = await second.sync.refresh("main", NOW);
    release();

    expect(rejected).toEqual({ status: "busy" });
    expect((await running).status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await redis.get("proxy-subscription:refresh:lock")).toBeNull();
    expect(await prisma.proxySubscriptionNode.count()).toBe(2);
  });

  it("обновление пишет узлы, итог и трафик одной записью; пропавшие узлы удаляются", async () => {
    await repository.create(row());
    const answers = [[link(1), link(2), link(3)], [link(2)]];
    const fetchMock = vi.fn<typeof fetch>(async () => new Response((answers.shift() ?? []).join("\n"), { status: 200, headers: { "subscription-userinfo": "upload=1; download=2; total=100" } }));
    const { sync } = syncOf(fetchMock);

    await sync.refresh("main", NOW);
    expect(await prisma.proxySubscriptionNode.count()).toBe(3);
    await sync.refresh("main", new Date(NOW.getTime() + 1000));

    const nodes = await prisma.proxySubscriptionNode.findMany();
    expect(nodes.map((node) => node.host)).toEqual(["n2.example.org"]);
    const subscription = await prisma.proxySubscription.findUniqueOrThrow({ where: { key: "main" } });
    expect(subscription).toMatchObject({ lastRefreshOk: true, trafficUsedBytes: 3n, trafficTotalBytes: 100n });
  });

  it("слот уникален: второй узел с тем же слотом не записывается", async () => {
    await repository.create(row());
    const base = { subscriptionKey: "main", protocol: "vless", name: "n", country: "DE", host: "h.example.org", state: "unknown", failures: 0, nextProbeAt: NOW };
    await prisma.proxySubscriptionNode.create({ data: { ...base, nodeKey: "aaaa", slot: 3 } });

    await expect(prisma.proxySubscriptionNode.create({ data: { ...base, nodeKey: "bbbb", slot: 3 } })).rejects.toThrow();
    expect(await prisma.proxySubscriptionNode.count()).toBe(1);
  });

  it("новый экземпляр восстанавливает пул из таблицы: здоровые узлы сразу в переборе", async () => {
    await repository.create(row());
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
      ["node:main:bbbb", 10801],
      ["node:main:aaaa", 10800],
    ]);
  });

  it("проверки записываются в таблицу, «проверить все» ставит срок на сейчас", async () => {
    await repository.create(row());
    await prisma.proxySubscriptionNode.create({ data: { subscriptionKey: "main", nodeKey: "aaaa", slot: 0, protocol: "vless", name: "a", country: "DE", host: "a.example.org", state: "unknown", failures: 0, nextProbeAt: new Date(NOW.getTime() + 999_999) } });

    await repository.saveProbes("main", [{ nodeKey: "aaaa", state: "healthy", failures: 0, latencyMs: 77, lastProbeAt: NOW, nextProbeAt: new Date(NOW.getTime() + 300_000) }]);
    expect(await prisma.proxySubscriptionNode.findUniqueOrThrow({ where: { subscriptionKey_nodeKey: { subscriptionKey: "main", nodeKey: "aaaa" } } })).toMatchObject({ state: "healthy", latencyMs: 77 });

    await repository.scheduleAllProbes("main", NOW);
    expect((await prisma.proxySubscriptionNode.findUniqueOrThrow({ where: { subscriptionKey_nodeKey: { subscriptionKey: "main", nodeKey: "aaaa" } } })).nextProbeAt).toEqual(NOW);
  });

  it("удаление подписки каскадом убирает узлы; повторное — false", async () => {
    await repository.create(row());
    await prisma.proxySubscriptionNode.create({ data: { subscriptionKey: "main", nodeKey: "aaaa", slot: 0, protocol: "vless", name: "a", country: null, host: "a.example.org", state: "unknown", failures: 0, nextProbeAt: NOW } });

    expect(await repository.remove("main")).toBe(true);

    expect(await prisma.proxySubscriptionNode.count()).toBe(0);
    expect(await repository.load("main")).toBeNull();
    expect(await repository.remove("main")).toBe(false);
  });

  it("новый адрес с dropNodes: узлы прежней подписки удалены, сама строка осталась", async () => {
    await repository.create(row());
    await prisma.proxySubscriptionNode.create({ data: { subscriptionKey: "main", nodeKey: "aaaa", slot: 0, protocol: "vless", name: "a", country: null, host: "a.example.org", state: "unknown", failures: 0, nextProbeAt: NOW } });

    await repository.save({ ...row(), name: "Другая" }, { dropNodes: true });

    expect(await prisma.proxySubscriptionNode.count()).toBe(0);
    expect((await prisma.proxySubscription.findUniqueOrThrow({ where: { key: "main" } })).name).toBe("Другая");
  });

  const nodeData = (subscriptionKey: string, nodeKey: string, slot: number) => ({
    subscriptionKey,
    nodeKey,
    slot,
    protocol: "vless",
    name: nodeKey,
    country: "DE",
    host: `${nodeKey}.example.org`,
    state: "unknown",
    failures: 0,
    nextProbeAt: NOW,
  });

  /** Строка без created_at: так подписка лежала до миграции — колонку заполняет умолчание базы. */
  const legacyData = (key: string) => {
    const full = row(key);
    return {
      key,
      name: full.name,
      urlIv: Uint8Array.from(full.urlIv),
      urlTag: Uint8Array.from(full.urlTag),
      urlCt: Uint8Array.from(full.urlCt),
      urlKeyId: full.urlKeyId,
      urlHint: full.urlHint,
      enabled: full.enabled,
      countries: full.countries,
      updatedBy: full.updatedBy,
      updatedAt: full.updatedAt,
    };
  };

  describe("несколько подписок (Р192)", () => {
    it("исходная подписка с ключом main после миграции читается, её адрес открывается тем же ключом шифрования", async () => {
      await prisma.proxySubscription.create({ data: legacyData("main") });
      await prisma.proxySubscriptionNode.create({ data: nodeData("main", "aaaa", 0) });

      const loaded = await repository.load("main");

      expect(loaded?.subscription.createdAt).toBeInstanceOf(Date);
      expect(Math.abs((loaded?.subscription.createdAt.getTime() ?? 0) - Date.now())).toBeLessThan(60_000);
      expect(loaded === null ? null : openUrl(cipher, loaded.subscription)).toBe(URL_SECRET);
      expect(loaded?.nodes.map((node) => [node.subscriptionKey, node.nodeKey])).toEqual([["main", "aaaa"]]);
    });

    it("ключ подписки — строчные латиница и цифры до 16 знаков: ABC, дефис, пробел, пусто и длиннее — отказ CHECK", async () => {
      const insert = (key: string) => prisma.proxySubscription.create({ data: { ...legacyData("main"), key } });

      for (const key of ["ABC", "a-b", "a b", "", "ключ", "a".repeat(17), "Main"]) await expect(insert(key), JSON.stringify(key)).rejects.toThrow();
      for (const key of ["abc", "main", "0123456789ab", "a".repeat(16)]) await expect(insert(key), key).resolves.toBeDefined();
      expect(await prisma.proxySubscription.count()).toBe(4);
    });

    it("слот уникален между подписками: узел второй подписки в занятом слоте не записывается", async () => {
      await repository.create(row("main"));
      await repository.create(row("second", { createdAt: new Date(NOW.getTime() + 1000) }));
      await prisma.proxySubscriptionNode.create({ data: nodeData("main", "aaaa", 3) });

      await expect(prisma.proxySubscriptionNode.create({ data: nodeData("second", "bbbb", 3) })).rejects.toThrow();
      // Тот же ключ узла в другой подписке — можно: ключ уникален только внутри подписки.
      await expect(prisma.proxySubscriptionNode.create({ data: nodeData("second", "aaaa", 4) })).resolves.toBeDefined();
      expect(await prisma.proxySubscriptionNode.count()).toBe(2);
    });

    it("удаление подписки каскадом убирает только её узлы", async () => {
      await repository.create(row("main"));
      await repository.create(row("second", { createdAt: new Date(NOW.getTime() + 1000) }));
      await prisma.proxySubscriptionNode.createMany({ data: [nodeData("main", "aaaa", 0), nodeData("main", "bbbb", 1), nodeData("second", "cccc", 2)] });

      expect(await repository.remove("second")).toBe(true);

      expect((await prisma.proxySubscriptionNode.findMany()).map((node) => node.nodeKey).sort()).toEqual(["aaaa", "bbbb"]);
      expect(await repository.count()).toBe(1);
    });

    it("список — по времени подключения, узлы по слоту; load(key) и count() видят нужное", async () => {
      await repository.create(row("late", { createdAt: new Date(NOW.getTime() + 5000) }));
      await repository.create(row("early", { createdAt: NOW }));
      await prisma.proxySubscriptionNode.createMany({ data: [nodeData("early", "n2", 5), nodeData("early", "n1", 2), nodeData("late", "n3", 0)] });

      const all = await repository.list();

      expect(all.map((entry) => entry.subscription.key)).toEqual(["early", "late"]);
      expect(all[0]?.nodes.map((node) => node.slot)).toEqual([2, 5]);
      expect(await repository.count()).toBe(2);
      expect((await repository.load("late"))?.nodes.map((node) => node.nodeKey)).toEqual(["n3"]);
      expect(await repository.load("nosuch")).toBeNull();
    });

    it("создание с занятым ключом — отказ, а не молчаливая замена", async () => {
      await repository.create(row("main"));
      await expect(repository.create({ ...row("main"), name: "Подмена" })).rejects.toThrow();
      expect((await repository.load("main"))?.subscription.name).toBe("Основная");
    });

    it("save без смены адреса правит только поля формы и не затирает итог обновления; нет подписки — false", async () => {
      await repository.create(row("main"));
      await repository.applyRefresh("main", { at: NOW, ok: true, note: "3 узла", nodes: [], providerIntervalHours: 12, trafficUsedBytes: 5n, trafficTotalBytes: 50n, expiresAt: null });

      const saved = await repository.save({ ...row("main"), name: "Новое имя", enabled: false, countries: ["FR"], updatedAt: new Date(NOW.getTime() + 9000) });

      expect(saved).toBe(true);
      const stored = await prisma.proxySubscription.findUniqueOrThrow({ where: { key: "main" } });
      expect(stored).toMatchObject({ name: "Новое имя", enabled: false, countries: ["FR"], lastRefreshOk: true, lastRefreshNote: "3 узла", providerIntervalHours: 12, trafficUsedBytes: 5n });
      expect(await repository.save(row("nosuch"))).toBe(false);
    });

    it("dropNodes(key, ключи) снимает только названные узлы этой подписки", async () => {
      await repository.create(row("main"));
      await repository.create(row("second", { createdAt: new Date(NOW.getTime() + 1000) }));
      await prisma.proxySubscriptionNode.createMany({ data: [nodeData("main", "aaaa", 0), nodeData("main", "bbbb", 1), nodeData("second", "aaaa", 2)] });

      await repository.dropNodes("main", ["aaaa"]);
      await repository.dropNodes("main", []);

      expect((await prisma.proxySubscriptionNode.findMany({ orderBy: { slot: "asc" } })).map((node) => [node.subscriptionKey, node.nodeKey])).toEqual([
        ["main", "bbbb"],
        ["second", "aaaa"],
      ]);
    });

    it("обновление одной подписки заменяет только её узлы и не мешает слотам другой", async () => {
      await repository.create(row("main"));
      await repository.create(row("second", { createdAt: new Date(NOW.getTime() + 1000) }));
      await prisma.proxySubscriptionNode.createMany({ data: [nodeData("main", "aaaa", 0), nodeData("second", "cccc", 1)] });
      const stored = (node: ReturnType<typeof nodeData>) => ({ ...node, state: "unknown" as const, latencyMs: null, lastProbeAt: null });

      await repository.applyRefresh("main", { at: NOW, ok: true, note: "2 узла", nodes: [stored(nodeData("main", "aaaa", 2)), stored(nodeData("main", "dddd", 3))], providerIntervalHours: null, trafficUsedBytes: null, trafficTotalBytes: null, expiresAt: null });

      expect((await prisma.proxySubscriptionNode.findMany({ orderBy: { slot: "asc" } })).map((node) => [node.subscriptionKey, node.nodeKey, node.slot])).toEqual([
        ["second", "cccc", 1],
        ["main", "aaaa", 2],
        ["main", "dddd", 3],
      ]);
    });
  });
});
