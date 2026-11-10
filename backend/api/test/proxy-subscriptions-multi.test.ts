import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { Outbound, type OutboundRecord } from "../src/infra/outbound/outbound.js";
import type { ProxyFetch } from "../src/infra/outbound/outbound-route.js";
import { SubscriptionBusyError, SubscriptionLimitError, SubscriptionNotFoundError } from "../src/modules/proxies/proxies-errors.js";
import type { ProxyRoutes } from "../src/modules/proxies/proxy-routes.service.js";
import { SubscriptionCommands } from "../src/modules/proxies/subscription/subscription-commands.js";
import { SubscriptionRoutes } from "../src/modules/proxies/subscription/subscription-routes.js";
import { newSubscriptionKey, nodeRef, slotQuota, SUBSCRIPTION_KEY_FORMAT, SUBSCRIPTIONS_MAX, trimToQuota } from "../src/modules/proxies/subscription/subscription-rules.js";
import { sealUrl } from "../src/modules/proxies/subscription/subscription-url.js";
import type { StoredNode, StoredSubscription } from "../src/modules/proxies/subscription/subscription.repository.js";
import { SubscriptionScheduler } from "../src/modules/proxies/subscription/subscription.scheduler.js";
import { ProxySubscriptionService } from "../src/modules/proxies/subscription/subscription.service.js";
import { SubscriptionSync } from "../src/modules/proxies/subscription/subscription.sync.js";
import { assembleConfig } from "../src/modules/proxies/subscription/xray-config-assembly.js";
import { FileConfigWriter, SidecarMissingError, type ConfigPart } from "../src/modules/proxies/subscription/xray-config-writer.js";
import type { AccountRef, RolesService } from "../src/modules/roles/roles.service.js";
import { SecretCipher } from "../src/modules/secrets/secret-cipher.js";
import type { SettingValue } from "../src/modules/settings/setting-catalog.js";
import { MemoryConfigWriter, MemoryLockRedis, MemorySubscriptionRepository } from "./helpers/memory-subscription.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Несколько подписок Xray в общем переборе (docs/35-stage4-plan.md Р192,
 * tasks/T-0384): конфиг из частей подписок, доля входов, выключение целиком,
 * замок на всё, что меняет конфиг, расписание по подпискам. Сеть, DNS, том
 * спутника, Redis и хранилище — подмены; файлы-части проверяются на настоящей
 * файловой системе во временном каталоге.
 */

const NOW = new Date("2026-11-07T12:00:00.000Z");
const UUID = "11111111-1111-4111-8111-111111111111";
const PUBLIC_IP = "93.184.216.34";
const BASE_PORT = 10800;
const LOCK_KEY = "proxy-subscription:refresh:lock";
const ACTOR: AccountRef = { accountId: "00000000-0000-4000-8000-000000000001", platform: "telegram", platformUserId: "1" };
const SECRET_PATTERN = /token-|sub-[a-z0-9]+\.example\.com/;

const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);
const urlOf = (key: string): string => `https://sub-${key}.example.com/s/token-${key}`;
const hostOf = (key: string): string => `sub-${key}.example.com`;
/** Узел: хост различает ключи, имя задаёт страну. */
const nodeLink = (host: string, country = "DE"): string =>
  `vless://${UUID}@${host}:443?type=ws&security=tls&sni=${host}&path=%2Fws#${encodeURIComponent(`[${country}] ${host}`)}`;
const bodyOf = (...hosts: string[]): string => hosts.map((host) => nodeLink(host)).join("\n");

interface Rig {
  repository: MemorySubscriptionRepository;
  cipher: SecretCipher;
  routes: SubscriptionRoutes;
  writer: MemoryConfigWriter;
  redis: MemoryLockRedis;
  settings: ReturnType<typeof panelSettings>;
  fetch: ReturnType<typeof vi.fn<typeof fetch>>;
  proxyFetch: ReturnType<typeof vi.fn<ProxyFetch>>;
  changed: ReturnType<typeof vi.fn<() => Promise<void>>>;
  sync: SubscriptionSync;
  commands: SubscriptionCommands;
  scheduler: SubscriptionScheduler;
  service: ProxySubscriptionService;
  audit: ReturnType<typeof vi.fn<(entry: unknown) => Promise<void>>>;
  /** что отвечает поставщик подписки с этим ключом */
  serve: (key: string, body: string) => void;
  fail: (key: string) => void;
  /** подписка с ключом, адресом по ключу и порядком в списке */
  add: (key: string, patch?: Partial<StoredSubscription>) => Promise<StoredSubscription>;
  nodeKeyOf: (subscription: string, host: string) => string;
}

function rig(options: { slotCount?: number; settings?: Record<string, SettingValue> } = {}): Rig {
  const slotCount = options.slotCount ?? 12;
  const repository = new MemorySubscriptionRepository();
  const cipher = new SecretCipher([randomBytes(32).toString("base64")]);
  const settings = panelSettings({ "proxy.subscription.candidates": 4, ...options.settings });
  const routes = new SubscriptionRoutes({ repository, settings, host: "xray", basePort: BASE_PORT });
  const writer = new MemoryConfigWriter();
  const redis = new MemoryLockRedis();
  const answers = new Map<string, () => Response>();
  const fetchMock = vi.fn<typeof fetch>(async (input) => (answers.get(new URL(String(input)).hostname) ?? (() => new Response("нет такой подписки", { status: 404 })))());
  const proxyFetch = vi.fn<ProxyFetch>(async () => new Response(JSON.stringify({ ip: "203.0.113.7" }), { status: 200 }));
  const changed = vi.fn<() => Promise<void>>(async () => undefined);
  const xray = { basePort: BASE_PORT, slotCount };
  const sync = new SubscriptionSync({ repository, cipher, outbound: { forService: () => fetchMock }, resolve: async () => [PUBLIC_IP], writer, routes, redis, changed, xray });
  const commands = new SubscriptionCommands({ repository, writer, sync, xray });
  const scheduler = new SubscriptionScheduler({ repository, routes, sync, writer, proxyFetch, redis, settings, changed });
  const audit = vi.fn<(entry: unknown) => Promise<void>>(async () => undefined);
  const roles = { require: vi.fn(async () => undefined), audit } as unknown as RolesService;
  const proxyRoutes = { changed } as unknown as ProxyRoutes;
  const config = loadAppConfig({ NODE_ENV: "test", XRAY_SLOT_COUNT: String(slotCount) } as NodeJS.ProcessEnv);
  const service = new ProxySubscriptionService(repository, cipher, roles, sync, commands, routes, writer, redis as unknown as Redis, proxyRoutes, config);

  let order = 0;
  return {
    repository,
    cipher,
    routes,
    writer,
    redis,
    settings,
    fetch: fetchMock,
    proxyFetch,
    changed,
    sync,
    commands,
    scheduler,
    service,
    audit,
    serve: (key, body) => void answers.set(hostOf(key), () => new Response(body, { status: 200 })),
    fail: (key) => void answers.set(hostOf(key), () => new Response("сбой", { status: 500 })),
    add: async (key, patch = {}) => {
      const row: StoredSubscription = {
        key,
        name: `Подписка ${key}`,
        ...sealUrl(cipher, key, urlOf(key)),
        enabled: true,
        countries: [],
        lastRefreshAt: null,
        lastRefreshOk: null,
        lastRefreshNote: null,
        providerIntervalHours: null,
        trafficUsedBytes: null,
        trafficTotalBytes: null,
        expiresAt: null,
        updatedBy: ACTOR.accountId,
        updatedAt: NOW,
        createdAt: at((order += 1)),
        ...patch,
      };
      await repository.create(row);
      return row;
    },
    nodeKeyOf: (subscription, host) => {
      const found = repository.nodesOf(subscription).find((node) => node.host === host);
      if (found === undefined) throw new Error(`нет узла ${host} у подписки ${subscription}`);
      return found.nodeKey;
    },
  };
}

