import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { ProxyRoutes } from "../src/modules/proxies/proxy-routes.service.js";
import { SubscriptionCommands } from "../src/modules/proxies/subscription/subscription-commands.js";
import { SubscriptionRoutes } from "../src/modules/proxies/subscription/subscription-routes.js";
import type { StoredNode, StoredSubscription } from "../src/modules/proxies/subscription/subscription.repository.js";
import { ProxySubscriptionService } from "../src/modules/proxies/subscription/subscription.service.js";
import { SubscriptionSync } from "../src/modules/proxies/subscription/subscription.sync.js";
import { SUBSCRIPTION_USER_AGENT, subscriptionHwid } from "../src/modules/proxies/subscription/subscription-download.js";
import { sealUrl } from "../src/modules/proxies/subscription/subscription-url.js";
import type { AccountRef, RolesService } from "../src/modules/roles/roles.service.js";
import { SecretCipher } from "../src/modules/secrets/secret-cipher.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryConfigWriter, MemoryLockRedis, MemorySubscriptionRepository } from "./helpers/memory-subscription.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Узлы и подписка в панели подробнее (docs/35-stage4-plan.md Р192, tasks/T-0385):
 * транспорт и безопасность узла из разбора, маршрутизация подписки из JSON-конфига
 * и заголовка `routing`, устройство у поставщика с отпечатком `x-hwid`. Подмены те
 * же, что в `proxy-subscription.test.ts`: сеть, DNS, том Xray, Redis и хранилище.
 */

const NOW = new Date("2026-11-02T12:00:00.000Z");
const LATER = new Date(NOW.getTime() + 3_600_000);
const URL_SECRET = "https://sub.example.com/api/v1/client/tok-9f8e7d6c5b4a?user=farm&key=SECRETKEY";
const UUID = "11111111-1111-4111-8111-111111111111";
const BASE_PORT = 10800;
const ACTOR: AccountRef = { accountId: "00000000-0000-4000-8000-000000000001", platform: "telegram", platformUserId: "700000" };

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const b64url = (text: string): string => b64(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const REALITY_VISION = `vless://${UUID}@r.example.org:443?type=tcp&security=reality&sni=www.example.com&fp=chrome&pbk=PUBLICKEY1&sid=ab12&flow=xtls-rprx-vision#%5BDE%5D%20reality`;
const WS_TLS = `vless://${UUID}@w.example.org:443?type=ws&security=tls&sni=w.example.org&path=%2Fws#%5BNL%5D%20ws`;
const SHADOWSOCKS = `ss://${b64url("aes-256-gcm:secret")}@s.example.org:8388#%5BFI%5D%20ss`;
const LINKS = [REALITY_VISION, WS_TLS, SHADOWSOCKS].join("\n");

/** Конфиг клиента панели: один узел, выходы direct (freedom) и block (blackhole), правила как переданы. */
const jsonBody = (rules: unknown[]): string =>
  JSON.stringify([
    {
      remarks: "[DE] json",
      outbounds: [
        { tag: "proxy", protocol: "vless", settings: { vnext: [{ address: "j.example.org", port: 443, users: [{ id: UUID, encryption: "none" }] }] }, streamSettings: { network: "tcp", security: "none" } },
        { tag: "direct", protocol: "freedom" },
        { tag: "block", protocol: "blackhole" },
      ],
      routing: { domainStrategy: "IPIfNonMatch", rules },
    },
  ]);

const HAPP_ROUTING = `happ://routing/onadd/${b64(JSON.stringify({ DirectSites: ["geosite:category-ru"], DirectIp: ["geoip:ru"], BlockSites: [] }))}`;

const answer = (body: string, headers: Record<string, string> = {}): Response => new Response(body, { status: 200, headers });

const cipher = (): SecretCipher => new SecretCipher([randomBytes(32).toString("base64")]);

interface Rig {
  repository: MemorySubscriptionRepository;
  cipher: SecretCipher;
  writer: MemoryConfigWriter;
  fetch: ReturnType<typeof vi.fn<typeof fetch>>;
  sync: SubscriptionSync;
  service: ProxySubscriptionService;
}

function rig(options: { body?: string; headers?: Record<string, string>; encryption?: boolean } = {}): Rig {
  const repository = new MemorySubscriptionRepository();
  const sealing = cipher();
  const routes = new SubscriptionRoutes({ repository, settings: panelSettings(), host: "xray", basePort: BASE_PORT });
  const writer = new MemoryConfigWriter();
  const redis = new MemoryLockRedis();
  const fetchMock = vi.fn<typeof fetch>(async () => answer(options.body ?? LINKS, options.headers));
  const xray = { basePort: BASE_PORT, slotCount: 8 };
  const sync = new SubscriptionSync({ repository, cipher: sealing, outbound: { forService: () => fetchMock }, resolve: async () => ["93.184.216.34"], writer, routes, redis, changed: async () => undefined, xray });
  const commands = new SubscriptionCommands({ repository, writer, sync, xray });
  const roles = { require: async () => undefined, audit: async () => undefined } as unknown as RolesService;
  const proxyRoutes = { changed: async () => undefined } as unknown as ProxyRoutes;
  const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, XRAY_SLOT_COUNT: "8" } as NodeJS.ProcessEnv);
  const service = new ProxySubscriptionService(repository, options.encryption === false ? null : sealing, roles, sync, commands, routes, writer, redis as unknown as Redis, proxyRoutes, config);
  return { repository, cipher: sealing, writer, fetch: fetchMock, sync, service };
}