type BuiltConfig = { inbounds: { tag: string; port: number }[]; outbounds: { tag: string }[]; routing: { rules: { inboundTag: string[]; outboundTag: string }[] } };
const configOf = (r: Rig): BuiltConfig => r.writer.last as unknown as BuiltConfig;
const outTags = (config: BuiltConfig): string[] => config.outbounds.map((outbound) => outbound.tag).filter((tag) => tag !== "block");

/** Все узлы здоровы, задержка по порядку слотов: проверка перебора не ждёт расписания. */
async function healthy(r: Rig, latency: (node: StoredNode) => number): Promise<void> {
  r.repository.nodes = r.repository.nodes.map((node) => ({ ...node, state: "healthy", latencyMs: latency(node), lastProbeAt: NOW, nextProbeAt: at(300) }));
  await r.routes.reload();
}

describe("правила подписок", () => {
  it("не больше десяти; ключ — строчные латиница и цифры до 16 знаков", () => {
    expect(SUBSCRIPTIONS_MAX).toBe(10);
    for (const ok of ["main", "a", "0123456789ab", "a".repeat(16)]) expect(SUBSCRIPTION_KEY_FORMAT.test(ok), ok).toBe(true);
    for (const bad of ["", "ABC", "a".repeat(17), "a-b", "a b", "ключ", "a/../b", "a\n"]) expect(SUBSCRIPTION_KEY_FORMAT.test(bad), bad).toBe(false);
  });

  it("новый ключ — 12 строчных hex, разные при каждом вызове, и проходит формат", () => {
    const keys = new Set(Array.from({ length: 50 }, () => newSubscriptionKey()));
    expect(keys.size).toBe(50);
    for (const key of keys) {
      expect(key).toMatch(/^[0-9a-f]{12}$/);
      expect(SUBSCRIPTION_KEY_FORMAT.test(key)).toBe(true);
    }
  });

  it("доля входов — целая часть деления на число подписок; подписок нет — все входы", () => {
    expect(slotQuota(100, 1)).toBe(100);
    expect(slotQuota(100, 3)).toBe(33);
    expect(slotQuota(100, 10)).toBe(10);
    expect(slotQuota(4, 2)).toBe(2);
    expect(slotQuota(100, 0)).toBe(100);
    expect(slotQuota(5, 10)).toBe(0);
  });

  it("ссылка на узел — <ключ подписки>:<ключ узла>", () => {
    expect(nodeRef("main", "0123456789abcdef")).toBe("main:0123456789abcdef");
  });

  describe("какие узлы снять сверх доли", () => {
    const node = (key: string, slot: number, patch: Partial<StoredNode> = {}): StoredNode => ({
      subscriptionKey: "a",
      nodeKey: key,
      slot,
      protocol: "vless",
      name: key,
      country: "DE",
      host: `${key}.example.org`,
      state: "healthy",
      failures: 0,
      latencyMs: 100,
      lastProbeAt: NOW,
      nextProbeAt: NOW,
      ...patch,
    });
    const dropped = (nodes: StoredNode[], quota: number): string[] => trimToQuota(nodes, quota).map((item) => item.nodeKey);

    it("узлов не больше доли — снимать нечего", () => {
      expect(dropped([node("a", 0), node("b", 1)], 2)).toEqual([]);
      expect(dropped([node("a", 0)], 5)).toEqual([]);
      expect(dropped([], 0)).toEqual([]);
    });

    it("сначала не отвечающие, затем не проверенные, затем здоровые с большей задержкой", () => {
      const nodes = [node("fast", 0, { latencyMs: 20 }), node("slow", 1, { latencyMs: 400 }), node("new", 2, { state: "unknown", latencyMs: null }), node("dead", 3, { state: "down", failures: 5, latencyMs: null }), node("mid", 4, { latencyMs: 90 })];
      expect(dropped(nodes, 4)).toEqual(["dead"]);
      expect(dropped(nodes, 3)).toEqual(["dead", "new"]);
      expect(dropped(nodes, 2)).toEqual(["dead", "new", "slow"]);
      expect(dropped(nodes, 1)).toEqual(["dead", "new", "slow", "mid"]);
      expect(dropped(nodes, 0)).toHaveLength(5);
    });

    it("при равной задержке — с большим слотом", () => {
      const nodes = [node("a", 3), node("b", 9), node("c", 5)];
      expect(dropped(nodes, 1)).toEqual(["b", "c"]);
    });

    it("порядок входа не важен, список не меняется", () => {
      const nodes = [node("b", 1, { latencyMs: 10 }), node("a", 0, { latencyMs: 300 })];
      const copy = [...nodes];
      expect(dropped(nodes, 1)).toEqual(["a"]);
      expect(nodes).toEqual(copy);
    });
  });
});

describe("общий конфиг из частей подписок", () => {
  it("две подписки по три узла: config.json из шести входов, теги с ключами подписок, в перебор — лучшие из обеих", async () => {
    const r = rig();
    await r.add("a");
    await r.add("b");
    r.serve("a", bodyOf("a1.example.org", "a2.example.org", "a3.example.org"));
    r.serve("b", bodyOf("b1.example.org", "b2.example.org", "b3.example.org"));

    expect((await r.sync.refresh("a", NOW)).status).toBe("ok");
    expect(configOf(r).inbounds).toHaveLength(3);
    expect((await r.sync.refresh("b", at(1))).status).toBe("ok");

    const config = configOf(r);
    expect(config.inbounds.map((inbound) => inbound.port)).toEqual([0, 1, 2, 3, 4, 5].map((slot) => BASE_PORT + slot));
    const tags = outTags(config);
    expect(tags).toHaveLength(6);
    expect(tags.filter((tag) => tag.startsWith("out-a-"))).toHaveLength(3);
    expect(tags.filter((tag) => tag.startsWith("out-b-"))).toHaveLength(3);
    for (const tag of tags) expect(tag).toMatch(/^out-(a|b)-[0-9a-f]{16}$/);
    expect(config.routing.rules).toHaveLength(6);
    expect(new Set(r.repository.nodes.map((node) => node.slot)).size).toBe(6);

    // Задержки: a — 10, 50, 90; b — 20, 30, 100. Лучшие четыре (candidates) — по две из каждой.
    const latency: Record<string, number> = { "a1.example.org": 10, "a2.example.org": 50, "a3.example.org": 90, "b1.example.org": 20, "b2.example.org": 30, "b3.example.org": 100 };
    await healthy(r, (node) => latency[node.host] ?? 999);
    const listed = r.routes.list(0).map((proxy) => proxy.id);
    expect(listed).toEqual([
      `node:a:${r.nodeKeyOf("a", "a1.example.org")}`,
      `node:b:${r.nodeKeyOf("b", "b1.example.org")}`,
      `node:b:${r.nodeKeyOf("b", "b2.example.org")}`,
      `node:a:${r.nodeKeyOf("a", "a2.example.org")}`,
    ]);
  });

  it("часть подписки лежит в томе отдельно: узлы с секретами в ней, в таблице секретов нет", async () => {
    const r = rig();
    await r.add("a");
    r.serve("a", bodyOf("a1.example.org", "a2.example.org"));

    await r.sync.refresh("a", NOW);

    const part = r.writer.parts.get("a");
    expect(part?.version).toBe(1);
    expect(part?.nodes.map((entry) => entry.node.host)).toEqual(["a1.example.org", "a2.example.org"]);
    expect(part?.nodes.map((entry) => entry.node.secret)).toEqual([UUID, UUID]);
    expect(part?.nodes.map((entry) => entry.slot)).toEqual(r.repository.nodesOf("a").map((node) => node.slot));
    expect(JSON.stringify(r.repository.nodes)).not.toContain(UUID);
  });

  it("сбой поставщика у A: узлы A и часть B в конфиге на месте, конфиг не переписан", async () => {
    const r = rig();
    await r.add("a");
    await r.add("b");
    r.serve("a", bodyOf("a1.example.org", "a2.example.org", "a3.example.org"));
    r.serve("b", bodyOf("b1.example.org", "b2.example.org", "b3.example.org"));
    await r.sync.refresh("a", NOW);
    await r.sync.refresh("b", at(1));
    const before = { nodes: structuredClone(r.repository.nodesOf("a")), partA: structuredClone(r.writer.parts.get("a")), partB: structuredClone(r.writer.parts.get("b")), configs: r.writer.written.length };

    r.fail("a");
    const result = await r.sync.refresh("a", at(3600));

    expect(result).toEqual({ status: "failed", note: "Поставщик ответил кодом 500" });
    expect(r.repository.nodesOf("a")).toEqual(before.nodes);
    expect(r.writer.parts.get("a")).toEqual(before.partA);
    expect(r.writer.parts.get("b")).toEqual(before.partB);
    expect(r.writer.written).toHaveLength(before.configs);
    expect(outTags(configOf(r))).toHaveLength(6);
    expect(r.repository.rowOf("a")).toMatchObject({ lastRefreshOk: false, lastRefreshNote: "Поставщик ответил кодом 500" });
    expect(r.repository.rowOf("b")).toMatchObject({ lastRefreshOk: true });
  });

  it("обновление A не трогает слоты и узлы B: у B прежние порты", async () => {
    const r = rig();
    await r.add("a");
    await r.add("b");
    r.serve("a", bodyOf("a1.example.org"));
    r.serve("b", bodyOf("b1.example.org", "b2.example.org"));
    await r.sync.refresh("a", NOW);
    await r.sync.refresh("b", at(1));
    const slotsB = r.repository.nodesOf("b").map((node) => [node.nodeKey, node.slot]);

    r.serve("a", bodyOf("a1.example.org", "a9.example.org", "a8.example.org"));
    await r.sync.refresh("a", at(10));

    expect(r.repository.nodesOf("b").map((node) => [node.nodeKey, node.slot])).toEqual(slotsB);
    expect(new Set(r.repository.nodes.map((node) => node.slot)).size).toBe(r.repository.nodes.length);
    const ports = configOf(r).inbounds.map((inbound) => inbound.port);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it("одинаковый узел в A и B: два слота, два выхода, в переборе ссылки различаются", async () => {
    const r = rig();
    await r.add("a");
    await r.add("b");
    r.serve("a", bodyOf("shared.example.org"));
    r.serve("b", bodyOf("shared.example.org"));

    await r.sync.refresh("a", NOW);
    await r.sync.refresh("b", at(1));

    const key = r.nodeKeyOf("a", "shared.example.org");
    expect(r.nodeKeyOf("b", "shared.example.org")).toBe(key);
    expect(r.repository.nodes.map((node) => node.slot).sort()).toEqual([0, 1]);
    expect(outTags(configOf(r)).sort()).toEqual([`out-a-${key}`, `out-b-${key}`]);
    await healthy(r, () => 50);
    expect(r.routes.list(0).map((proxy) => proxy.id).sort()).toEqual([`node:a:${key}`, `node:b:${key}`]);
  });

  it("фильтр стран A (DE) на узлы B не действует", async () => {
    const r = rig();
    await r.add("a", { countries: ["DE"] });
    await r.add("b");
    r.serve("a", [nodeLink("a-de.example.org", "DE"), nodeLink("a-nl.example.org", "NL")].join("\n"));
    r.serve("b", [nodeLink("b-de.example.org", "DE"), nodeLink("b-nl.example.org", "NL")].join("\n"));
    await r.sync.refresh("a", NOW);
    await r.sync.refresh("b", at(1));
    await healthy(r, () => 50);

    const hosts = r.routes.list(0).map((proxy) => proxy.id);

    expect(hosts).toContain(`node:a:${r.nodeKeyOf("a", "a-de.example.org")}`);
    expect(hosts).not.toContain(`node:a:${r.nodeKeyOf("a", "a-nl.example.org")}`);
    expect(hosts).toContain(`node:b:${r.nodeKeyOf("b", "b-de.example.org")}`);
    expect(hosts).toContain(`node:b:${r.nodeKeyOf("b", "b-nl.example.org")}`);
  });

  it("candidates — на всю систему, а не на подписку; порт узла — база + его слот", async () => {
    const r = rig({ settings: { "proxy.subscription.candidates": 2 } });
    await r.add("a");
    await r.add("b");
    r.serve("a", bodyOf("a1.example.org", "a2.example.org"));
    r.serve("b", bodyOf("b1.example.org", "b2.example.org"));
    await r.sync.refresh("a", NOW);
    await r.sync.refresh("b", at(1));
    await healthy(r, (node) => (node.subscriptionKey === "b" ? 10 + node.slot : 100 + node.slot));

    const listed = r.routes.list(0);

    expect(listed.map((proxy) => proxy.id)).toEqual([`node:b:${r.nodeKeyOf("b", "b1.example.org")}`, `node:b:${r.nodeKeyOf("b", "b2.example.org")}`]);
    expect(listed.map((proxy) => proxy.port)).toEqual(r.repository.nodesOf("b").map((node) => BASE_PORT + node.slot));
    expect(new Set(listed.map((proxy) => proxy.priority)).size).toBe(2);
  });
});

describe("выключение подписки целиком", () => {
  it("выключение A: в конфиге только B, узлы A в базе со слотами; включение — A в конфиге без запроса к поставщику", async () => {
    const r = rig();
    await r.add("a");
    await r.add("b");
    r.serve("a", bodyOf("a1.example.org", "a2.example.org"));
    r.serve("b", bodyOf("b1.example.org"));
    await r.sync.refresh("a", NOW);
    await r.sync.refresh("b", at(1));
    const slotsA = r.repository.nodesOf("a").map((node) => [node.nodeKey, node.slot]);
    const fetches = r.fetch.mock.calls.length;
    await healthy(r, () => 50);

    await r.service.update(ACTOR, "a", { name: "Подписка a", countries: [], enabled: false }, at(100));

    expect(outTags(configOf(r))).toHaveLength(1);
    expect(outTags(configOf(r))[0]).toMatch(/^out-b-/);
    expect(r.repository.nodesOf("a").map((node) => [node.nodeKey, node.slot])).toEqual(slotsA);
    expect(r.routes.list(0).map((proxy) => proxy.id)).toEqual([`node:b:${r.nodeKeyOf("b", "b1.example.org")}`]);

    await r.service.update(ACTOR, "a", { name: "Подписка a", countries: [], enabled: true }, at(200));

    expect(outTags(configOf(r))).toHaveLength(3);
    expect(r.fetch.mock.calls.length).toBe(fetches);
    expect(r.repository.nodesOf("a").map((node) => [node.nodeKey, node.slot])).toEqual(slotsA);
    expect(r.routes.list(0).map((proxy) => proxy.id)).toContain(`node:a:${r.nodeKeyOf("a", "a1.example.org")}`);
  });

  it("выключенная подписка: обновление отвечает «выключена», тик её не трогает и узлы её не проверяются", async () => {
    const r = rig();
    await r.add("a", { enabled: false });
    r.serve("a", bodyOf("a1.example.org"));
    r.repository.nodes = [{ subscriptionKey: "a", nodeKey: "aaaa", slot: 0, protocol: "vless", name: "x", country: "DE", host: "x.example.org", state: "unknown", failures: 0, latencyMs: null, lastProbeAt: null, nextProbeAt: NOW }];

    expect(await r.sync.refresh("a", NOW)).toEqual({ status: "disabled" });
    await r.scheduler.tick(at(60));

    expect(r.fetch).not.toHaveBeenCalled();
    expect(r.proxyFetch).not.toHaveBeenCalled();
  });

  it("выключенная подписка держит свою долю входов: считаются все подписки", async () => {
    const r = rig({ slotCount: 4 });
    await r.add("a");
    await r.add("b", { enabled: false });
    r.serve("a", bodyOf("a1.example.org", "a2.example.org", "a3.example.org", "a4.example.org"));

    const result = await r.sync.refresh("a", NOW);

    expect(r.repository.nodesOf("a")).toHaveLength(2);
    expect(result).toMatchObject({ status: "ok" });
    expect(r.repository.rowOf("a")?.lastRefreshNote).toContain("Не хватило входов: 2 узла не подключены — на подписку приходится 2 входа; увеличьте XRAY_SLOT_COUNT или удалите лишние подписки");
  });
});

describe("доля входов и предел числа подписок", () => {
  it("XRAY_SLOT_COUNT = 4, у A 4 узла, создание B: у A остаются 2 (сняты не отвечающий и самый медленный), часть A переписана, B получает 2", async () => {
    const r = rig({ slotCount: 4 });
    await r.add("a");
    r.serve("a", bodyOf("n1.example.org", "n2.example.org", "n3.example.org", "n4.example.org"));
    await r.sync.refresh("a", NOW);
    expect(r.repository.nodesOf("a")).toHaveLength(4);
    const states: Record<string, Partial<StoredNode>> = {
      "n1.example.org": { state: "healthy", latencyMs: 40 },
      "n2.example.org": { state: "down", failures: 5, latencyMs: null },
      "n3.example.org": { state: "healthy", latencyMs: 300 },
      "n4.example.org": { state: "healthy", latencyMs: 90 },
    };
    r.repository.nodes = r.repository.nodes.map((node) => ({ ...node, ...states[node.host] }));
    const slotOf = (host: string): number => r.repository.nodesOf("a").find((node) => node.host === host)?.slot ?? -1;
    const keepSlots = [slotOf("n1.example.org"), slotOf("n4.example.org")];

    r.serve("b", bodyOf("m1.example.org", "m2.example.org", "m3.example.org", "m4.example.org"));
    await r.service.create(ACTOR, { name: "Вторая", url: urlOf("b"), countries: [], enabled: true }, at(10));

    expect(r.repository.nodesOf("a").map((node) => node.host).sort()).toEqual(["n1.example.org", "n4.example.org"]);
    expect(r.repository.nodesOf("a").map((node) => node.slot).sort()).toEqual([...keepSlots].sort());
    expect(r.writer.parts.get("a")?.nodes.map((entry) => entry.node.host).sort()).toEqual(["n1.example.org", "n4.example.org"]);
    expect(configOf(r).inbounds).toHaveLength(2);

    const second = r.repository.rows.find((row) => row.key !== "a");
    if (second === undefined) throw new Error("вторая подписка не создана");
    const result = await r.sync.refresh(second.key, at(20));

    expect(r.repository.nodesOf(second.key)).toHaveLength(2);
    expect(new Set(r.repository.nodes.map((node) => node.slot)).size).toBe(4);
    expect(result).toMatchObject({ status: "ok" });
    expect(r.repository.rowOf(second.key)).toMatchObject({ lastRefreshOk: false });
    expect(r.repository.rowOf(second.key)?.lastRefreshNote).toContain("Не хватило входов: 2 узла не подключены — на подписку приходится 2 входа");
    expect(configOf(r).inbounds).toHaveLength(4);
  });

  it("создание: узлы других подписок в пределах доли не трогаются", async () => {
    const r = rig({ slotCount: 8 });
    await r.add("a");
    r.serve("a", bodyOf("n1.example.org", "n2.example.org", "n3.example.org"));
    await r.sync.refresh("a", NOW);
    const before = structuredClone(r.repository.nodesOf("a"));

    await r.service.create(ACTOR, { name: "Вторая", url: urlOf("b"), countries: [], enabled: true }, at(10));

    expect(r.repository.nodesOf("a")).toEqual(before);
  });

  it("11-я подписка — SubscriptionLimitError (409, «Подписок уже 10…»), строка не записана", async () => {
    const r = rig({ slotCount: 100 });
    for (let index = 0; index < SUBSCRIPTIONS_MAX; index += 1) await r.add(`s${String(index)}`);

    const error = await r.service.create(ACTOR, { name: "Лишняя", url: urlOf("extra"), countries: [], enabled: true }, at(10)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SubscriptionLimitError);
    expect(error).toMatchObject({ status: 409, code: "proxy_subscription_limit", message: "Подписок уже 10 — удалите лишнюю, чтобы добавить новую" });
    expect(r.repository.rows).toHaveLength(SUBSCRIPTIONS_MAX);
    expect(r.audit).not.toHaveBeenCalled();
  });

  it("после удаления одной места снова хватает", async () => {
    const r = rig({ slotCount: 100 });
    for (let index = 0; index < SUBSCRIPTIONS_MAX; index += 1) await r.add(`s${String(index)}`);
    await r.service.remove(ACTOR, "s3");

    await r.service.create(ACTOR, { name: "Новая", url: urlOf("extra"), countries: [], enabled: true }, at(10));

    expect(r.repository.rows).toHaveLength(SUBSCRIPTIONS_MAX);
  });

  it("обзор: подписки по порядку создания, предел, входы и доля; адреса и секретов узлов нет", async () => {
    const r = rig({ slotCount: 12 });
    await r.add("late", { createdAt: at(50) });
    await r.add("early", { createdAt: at(5) });
    r.serve("early", bodyOf("e1.example.org"));
    await r.sync.refresh("early", NOW);

    const overview = await r.service.list(ACTOR);

    expect(overview).toMatchObject({ encryption: true, sidecar: { connected: true }, limit: 10, slotCount: 12, slotQuota: 6 });
    expect(overview.subscriptions.map((entry) => entry.key)).toEqual(["early", "late"]);
    expect(overview.subscriptions[0]?.nodes).toHaveLength(1);
    expect(JSON.stringify(overview)).not.toMatch(SECRET_PATTERN);
    expect(JSON.stringify(overview)).not.toContain(UUID);
  });
});

describe("всё, что меняет конфиг, — под общим замком", () => {
  async function seeded(): Promise<Rig> {
    const r = rig();
    await r.add("a");
    r.serve("a", bodyOf("a1.example.org", "a2.example.org"));
    await r.sync.refresh("a", NOW);
    r.redis.values.clear();
    return r;
  }

  it("замок занят: создание, смена enabled и удаление — SubscriptionBusyError, база и том не тронуты", async () => {
    const r = await seeded();
    const before = { rows: structuredClone(r.repository.rows), nodes: structuredClone(r.repository.nodes), parts: structuredClone([...r.writer.parts]), configs: r.writer.written.length };
    r.redis.hold(LOCK_KEY);

    const outcomes = await Promise.all([
      r.service.create(ACTOR, { name: "Новая", url: urlOf("b"), countries: [], enabled: true }, at(10)).catch((caught: unknown) => caught),
      r.service.update(ACTOR, "a", { name: "Подписка a", countries: [], enabled: false }, at(10)).catch((caught: unknown) => caught),
      r.service.update(ACTOR, "a", { name: "Подписка a", url: urlOf("new"), countries: [], enabled: true }, at(10)).catch((caught: unknown) => caught),
      r.service.remove(ACTOR, "a").catch((caught: unknown) => caught),
    ]);

    for (const outcome of outcomes) {
      expect(outcome).toBeInstanceOf(SubscriptionBusyError);
      expect(outcome).toMatchObject({ status: 409, message: "Подписки сейчас обновляются на сервере — повторите через минуту" });
    }
    expect(r.repository.rows).toEqual(before.rows);
    expect(r.repository.nodes).toEqual(before.nodes);
    expect([...r.writer.parts]).toEqual(before.parts);
    expect(r.writer.written).toHaveLength(before.configs);
    expect(r.audit).not.toHaveBeenCalled();
  });

  it("правка названия и стран конфиг не меняет и замка не ждёт", async () => {
    const r = await seeded();
    r.redis.hold(LOCK_KEY);

    await r.service.update(ACTOR, "a", { name: "Другое имя", countries: ["NL"], enabled: true }, at(10));

    expect(r.repository.rowOf("a")).toMatchObject({ name: "Другое имя", countries: ["NL"] });
  });

  it("создание берёт замок и снимает его; следующее действие проходит", async () => {
    const r = await seeded();

    await r.service.create(ACTOR, { name: "Новая", url: urlOf("b"), countries: [], enabled: true }, at(10));

    expect(r.redis.values.has(LOCK_KEY)).toBe(false);
    await r.service.remove(ACTOR, "a");
    expect(r.redis.values.has(LOCK_KEY)).toBe(false);
  });

  it("запись конфига при включении не удалась: включение откатывается, ошибка наверх", async () => {
    const r = await seeded();
    await r.service.update(ACTOR, "a", { name: "Подписка a", countries: [], enabled: false }, at(10));
    r.writer.write = async () => {
      throw new Error("диск переполнен");
    };

    await expect(r.service.update(ACTOR, "a", { name: "Подписка a", countries: [], enabled: true }, at(20))).rejects.toThrow("диск переполнен");

    expect(r.repository.rowOf("a")?.enabled).toBe(false);
    expect(r.redis.values.has(LOCK_KEY)).toBe(false);
  });

  it("запись конфига при создании со снятием узлов не удалась: ни строки, ни снятых узлов в базе", async () => {
    const r = rig({ slotCount: 4 });
    await r.add("a");
    r.serve("a", bodyOf("n1.example.org", "n2.example.org", "n3.example.org", "n4.example.org"));
    await r.sync.refresh("a", NOW);
    r.writer.write = async () => {
      throw new Error("диск переполнен");
    };

    await expect(r.service.create(ACTOR, { name: "Вторая", url: urlOf("b"), countries: [], enabled: true }, at(10))).rejects.toThrow("диск переполнен");

    expect(r.repository.rows.map((row) => row.key)).toEqual(["a"]);
    expect(r.repository.nodesOf("a")).toHaveLength(4);
    // Часть A, уже переписанная до сбоя, возвращена: том и база снова говорят одно.
    expect(r.writer.parts.get("a")?.nodes).toHaveLength(4);
    expect(r.redis.values.has(LOCK_KEY)).toBe(false);
  });

  it("смена адреса: часть, узлы и входы прежнего адреса уходят из конфига, сброс итога; подписка остаётся", async () => {
    const r = await seeded();
    await r.add("b");
    r.serve("b", bodyOf("b1.example.org"));
    await r.sync.refresh("b", at(1));

    await r.service.update(ACTOR, "a", { name: "Подписка a", url: urlOf("a2"), countries: [], enabled: true }, at(50));

    expect(r.writer.parts.has("a")).toBe(false);
    expect(r.repository.nodesOf("a")).toEqual([]);
    expect(outTags(configOf(r))).toHaveLength(1);
    expect(outTags(configOf(r))[0]).toMatch(/^out-b-/);
    expect(r.repository.rowOf("a")).toMatchObject({ key: "a", lastRefreshAt: null, lastRefreshOk: null });
  });

  it("удаление A: часть A удалена, узлы каскадом, B в конфиге, аудит с ключом", async () => {
    const r = rig();
    await r.add("a");
    await r.add("b");
    r.serve("a", bodyOf("a1.example.org", "a2.example.org"));
    r.serve("b", bodyOf("b1.example.org", "b2.example.org"));
    await r.sync.refresh("a", NOW);
    await r.sync.refresh("b", at(1));

    await r.service.remove(ACTOR, "a");

    expect(r.writer.parts.has("a")).toBe(false);
    expect(r.writer.parts.has("b")).toBe(true);
    expect(r.repository.nodesOf("a")).toEqual([]);
    expect(r.repository.nodesOf("b")).toHaveLength(2);
    expect(outTags(configOf(r))).toHaveLength(2);
    expect(r.audit.mock.calls.map((call) => call[0])).toContainEqual(expect.objectContaining({ action: "proxy_subscription.delete", target: "a" }));
    await expect(r.service.remove(ACTOR, "a")).rejects.toBeInstanceOf(SubscriptionNotFoundError);
  });

  it("удаление последней подписки: конфиг без входов", async () => {
    const r = await seeded();
    await r.service.remove(ACTOR, "a");
    expect(configOf(r).inbounds).toEqual([]);
    expect(outTags(configOf(r))).toEqual([]);
  });

  it("действия над несуществующей подпиской — SubscriptionNotFoundError, замок снят", async () => {
    const r = rig();
    for (const action of [
      () => r.service.update(ACTOR, "nosuch", { name: "Х", countries: [], enabled: true }),
      () => r.service.remove(ACTOR, "nosuch"),
      () => r.service.refresh(ACTOR, "nosuch"),
      () => r.service.probe(ACTOR, "nosuch"),
    ]) {
      await expect(action()).rejects.toBeInstanceOf(SubscriptionNotFoundError);
    }
    expect(r.redis.values.size).toBe(0);
  });

  it("создание без адреса — отказ 400, строка не записана", async () => {
    const r = rig();
    await expect(r.service.create(ACTOR, { name: "Х", countries: [], enabled: true })).rejects.toMatchObject({ status: 400 });
    expect(r.repository.rows).toEqual([]);
  });

  it("аудит создания и правки — без адреса, с ключом подписки целью", async () => {
    const r = rig();
    r.serve("a", bodyOf("a1.example.org"));
    await r.service.create(ACTOR, { name: "Основная", url: urlOf("a"), countries: ["DE"], enabled: true }, at(1));
    const created = r.repository.rows[0];
    if (created === undefined) throw new Error("подписка не создана");
    await r.service.update(ACTOR, created.key, { name: "Основная", countries: ["DE"], enabled: false }, at(2));

    const entries = r.audit.mock.calls.map((call) => call[0] as { action: string; target: string });
    expect(entries.map((entry) => [entry.action, entry.target])).toEqual([
      ["proxy_subscription.save", created.key],
      ["proxy_subscription.save", created.key],
      ["proxy_subscription.toggle", created.key],
    ]);
    expect(JSON.stringify(entries)).not.toMatch(SECRET_PATTERN);
    expect(r.changed).toHaveBeenCalled();
  });
});

describe("кнопки «не чаще раза в минуту» — у каждой подписки свои", () => {
  it("«Обновить» A и сразу B — оба проходят; A дважды — второй 429", async () => {
    const r = rig();
    await r.add("a");
    await r.add("b");
    r.serve("a", bodyOf("a1.example.org"));
    r.serve("b", bodyOf("b1.example.org"));

    await r.service.refresh(ACTOR, "a", NOW);
    await r.service.refresh(ACTOR, "b", NOW);
    const error = await r.service.refresh(ACTOR, "a", at(5)).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 429, message: "Подождите минуту" });
    expect(r.fetch).toHaveBeenCalledTimes(2);
    expect([...r.redis.values.keys()].sort()).toEqual(["proxy-subscription:manual:refresh:a", "proxy-subscription:manual:refresh:b"]);
  });

  it("«Проверить узлы» — тоже по подпискам, метки отдельные от «Обновить»", async () => {
    const r = rig();
    await r.add("a");
    await r.add("b");
    await r.service.probe(ACTOR, "a", NOW);
    await r.service.probe(ACTOR, "b", NOW);
    await r.service.refresh(ACTOR, "a", NOW).catch(() => undefined);

    await expect(r.service.probe(ACTOR, "a", at(5))).rejects.toMatchObject({ status: 429 });
    expect(r.redis.values.has("proxy-subscription:manual:probe:a")).toBe(true);
    expect(r.redis.values.has("proxy-subscription:manual:probe:b")).toBe(true);
  });

  it("«Проверить узлы» ставит срок на сейчас только узлам этой подписки", async () => {
    const r = rig();
    await r.add("a");
    await r.add("b");
    const later = at(99_999);
    const row = (subscriptionKey: string, nodeKey: string, slot: number): StoredNode => ({ subscriptionKey, nodeKey, slot, protocol: "vless", name: nodeKey, country: "DE", host: `${nodeKey}.example.org`, state: "healthy", failures: 0, latencyMs: 10, lastProbeAt: NOW, nextProbeAt: later });
    r.repository.nodes = [row("a", "aaaa", 0), row("b", "bbbb", 1)];

    await r.service.probe(ACTOR, "a", at(10));

    expect(r.repository.nodes.find((node) => node.nodeKey === "aaaa")?.nextProbeAt).toEqual(at(10));
    expect(r.repository.nodes.find((node) => node.nodeKey === "bbbb")?.nextProbeAt).toEqual(later);
  });

  it("hwid у подписок разный: он выводится из ключа подписки", async () => {
    const r = rig();
    await r.add("a");
    await r.add("b");
    r.serve("a", bodyOf("a1.example.org"));
    r.serve("b", bodyOf("b1.example.org"));

    await r.sync.refresh("a", NOW);
    await r.sync.refresh("b", at(1));

    const hwid = (call: number): string | null => new Headers(r.fetch.mock.calls[call]?.[1]?.headers).get("x-hwid");
    expect(hwid(0)).toMatch(/^[0-9a-f]{32}$/);
    expect(hwid(1)).toMatch(/^[0-9a-f]{32}$/);
    expect(hwid(0)).not.toBe(hwid(1));
  });
});