function subscriptionRow(sealing: SecretCipher, patch: Partial<StoredSubscription> = {}): StoredSubscription {
  const key = patch.key ?? "main";
  return {
    key,
    name: "Основная",
    ...sealUrl(sealing, key, URL_SECRET),
    enabled: true,
    countries: [],
    lastRefreshAt: null,
    lastRefreshOk: null,
    lastRefreshNote: null,
    providerIntervalHours: null,
    trafficUsedBytes: null,
    trafficTotalBytes: null,
    expiresAt: null,
    routingSource: null,
    routingDirect: null,
    routingBlock: null,
    routingHints: [],
    updatedBy: ACTOR.accountId,
    updatedAt: NOW,
    createdAt: NOW,
    ...patch,
  };
}

async function seed(r: Rig, patch: Partial<StoredSubscription> = {}): Promise<void> {
  const row = subscriptionRow(r.cipher, patch);
  await r.repository.create(row);
  if (row.lastRefreshOk === true) await r.writer.writePart(row.key, { version: 1, nodes: [] });
}

const nodeOf = (r: Rig, host: string): StoredNode | undefined => r.repository.nodesOf("main").find((node) => node.host === host);

describe("транспорт и безопасность узла после обновления", () => {
  it("reality+vision, ws+tls и shadowsocks: network, security и flow из разбора лежат у узла", async () => {
    const r = rig();
    await seed(r);

    expect((await r.sync.refresh("main", NOW)).status).toBe("ok");

    expect(nodeOf(r, "r.example.org")).toMatchObject({ network: "tcp", security: "reality", flow: "xtls-rprx-vision" });
    expect(nodeOf(r, "w.example.org")).toMatchObject({ network: "ws", security: "tls", flow: null });
    expect(nodeOf(r, "s.example.org")).toMatchObject({ network: "tcp", security: "none", flow: null });
  });

  it("узел, уцелевший при обновлении, получает сведения заново, а итоги проверок сохраняет", async () => {
    const r = rig();
    await seed(r);
    await r.sync.refresh("main", NOW);
    const before = nodeOf(r, "w.example.org");
    if (before === undefined) throw new Error("узла нет");
    r.repository.nodes = r.repository.nodes.map((node) => (node.nodeKey === before.nodeKey ? { ...node, network: null, security: null, flow: null, state: "healthy", latencyMs: 40 } : node));

    await r.sync.refresh("main", LATER);

    expect(nodeOf(r, "w.example.org")).toMatchObject({ network: "ws", security: "tls", flow: null, state: "healthy", latencyMs: 40 });
  });

  it("в ответе панели у узла те же три поля", async () => {
    const r = rig();
    await seed(r);
    await r.sync.refresh("main", NOW);

    const { subscriptions } = await r.service.list(ACTOR);
    const nodes = subscriptions[0]?.nodes ?? [];
    expect(nodes.map((node) => [node.host, node.network, node.security, node.flow]).sort()).toEqual([
      ["r.example.org", "tcp", "reality", "xtls-rprx-vision"],
      ["s.example.org", "tcp", "none", null],
      ["w.example.org", "ws", "tls", null],
    ]);
  });

  it("узел, записанный до миграции (поля null), отдаётся с null, разбор не падает", async () => {
    const r = rig();
    await seed(r, { lastRefreshOk: true });
    r.repository.nodes = [
      {
        subscriptionKey: "main",
        nodeKey: "aaaaaaaaaaaaaaaa",
        slot: 0,
        protocol: "vless",
        name: "старый",
        country: "DE",
        host: "old.example.org",
        state: "healthy",
        failures: 0,
        latencyMs: 30,
        lastProbeAt: NOW,
        nextProbeAt: NOW,
        network: null,
        security: null,
        flow: null,
      },
    ];

    const { subscriptions } = await r.service.list(ACTOR);

    expect(subscriptions[0]?.nodes).toEqual([
      { nodeKey: "aaaaaaaaaaaaaaaa", name: "старый", protocol: "vless", country: "DE", host: "old.example.org", state: "healthy", latencyMs: 30, network: null, security: null, flow: null },
    ]);
  });
});