describe("расписание по подпискам", () => {
  it("нет config.json, части есть: тик пересобирает конфиг без загрузки подписок", async () => {
    const r = rig();
    await r.add("a", { lastRefreshAt: NOW, lastRefreshOk: true });
    await r.add("b", { lastRefreshAt: NOW, lastRefreshOk: true });
    r.serve("a", bodyOf("a1.example.org", "a2.example.org"));
    r.serve("b", bodyOf("b1.example.org"));
    await r.sync.refresh("a", at(-100));
    await r.sync.refresh("b", at(-99));
    r.repository.rows = r.repository.rows.map((row) => ({ ...row, lastRefreshAt: NOW, lastRefreshOk: true }));
    const fetches = r.fetch.mock.calls.length;
    r.writer.fileExists = false;
    const written = r.writer.written.length;

    await r.scheduler.tick(at(60));

    expect(r.fetch.mock.calls.length).toBe(fetches);
    expect(r.writer.written).toHaveLength(written + 1);
    expect(r.writer.fileExists).toBe(true);
    expect(outTags(configOf(r))).toHaveLength(3);
    // Файл на месте: следующий тик конфиг не трогает.
    await r.scheduler.tick(at(120));
    expect(r.writer.written).toHaveLength(written + 1);
  });

  it("нет части включённой подписки: тик её обновляет, остальные не трогает", async () => {
    const r = rig();
    await r.add("a", { lastRefreshAt: NOW, lastRefreshOk: true });
    await r.add("b", { lastRefreshAt: NOW, lastRefreshOk: true });
    r.serve("a", bodyOf("a1.example.org"));
    r.serve("b", bodyOf("b1.example.org"));
    await r.sync.refresh("b", at(-10));
    r.repository.rows = r.repository.rows.map((row) => ({ ...row, lastRefreshAt: NOW, lastRefreshOk: true }));
    r.fetch.mockClear();

    await r.scheduler.tick(at(60));

    expect(r.fetch).toHaveBeenCalledTimes(1);
    expect(new URL(String(r.fetch.mock.calls[0]?.[0])).hostname).toBe(hostOf("a"));
    expect(r.writer.parts.has("a")).toBe(true);
  });

  it("за тик обновляется не больше трёх подписок, по порядку «дольше всех ждёт»", async () => {
    const r = rig({ slotCount: 100 });
    // Ждут давно — e (год назад), затем d, c, b; a никогда не обновлялась.
    await r.add("a");
    await r.add("b", { lastRefreshAt: at(-4 * 86_400), lastRefreshOk: true });
    await r.add("c", { lastRefreshAt: at(-5 * 86_400), lastRefreshOk: true });
    await r.add("d", { lastRefreshAt: at(-6 * 86_400), lastRefreshOk: true });
    await r.add("e", { lastRefreshAt: at(-365 * 86_400), lastRefreshOk: true });
    for (const key of ["a", "b", "c", "d", "e"]) r.serve(key, bodyOf(`${key}1.example.org`));
    const order = (): string[] => r.fetch.mock.calls.map((call) => new URL(String(call[0])).hostname.replace(/^sub-|\.example\.com$/g, ""));

    await r.scheduler.tick(NOW);
    expect(order()).toEqual(["a", "e", "d"]);

    await r.scheduler.tick(at(31));
    expect(order()).toEqual(["a", "e", "d", "c", "b"]);

    await r.scheduler.tick(at(62));
    expect(order()).toHaveLength(5);
  });

  it("после неудачи подписка ждёт 15 минут, даже если части нет; выключенные — никогда", async () => {
    const r = rig();
    await r.add("a", { lastRefreshAt: NOW, lastRefreshOk: false, lastRefreshNote: "Подписка пустая" });
    await r.add("off", { enabled: false });
    r.serve("a", bodyOf("a1.example.org"));
    r.serve("off", bodyOf("o1.example.org"));

    await r.scheduler.tick(at(120));
    expect(r.fetch).not.toHaveBeenCalled();
    await r.scheduler.tick(at(15 * 60 + 1));

    expect(r.fetch).toHaveBeenCalledTimes(1);
    expect(new URL(String(r.fetch.mock.calls[0]?.[0])).hostname).toBe(hostOf("a"));
  });

  it("замок у другой реплики: тик ничего не загружает", async () => {
    const r = rig();
    await r.add("a");
    r.serve("a", bodyOf("a1.example.org"));
    r.redis.hold(LOCK_KEY);

    await r.scheduler.tick(NOW);

    expect(r.fetch).not.toHaveBeenCalled();
    expect(r.repository.nodes).toEqual([]);
  });

  it("проверки узлов обеих подписок записываются каждой в свои строки", async () => {
    const r = rig();
    await r.add("a");
    await r.add("b");
    r.serve("a", bodyOf("a1.example.org", "a2.example.org"));
    r.serve("b", bodyOf("b1.example.org"));
    await r.scheduler.tick(NOW);
    expect(r.repository.nodes).toHaveLength(3);

    await r.scheduler.tick(at(40));

    expect(r.proxyFetch).toHaveBeenCalledTimes(3);
    expect(r.repository.nodesOf("a").map((node) => node.state)).toEqual(["healthy", "healthy"]);
    expect(r.repository.nodesOf("b").map((node) => node.state)).toEqual(["healthy"]);
    // Проверка идёт через вход спутника по слоту узла.
    const ports = r.proxyFetch.mock.calls.map((call) => call[0].port).sort();
    expect(ports).toEqual(r.repository.nodes.map((node) => BASE_PORT + node.slot).sort());
  });

  it("узел и вход проверки у одинакового узла в двух подписках — свои", async () => {
    const r = rig();
    await r.add("a");
    await r.add("b");
    r.serve("a", bodyOf("shared.example.org"));
    r.serve("b", bodyOf("shared.example.org"));
    await r.scheduler.tick(NOW);

    await r.scheduler.tick(at(40));

    expect(r.proxyFetch).toHaveBeenCalledTimes(2);
    expect(new Set(r.proxyFetch.mock.calls.map((call) => call[0].port)).size).toBe(2);
  });

  it("первый тик после выкатки: config.json есть, части исходной подписки нет — main обновляется сразу", async () => {
    const r = rig();
    await r.add("main", { lastRefreshAt: NOW, lastRefreshOk: true });
    r.serve("main", bodyOf("m1.example.org", "m2.example.org"));
    r.repository.nodes = [
      { subscriptionKey: "main", nodeKey: "aaaaaaaaaaaaaaaa", slot: 0, protocol: "vless", name: "x", country: "DE", host: "m1.example.org", state: "healthy", failures: 0, latencyMs: 40, lastProbeAt: NOW, nextProbeAt: at(300) },
    ];

    await r.scheduler.tick(at(60));

    expect(r.fetch).toHaveBeenCalledTimes(1);
    expect(r.writer.parts.has("main")).toBe(true);
    expect(r.repository.nodesOf("main")).toHaveLength(2);
  });
});