describe("маршрутизация подписки после обновления", () => {
  const toDirect = (entry: Record<string, unknown>): Record<string, unknown> => ({ type: "field", outboundTag: "direct", ...entry });
  const toBlock = (entry: Record<string, unknown>): Record<string, unknown> => ({ type: "field", outboundTag: "block", ...entry });

  it("JSON с правилами в direct и block: routing_source — json, числа и подсказки записаны", async () => {
    const r = rig({ body: jsonBody([toDirect({ domain: ["geosite:category-ru", "domain:example.com"], ip: ["geoip:ru"] }), toBlock({ domain: ["geosite:category-ads-all"] })]) });
    await seed(r);

    await r.sync.refresh("main", NOW);

    expect(r.repository.subscription).toMatchObject({ routingSource: "json", routingDirect: 3, routingBlock: 1, routingHints: ["geosite:category-ru", "geoip:ru"] });
  });

  it("ссылки и заголовок routing: header; заголовок читается как есть", async () => {
    const r = rig({ headers: { routing: HAPP_ROUTING } });
    await seed(r);

    await r.sync.refresh("main", NOW);

    expect(r.repository.subscription).toMatchObject({ routingSource: "header", routingDirect: 2, routingBlock: 0, routingHints: ["geosite:category-ru", "geoip:ru"] });
  });

  it("JSON и заголовок вместе: json+header, общая запись считается один раз", async () => {
    const r = rig({ body: jsonBody([toDirect({ domain: ["geosite:category-ru"] })]), headers: { routing: HAPP_ROUTING } });
    await seed(r);

    await r.sync.refresh("main", NOW);

    expect(r.repository.subscription).toMatchObject({ routingSource: "json+header", routingDirect: 2, routingBlock: 0, routingHints: ["geosite:category-ru", "geoip:ru"] });
  });

  it("заголовок не разобран: header, числа null — «есть, состав не разобран», обновление удачное", async () => {
    const r = rig({ headers: { routing: "happ://routing/add/!!!" } });
    await seed(r);

    const result = await r.sync.refresh("main", NOW);

    expect(result.status).toBe("ok");
    expect(r.repository.subscription).toMatchObject({ lastRefreshOk: true, routingSource: "header", routingDirect: null, routingBlock: null, routingHints: [] });
  });

  it("ни JSON-правил, ни заголовка: none, числа нули", async () => {
    const r = rig();
    await seed(r);

    await r.sync.refresh("main", NOW);

    expect(r.repository.subscription).toMatchObject({ routingSource: "none", routingDirect: 0, routingBlock: 0, routingHints: [] });
  });

  it("правила только в proxy и в балансировщик — не маршрутизация: none", async () => {
    const body = jsonBody([{ type: "field", outboundTag: "proxy", domain: ["geosite:google"] }, { type: "field", balancerTag: "lb", domain: ["geosite:netflix"] }]);
    const r = rig({ body });
    await seed(r);

    await r.sync.refresh("main", NOW);

    expect(r.repository.subscription?.routingSource).toBe("none");
  });

  it("следующее обновление перезаписывает прежнее: был заголовок, не стало — none", async () => {
    const r = rig({ headers: { routing: HAPP_ROUTING } });
    await seed(r);
    await r.sync.refresh("main", NOW);
    expect(r.repository.subscription?.routingSource).toBe("header");

    r.fetch.mockImplementation(async () => answer(LINKS));
    await r.sync.refresh("main", LATER);

    expect(r.repository.subscription).toMatchObject({ routingSource: "none", routingDirect: 0, routingBlock: 0, routingHints: [] });
  });

  it("неудачное обновление прежнее значение не трогает: ни маршрутизацию, ни узлы", async () => {
    const r = rig({ body: jsonBody([toDirect({ domain: ["geosite:category-ru"] })]) });
    await seed(r);
    await r.sync.refresh("main", NOW);
    const nodes = r.repository.nodesOf("main");
    expect(r.repository.subscription?.routingSource).toBe("json");

    r.fetch.mockImplementation(async () => new Response("ошибка", { status: 502 }));
    const failed = await r.sync.refresh("main", LATER);

    expect(failed.status).toBe("failed");
    expect(r.repository.subscription).toMatchObject({ lastRefreshOk: false, routingSource: "json", routingDirect: 1, routingBlock: 0, routingHints: ["geosite:category-ru"] });
    expect(r.repository.nodesOf("main")).toEqual(nodes);
  });

  it("в ответе панели: JSON — source и числа; подписка не обновлялась — routing: null", async () => {
    const r = rig({ body: jsonBody([toDirect({ domain: ["geosite:category-ru"] }), toBlock({ ip: ["1.2.3.4"] })]) });
    await seed(r);
    await seed(r, { key: "second", name: "Новая" });
    await r.sync.refresh("main", NOW);

    const { subscriptions } = await r.service.list(ACTOR);
    const byKey = new Map(subscriptions.map((entry) => [entry.key, entry]));

    expect(byKey.get("main")?.routing).toEqual({ source: "json", direct: 1, block: 1, hints: ["geosite:category-ru"] });
    expect(byKey.get("second")?.routing).toBeNull();
  });
});

describe("устройство у поставщика в ответе панели", () => {
  /** `x-hwid`, с которым подписка ушла к поставщику. */
  const sentHwid = (r: Rig): string => new Headers(r.fetch.mock.calls[0]?.[1]?.headers).get("x-hwid") ?? "";

  it("одно устройство; отпечаток — первые 8 знаков x-hwid, ушедшего поставщику; os и User-Agent те же, что в запросе", async () => {
    const r = rig();
    await seed(r);
    await r.sync.refresh("main", NOW);

    const { subscriptions } = await r.service.list(ACTOR);
    const device = subscriptions[0]?.device;

    expect(device).toEqual({ count: 1, hwidPrefix: sentHwid(r).slice(0, 8), os: "Linux", userAgent: SUBSCRIPTION_USER_AGENT });
    expect(device?.hwidPrefix).toMatch(/^[0-9a-f]{8}$/);
    expect(sentHwid(r)).toMatch(/^[0-9a-f]{32}$/);
    expect(sentHwid(r).startsWith(device?.hwidPrefix ?? "?")).toBe(true);
    expect(new Headers(r.fetch.mock.calls[0]?.[1]?.headers).get("x-device-os")).toBe(device?.os);
  });

  it("отпечаток считается и до первого обновления, и у каждой подписки свой", async () => {
    const r = rig();
    await seed(r);
    await seed(r, { key: "second", name: "Вторая" });

    const { subscriptions } = await r.service.list(ACTOR);
    const prefixes = subscriptions.map((entry) => entry.device.hwidPrefix);

    expect(prefixes).toEqual([subscriptionHwid(r.cipher, "main").slice(0, 8), subscriptionHwid(r.cipher, "second").slice(0, 8)]);
    expect(new Set(prefixes).size).toBe(2);
  });

  it("в JSON ответа нет полного x-hwid, адреса подписки и ключа шифрования", async () => {
    const r = rig();
    await seed(r);
    await r.sync.refresh("main", NOW);

    const text = JSON.stringify(await r.service.list(ACTOR));

    expect(text).not.toContain(sentHwid(r));
    expect(text).not.toMatch(/[0-9a-f]{32}/);
    expect(text).not.toMatch(/tok-9f8e7d6c5b4a|SECRETKEY|sub\.example\.com\/api/);
  });

  it("без ключа шифрования отпечатка нет, но «1 устройство» и сведения запроса есть", async () => {
    const r = rig({ encryption: false });
    await seed(r);

    const { subscriptions, encryption } = await r.service.list(ACTOR);

    expect(encryption).toBe(false);
    expect(subscriptions[0]?.device).toEqual({ count: 1, hwidPrefix: null, os: "Linux", userAgent: SUBSCRIPTION_USER_AGENT });
  });
});