describe("сборка конфига и части в томе", () => {
  const part = (hosts: string[], firstSlot: number): ConfigPart => ({
    version: 1,
    nodes: hosts.map((host, index) => ({
      node: {
        key: `${String(firstSlot + index).padStart(2, "0")}${"0".repeat(14)}`,
        protocol: "vless",
        name: host,
        country: "DE",
        host,
        port: 443,
        secret: UUID,
        flow: null,
        cipher: null,
        transport: { network: "tcp" },
        security: { kind: "none" },
      },
      slot: firstSlot + index,
    })),
  });

  it("берёт части только включённых подписок; у кого части нет или она не читается — в списке missing", async () => {
    const r = rig();
    await r.add("a");
    await r.add("b");
    await r.add("c");
    await r.add("off", { enabled: false });
    await r.writer.writePart("a", part(["a1.example.org"], 0));
    await r.writer.writePart("b", part(["b1.example.org"], 1));
    await r.writer.writePart("off", part(["o1.example.org"], 2));
    r.writer.corrupted.add("b");

    const result = await assembleConfig({ repository: r.repository, writer: r.writer, xray: { basePort: BASE_PORT, slotCount: 12 } });

    expect([...result.missing].sort()).toEqual(["b", "c"]);
    expect(outTags(configOf(r))).toEqual([`out-a-${part(["a1.example.org"], 0).nodes[0]?.node.key}`]);
  });

  it("override подставляет переданную часть вместо файла", async () => {
    const r = rig();
    await r.add("a");
    await r.writer.writePart("a", part(["old.example.org"], 0));
    const fresh = part(["new1.example.org", "new2.example.org"], 4);

    const result = await assembleConfig({ repository: r.repository, writer: r.writer, xray: { basePort: BASE_PORT, slotCount: 12 } }, { key: "a", part: fresh });

    expect(result.missing).toEqual([]);
    expect(configOf(r).inbounds.map((inbound) => inbound.port)).toEqual([BASE_PORT + 4, BASE_PORT + 5]);
  });

  it("нет подписок — конфиг без входов; нет каталога тома — SidecarMissingError", async () => {
    const r = rig();
    await assembleConfig({ repository: r.repository, writer: r.writer, xray: { basePort: BASE_PORT, slotCount: 12 } });
    expect(configOf(r).inbounds).toEqual([]);

    r.writer.available_ = false;
    await expect(assembleConfig({ repository: r.repository, writer: r.writer, xray: { basePort: BASE_PORT, slotCount: 12 } })).rejects.toBeInstanceOf(SidecarMissingError);
  });

  it("слот части, не записанный в базу (сорвалась запись), чужая подписка не берёт", async () => {
    const r = rig({ slotCount: 12 });
    await r.add("a");
    await r.add("b");
    // У A в томе лежит узел в слоте 0, а в базе его нет — запись итога не прошла.
    await r.writer.writePart("a", part(["a1.example.org"], 0));
    r.serve("b", bodyOf("b1.example.org", "b2.example.org"));

    await r.sync.refresh("b", NOW);

    expect(r.repository.nodesOf("b").map((node) => node.slot).sort()).toEqual([1, 2]);
    expect(configOf(r).inbounds).toHaveLength(3);
  });

  it("часть не читается: подписка обновляется на тике, текст ошибки без секретов", async () => {
    const r = rig();
    await r.add("a", { lastRefreshAt: NOW, lastRefreshOk: true });
    r.serve("a", bodyOf("a1.example.org"));
    await r.sync.refresh("a", at(-10));
    r.repository.rows = r.repository.rows.map((row) => ({ ...row, lastRefreshAt: NOW, lastRefreshOk: true }));
    r.writer.corrupted.add("a");
    r.fail("a");

    await r.scheduler.tick(at(60));

    expect(r.fetch).toHaveBeenCalledTimes(2);
    const note = r.repository.rowOf("a")?.lastRefreshNote ?? "";
    expect(note).toBe("Поставщик ответил кодом 500");
    expect(note).not.toMatch(SECRET_PATTERN);
    expect(note).not.toContain(UUID);
  });

  describe("файлы на диске", () => {
    let dir: string | null = null;
    afterEach(async () => {
      if (dir !== null) await rm(dir, { recursive: true, force: true });
      dir = null;
    });
    const volume = async (): Promise<{ root: string; writer: FileConfigWriter }> => {
      dir = await mkdtemp(join(tmpdir(), "rubezh-xray-"));
      return { root: dir, writer: new FileConfigWriter(join(dir, "config.json")) };
    };

    it("часть пишется в subscriptions/<ключ>.json с правами 0600, каталог 0700, читается обратно тем же", async () => {
      const { root, writer } = await volume();
      const original = part(["a1.example.org", "a2.example.org"], 0);

      await writer.writePart("abc123", original);

      expect(await writer.readPart("abc123")).toEqual(original);
      const file = join(root, "subscriptions", "abc123.json");
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "subscriptions"))).mode & 0o777).toBe(0o700);
      // Временные файлы записи не остаются.
      expect(await readdir(join(root, "subscriptions"))).toEqual(["abc123.json"]);
    });

    it("перезапись заменяет часть целиком; удаление убирает файл и не падает на повторе", async () => {
      const { writer } = await volume();
      await writer.writePart("a", part(["old.example.org"], 0));
      await writer.writePart("a", part(["new.example.org"], 3));

      expect((await writer.readPart("a"))?.nodes.map((entry) => entry.node.host)).toEqual(["new.example.org"]);
      await writer.removePart("a");
      expect(await writer.readPart("a")).toBeNull();
      await expect(writer.removePart("a")).resolves.toBeUndefined();
    });

    it("нет файла, испорченный JSON, не по схеме, лишнее поле, чужая версия — null", async () => {
      const { root, writer } = await volume();
      await writer.writePart("seed", part(["x.example.org"], 0));
      const dirPath = join(root, "subscriptions");
      const valid = part(["x.example.org"], 0);
      const cases: Record<string, string> = {
        broken: "{ это не JSON",
        empty: "",
        notobject: "[1, 2, 3]",
        version: JSON.stringify({ ...valid, version: 2 }),
        extra: JSON.stringify({ ...valid, extra: true }),
        nodes: JSON.stringify({ version: 1, nodes: [{ node: { key: "x" }, slot: 0 }] }),
        slot: JSON.stringify({ version: 1, nodes: [{ ...valid.nodes[0], slot: -1 }] }),
      };
      for (const [name, text] of Object.entries(cases)) await writeFile(join(dirPath, `${name}.json`), text);

      expect(await writer.readPart("missing")).toBeNull();
      for (const name of Object.keys(cases)) expect(await writer.readPart(name), name).toBeNull();
      expect(await writer.readPart("seed")).toEqual(valid);
    });

    it("ключ не по формату — отказ до обращения к диску: выйти из каталога частей нельзя", async () => {
      const { root, writer } = await volume();
      for (const key of ["../config", "a/b", "A", "", "a".repeat(17), "a.json"]) {
        await expect(writer.writePart(key, part(["x.example.org"], 0)), key).rejects.toThrow();
        await expect(writer.readPart(key), key).rejects.toThrow();
        await expect(writer.removePart(key), key).rejects.toThrow();
      }
      await expect(stat(join(root, "config.json"))).rejects.toThrow();
    });

    it("нет каталога тома — SidecarMissingError, как у config.json", async () => {
      const writer = new FileConfigWriter(join(tmpdir(), "rubezh-нет-такого-каталога", "config.json"));
      await expect(writer.writePart("a", part(["x.example.org"], 0))).rejects.toBeInstanceOf(SidecarMissingError);
      expect(await writer.readPart("a")).toBeNull();
    });

    it("права на уже существующий каталог частей выравниваются: umask процесса их не срезает", async () => {
      const { root, writer } = await volume();
      await mkdir(join(root, "subscriptions"), { mode: 0o755 });
      await chmod(join(root, "subscriptions"), 0o755);

      await writer.writePart("a", part(["x.example.org"], 0));

      expect((await stat(join(root, "subscriptions"))).mode & 0o777).toBe(0o700);
    });
  });
});

describe("журнал запросов", () => {
  it("via узла — node:<ключ подписки>:<ключ узла>, не длиннее 38 знаков (колонка на 40)", async () => {
    const r = rig();
    const key = "a".repeat(16);
    await r.add(key);
    r.serve(key, bodyOf("a1.example.org"));
    await r.sync.refresh(key, NOW);
    await healthy(r, () => 40);
    const records: OutboundRecord[] = [];
    const proxyFetch = vi.fn<ProxyFetch>(async () => new Response("ok", { status: 200 }));
    const outbound = new Outbound({ write: (record) => void records.push(record) }, () => NOW, { list: () => r.routes.list(0), modeOf: () => "proxy_only" }, undefined, proxyFetch);

    await outbound.forService("fx.cbr")("https://api.example.com/rate");

    expect(records).toHaveLength(1);
    expect(records[0]?.via).toBe(`node:${key}:${r.nodeKeyOf(key, "a1.example.org")}`);
    expect(records[0]?.via.length).toBeLessThanOrEqual(38);
  });
});
