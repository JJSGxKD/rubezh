import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkipReason, SkippedLink } from "@bh/proxy-kit";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { Outbound, type OutboundRecord } from "../src/infra/outbound/outbound.js";
import { safePath } from "../src/infra/outbound/outbound-path.js";
import { OUTBOUND_PROXY_FETCH, defaultModeOf, type OutboundProxy, type ProxyFetch } from "../src/infra/outbound/outbound-route.js";
import { OUTBOUND_SERVICES } from "../src/infra/outbound/outbound-services.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminProxySubscriptionController } from "../src/modules/admin/admin-proxy-subscription.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PROXIES_REPOSITORY, type ProxiesRepository, type StoredProxy } from "../src/modules/proxies/proxies.repository.js";
import { PROXY_CIPHER } from "../src/modules/proxies/proxy-password.js";
import { ProxyRoutes } from "../src/modules/proxies/proxy-routes.service.js";
import { SubscriptionRoutes } from "../src/modules/proxies/subscription/subscription-routes.js";
import { SUBSCRIPTION_REPOSITORY, type StoredNode, type StoredSubscription } from "../src/modules/proxies/subscription/subscription.repository.js";
import { SubscriptionScheduler } from "../src/modules/proxies/subscription/subscription.scheduler.js";
import { ProxySubscriptionService } from "../src/modules/proxies/subscription/subscription.service.js";
import { noNodesNote } from "../src/modules/proxies/subscription/subscription.messages.js";
import { SubscriptionSync } from "../src/modules/proxies/subscription/subscription.sync.js";
import { SUBSCRIPTION_USER_AGENT, subscriptionHwid } from "../src/modules/proxies/subscription/subscription-download.js";
import { sealUrl } from "../src/modules/proxies/subscription/subscription-url.js";
import { CONFIG_WRITER, SidecarMissingError } from "../src/modules/proxies/subscription/xray-config-writer.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { SecretCipher } from "../src/modules/secrets/secret-cipher.js";
import type { SettingValue } from "../src/modules/settings/setting-catalog.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryConfigWriter, MemoryLockRedis, MemorySubscriptionRepository } from "./helpers/memory-subscription.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Подписка Xray для прокси (docs/35-stage4-plan.md Р101, tasks/T-0093):
 * обновление с защитой от SSRF и от сбоя поставщика, слоты узлов, выдача узлов
 * клиенту исходящих, расписание проверок и панель по HTTP. Сеть, DNS, файл
 * конфига, Redis и хранилище — подмены.
 */

const NOW = new Date("2026-11-02T12:00:00.000Z");
const URL_SECRET = "https://sub.example.com/api/v1/client/tok-9f8e7d6c5b4a?user=farm&key=SECRETKEY";
const UUID = "11111111-1111-4111-8111-111111111111";
const PUBLIC_IP = "93.184.216.34";
const BASE_PORT = 10800;

const cipher = (): SecretCipher => new SecretCipher([randomBytes(32).toString("base64")]);

/** Ссылка узла: хост различает ключи, имя задаёт страну (флаг или `[XX]`). */
const nodeLink = (index: number, name = `[DE] Узел ${String(index)}`): string =>
  `vless://${UUID}@n${String(index)}.example.org:443?type=ws&security=tls&sni=n${String(index)}.example.org&path=%2Fws#${encodeURIComponent(name)}`;
const HYSTERIA = "hysteria2://secret@h.example.org:443#hy";
const bodyOf = (...lines: string[]): string => lines.join("\n");
/** Ссылки, которые разбор пропускает: транспорт kcp, неподдерживаемый параметр безопасности, битый uuid. */
const SKIPPED_TRANSPORT = `vless://${UUID}@k.example.org:443?type=kcp#kcp`;
const SKIPPED_OPTION = `vless://${UUID}@o.example.org:443?type=ws&security=tls&ech=abc#ech`;
const SKIPPED_MALFORMED = "vless://not-a-uuid@m.example.org:443?type=ws#bad";

const answer = (body: string, init: ResponseInit = {}): Response => new Response(body, { status: 200, ...init });

interface Rig {
  repository: MemorySubscriptionRepository;
  cipher: SecretCipher;
  routes: SubscriptionRoutes;
  writer: MemoryConfigWriter;
  redis: MemoryLockRedis;
  settings: ReturnType<typeof panelSettings>;
  fetch: ReturnType<typeof vi.fn<typeof fetch>>;
  resolve: ReturnType<typeof vi.fn<(host: string) => Promise<string[]>>>;
  changed: ReturnType<typeof vi.fn<() => Promise<void>>>;
  sync: SubscriptionSync;
}

function rig(options: { slotCount?: number; settings?: Record<string, SettingValue> } = {}): Rig {
  const repository = new MemorySubscriptionRepository();
  const sealing = cipher();
  const settings = panelSettings(options.settings);
  const routes = new SubscriptionRoutes({ repository, settings, host: "xray", basePort: BASE_PORT });
  const writer = new MemoryConfigWriter();
  const redis = new MemoryLockRedis();
  const fetchMock = vi.fn<typeof fetch>(async () => answer(bodyOf(nodeLink(1), nodeLink(2), nodeLink(3), HYSTERIA)));
  const resolve = vi.fn<(host: string) => Promise<string[]>>(async () => [PUBLIC_IP]);
  const changed = vi.fn<() => Promise<void>>(async () => undefined);
  const sync = new SubscriptionSync({
    repository,
    cipher: sealing,
    outbound: { forService: () => fetchMock },
    resolve,
    writer,
    routes,
    redis,
    changed,
    xray: { basePort: BASE_PORT, slotCount: options.slotCount ?? 8 },
  });
  return { repository, cipher: sealing, routes, writer, redis, settings, fetch: fetchMock, resolve, changed, sync };
}

function subscriptionRow(sealing: SecretCipher, patch: Partial<StoredSubscription> = {}, url = URL_SECRET): StoredSubscription {
  return {
    key: "main",
    name: "Основная",
    ...sealUrl(sealing, "main", url),
    enabled: true,
    countries: [],
    lastRefreshAt: null,
    lastRefreshOk: null,
    lastRefreshNote: null,
    providerIntervalHours: null,
    trafficUsedBytes: null,
    trafficTotalBytes: null,
    expiresAt: null,
    updatedBy: "00000000-0000-4000-8000-000000000001",
    updatedAt: NOW,
    ...patch,
  };
}

async function seed(r: Rig, patch: Partial<StoredSubscription> = {}, url = URL_SECRET): Promise<void> {
  await r.repository.save(subscriptionRow(r.cipher, patch, url));
}

const nodeRow = (key: string, slot: number, patch: Partial<StoredNode> = {}): StoredNode => ({
  subscriptionKey: "main",
  nodeKey: key,
  slot,
  protocol: "vless",
  name: `[DE] ${key}`,
  country: "DE",
  host: `${key}.example.org`,
  state: "unknown",
  failures: 0,
  latencyMs: null,
  lastProbeAt: null,
  nextProbeAt: NOW,
  ...patch,
});

describe("обновление подписки", () => {
  it("три узла и один hysteria2: конфиг с тремя входами, узлы неизвестны, в заметке пропущенный", async () => {
    const r = rig();
    await seed(r);

    const result = await r.sync.refresh(NOW);

    expect(result).toEqual({ status: "ok", note: "3 узла, пропущено 1 (протокол: 1)" });
    const config = r.writer.last as { inbounds: { port: number; listen: string; protocol: string }[] };
    expect(config.inbounds.map((inbound) => inbound.port)).toEqual([10800, 10801, 10802]);
    // Внутри сети tunnel вход слушает на всех интерфейсах: API живёт в другом контейнере; наружу порт не публикуется.
    expect(new Set(config.inbounds.map((inbound) => inbound.listen))).toEqual(new Set(["0.0.0.0"]));
    expect(r.repository.nodes.map((node) => [node.slot, node.state])).toEqual([
      [0, "unknown"],
      [1, "unknown"],
      [2, "unknown"],
    ]);
    expect(r.repository.subscription).toMatchObject({ lastRefreshOk: true, lastRefreshNote: "3 узла, пропущено 1 (протокол: 1)", lastRefreshAt: NOW });
    expect(r.changed).toHaveBeenCalled();
  });

  it("трафик, срок и интервал поставщика из заголовков сохраняются", async () => {
    const r = rig();
    await seed(r);
    r.fetch.mockResolvedValueOnce(
      answer(bodyOf(nodeLink(1)), { headers: { "subscription-userinfo": "upload=1; download=2; total=1000; expire=1795000000", "profile-update-interval": "12" } }),
    );

    await r.sync.refresh(NOW);

    expect(r.repository.subscription).toMatchObject({ trafficUsedBytes: 3n, trafficTotalBytes: 1000n, providerIntervalHours: 12 });
    expect(r.repository.subscription?.expiresAt?.getTime()).toBe(1795000000 * 1000);
  });

  it("JSON-подписка: массив конфигов Xray даёт узлы, служебные выходы не считаются пропущенными", async () => {
    const r = rig();
    await seed(r);
    const config = (remarks: string, host: string): unknown => ({
      remarks,
      outbounds: [
        {
          tag: "proxy",
          protocol: "vless",
          settings: { vnext: [{ address: host, port: 443, users: [{ id: UUID, encryption: "none" }] }] },
          streamSettings: { network: "ws", security: "tls", tlsSettings: { serverName: host }, wsSettings: { path: "/ws" } },
        },
        { tag: "direct", protocol: "freedom" },
        { tag: "block", protocol: "blackhole" },
      ],
    });
    r.fetch.mockResolvedValueOnce(answer(JSON.stringify([config("[DE] Берлин", "de.example.org"), config("[NL] Амстердам", "nl.example.org")])));

    const result = await r.sync.refresh(NOW);

    expect(result).toEqual({ status: "ok", note: "2 узла" });
    expect(r.repository.nodes.map((node) => [node.name, node.country, node.host])).toEqual([
      ["[DE] Берлин", "DE", "de.example.org"],
      ["[NL] Амстердам", "NL", "nl.example.org"],
    ]);
  });

  describe("заголовки запроса подписки", () => {
    const headersOf = (r: Rig, call = 0): Headers => new Headers(r.fetch.mock.calls[call]?.[1]?.headers);

    it("User-Agent v2rayN/7.0, x-device-os: Linux и x-hwid из 32 hex; адреса подписки в заголовках нет", async () => {
      const r = rig();
      await seed(r);
      await r.sync.refresh(NOW);

      const headers = headersOf(r);
      expect(headers.get("user-agent")).toBe(SUBSCRIPTION_USER_AGENT);
      expect(SUBSCRIPTION_USER_AGENT).toBe("v2rayN/7.0");
      expect(headers.get("x-device-os")).toBe("Linux");
      expect(headers.get("x-hwid")).toMatch(/^[0-9a-f]{32}$/);
      const all: string[] = [];
      headers.forEach((value, name) => all.push(`${name}: ${value}`));
      expect(all.join(" | ")).not.toMatch(/tok-9f8e7d6c5b4a|SECRETKEY|sub\.example\.com/);
    });

    it("hwid постоянный: каждое обновление подписки приходит с одним и тем же", async () => {
      const r = rig();
      await seed(r);
      await r.sync.refresh(NOW);
      await r.sync.refresh(new Date(NOW.getTime() + 3_600_000));

      expect(r.fetch).toHaveBeenCalledTimes(2);
      expect(headersOf(r, 1).get("x-hwid")).toBe(headersOf(r, 0).get("x-hwid"));
    });

    it("смена адреса подписки hwid не меняет: устройство то же, лимит устройств у поставщика не растёт", async () => {
      const r = rig();
      await seed(r);
      await r.sync.refresh(NOW);
      await seed(r, {}, "https://other.example.net/sub/NEW-TOKEN");
      await r.sync.refresh(new Date(NOW.getTime() + 3_600_000));

      expect(headersOf(r, 1).get("x-hwid")).toBe(headersOf(r, 0).get("x-hwid"));
    });

    it("hwid зависит от ключа подписки и от ключа шифрования; при смене ключа берётся текущий", () => {
      const key = randomBytes(32).toString("base64");
      const same = subscriptionHwid(new SecretCipher([key]), "main");

      expect(same).toMatch(/^[0-9a-f]{32}$/);
      expect(subscriptionHwid(new SecretCipher([key]), "main")).toBe(same);
      expect(subscriptionHwid(new SecretCipher([key, randomBytes(32).toString("base64")]), "main")).toBe(same);
      expect(subscriptionHwid(new SecretCipher([key]), "second")).not.toBe(same);
      expect(subscriptionHwid(new SecretCipher([randomBytes(32).toString("base64")]), "main")).not.toBe(same);
    });
  });

  const FAILURES: [string, () => Response | Promise<Response>, string][] = [
    ["HTTP 500", () => new Response("сбой", { status: 500 }), "Поставщик ответил кодом 500"],
    ["формат Clash", () => answer("proxies:\n  - name: a\n    type: vless\n"), "Формат подписки не поддерживается: нужен список ссылок (base64 или текст) или JSON-конфиг Xray"],
    ["пустое тело", () => answer(""), "Подписка пустая"],
    ["только неподдерживаемые узлы", () => answer(bodyOf(HYSTERIA, HYSTERIA)), "В подписке нет подходящих узлов: пропущено 2 (протокол: 2)"],
    ["все узлы отсеяны по разным причинам", () => answer(bodyOf(HYSTERIA, HYSTERIA, SKIPPED_TRANSPORT, SKIPPED_OPTION, SKIPPED_MALFORMED)), "В подписке нет подходящих узлов: пропущено 5 (протокол: 2, транспорт: 1, параметры: 1, ссылка: 1)"],
    ["сеть упала", () => Promise.reject(new TypeError("fetch failed")), "Не удалось связаться с поставщиком"],
    ["слишком большой ответ", () => answer("x", { headers: { "content-length": String(3 * 1024 * 1024) } }), "Ответ поставщика больше 2 МБ"],
  ];

  for (const [name, respond, note] of FAILURES) {
    it(`${name}: прежние узлы и конфиг на месте, заметка без адреса подписки`, async () => {
      const r = rig();
      await seed(r);
      await r.sync.refresh(NOW);
      const before = { nodes: structuredClone(r.repository.nodes), writes: r.writer.written.length, refreshWrites: r.repository.refreshWrites };
      r.fetch.mockImplementation(async () => respond());

      const later = new Date(NOW.getTime() + 3_600_000);
      const result = await r.sync.refresh(later);

      expect(result).toEqual({ status: "failed", note });
      expect(r.repository.nodes).toEqual(before.nodes);
      expect(r.writer.written).toHaveLength(before.writes);
      expect(r.repository.refreshWrites).toBe(before.refreshWrites);
      expect(r.repository.subscription).toMatchObject({ lastRefreshOk: false, lastRefreshNote: note, lastRefreshAt: later });
      expect(JSON.stringify(r.repository.subscription?.lastRefreshNote)).not.toMatch(/tok-9f8e7d6c5b4a|SECRETKEY|sub\.example\.com/);
    });
  }

  describe("заметка о подписке без подходящих узлов", () => {
    const skip = (reason: SkipReason, count: number): SkippedLink[] => Array.from({ length: count }, (_, index) => ({ index, scheme: "vless", reason, detail: "x" }));

    it("причины идут в порядке словаря, числа складываются в общее", () => {
      expect(noNodesNote([...skip("unsupported_option", 3), ...skip("unsupported_scheme", 9)])).toBe("В подписке нет подходящих узлов: пропущено 12 (протокол: 9, параметры: 3)");
    });

    it("ничего не пропущено — без разбивки", () => {
      expect(noNodesNote([])).toBe("В подписке нет подходящих узлов");
    });

    it("разбивка не выходит за предел колонки", () => {
      expect(noNodesNote(skip("malformed", 100_000)).length).toBeLessThanOrEqual(300);
    });
  });

  describe("защита от SSRF", () => {
    const NOT_ALLOWED = "Адрес подписки не подходит: нужен публичный https-адрес";

    for (const url of ["https://10.0.0.5/s", "https://redis/s", "http://sub.example.com/s", "https://user:pass@sub.example.com/s"]) {
      it(`${url}: отказ, запрос к цели не сделан`, async () => {
        const r = rig();
        await seed(r, {}, url);

        const result = await r.sync.refresh(NOW);

        expect(result).toEqual({ status: "failed", note: NOT_ALLOWED });
        expect(r.fetch).not.toHaveBeenCalled();
      });
    }

    it("имя отвечает закрытым адресом (127.0.0.1): отказ до запроса", async () => {
      const r = rig();
      await seed(r);
      r.resolve.mockResolvedValue(["127.0.0.1"]);

      expect(await r.sync.refresh(NOW)).toEqual({ status: "failed", note: NOT_ALLOWED });
      expect(r.fetch).not.toHaveBeenCalled();
    });

    it("хотя бы один из адресов закрытый: отказ", async () => {
      const r = rig();
      await seed(r);
      r.resolve.mockResolvedValue([PUBLIC_IP, "10.1.2.3"]);

      expect(await r.sync.refresh(NOW)).toEqual({ status: "failed", note: NOT_ALLOWED });
      expect(r.fetch).not.toHaveBeenCalled();
    });

    it("имя не резолвится: отказ, а не ошибка сервера", async () => {
      const r = rig();
      await seed(r);
      r.resolve.mockRejectedValue(new Error("ENOTFOUND"));

      expect(await r.sync.refresh(NOW)).toEqual({ status: "failed", note: NOT_ALLOWED });
    });

    it("переход на закрытый адрес: второй запрос не уходит, нужен был только первый", async () => {
      const r = rig();
      await seed(r);
      r.resolve.mockImplementation(async (host) => (host === "evil.example.net" ? ["192.168.0.10"] : [PUBLIC_IP]));
      r.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://evil.example.net/x" } }));

      expect(await r.sync.refresh(NOW)).toEqual({ status: "failed", note: NOT_ALLOWED });
      expect(r.fetch).toHaveBeenCalledTimes(1);
    });
  });

  it("нет каталога конфига: «Контейнер Xray не подключён…», узлы в таблицу не записаны", async () => {
    const r = rig();
    await seed(r);
    r.writer.available_ = false;

    const result = await r.sync.refresh(NOW);

    expect(result).toEqual({ status: "failed", note: "Контейнер Xray не подключён: конфиг некуда записать" });
    expect(r.repository.nodes).toEqual([]);
    expect(r.repository.refreshWrites).toBe(0);
    expect(r.repository.subscription).toMatchObject({ lastRefreshOk: false });
    expect(new SidecarMissingError().message).toContain("Xray");
  });

  it("нет ключа шифрования или адрес не читается: заметка, запроса нет", async () => {
    const r = rig();
    await seed(r);
    const other = new SubscriptionSync({
      repository: r.repository,
      cipher: cipher(),
      outbound: { forService: () => r.fetch },
      resolve: r.resolve,
      writer: r.writer,
      routes: r.routes,
      redis: r.redis,
      changed: r.changed,
      xray: { basePort: BASE_PORT, slotCount: 8 },
    });

    const result = await other.refresh(NOW);

    expect(result.status).toBe("failed");
    expect(r.fetch).not.toHaveBeenCalled();
  });

  describe("слоты узлов", () => {
    it("вернувшийся узел получает прежний слот, новый — наименьший свободный", async () => {
      const r = rig();
      await seed(r);
      await r.sync.refresh(NOW);
      const slotOf = (host: string): number | undefined => r.repository.nodes.find((node) => node.host === host)?.slot;
      expect([slotOf("n1.example.org"), slotOf("n2.example.org"), slotOf("n3.example.org")]).toEqual([0, 1, 2]);

      // n1 пропал, появился n4, потом n1 вернулся.
      r.fetch.mockImplementation(async () => answer(bodyOf(nodeLink(2), nodeLink(3), nodeLink(4))));
      await r.sync.refresh(new Date(NOW.getTime() + 1000));
      expect(slotOf("n4.example.org")).toBe(0);
      expect(slotOf("n2.example.org")).toBe(1);

      r.fetch.mockImplementation(async () => answer(bodyOf(nodeLink(1), nodeLink(2), nodeLink(3), nodeLink(4))));
      await r.sync.refresh(new Date(NOW.getTime() + 2000));
      expect([slotOf("n1.example.org"), slotOf("n2.example.org"), slotOf("n3.example.org"), slotOf("n4.example.org")]).toEqual([3, 1, 2, 0]);
    });

    it("пропавший узел удаляется из таблицы и из пула", async () => {
      const r = rig();
      await seed(r);
      await r.sync.refresh(NOW);
      r.fetch.mockImplementation(async () => answer(bodyOf(nodeLink(1))));

      await r.sync.refresh(new Date(NOW.getTime() + 1000));

      expect(r.repository.nodes.map((node) => node.host)).toEqual(["n1.example.org"]);
      expect(r.routes.nodeCount()).toBe(1);
    });

    it("состояние проверок уцелевшего узла не сбрасывается обновлением", async () => {
      const r = rig();
      await seed(r);
      await r.sync.refresh(NOW);
      const keep = r.repository.nodes[0] as StoredNode;
      r.repository.nodes = r.repository.nodes.map((node) => (node.nodeKey === keep.nodeKey ? { ...node, state: "healthy", latencyMs: 80, lastProbeAt: NOW, nextProbeAt: new Date(NOW.getTime() + 300_000) } : node));
      await r.routes.reload();

      await r.sync.refresh(new Date(NOW.getTime() + 1000));

      expect(r.repository.nodes.find((node) => node.nodeKey === keep.nodeKey)).toMatchObject({ state: "healthy", latencyMs: 80 });
    });

    it("узлов больше входов: лишние не подключены, об этом сказано в заметке", async () => {
      const r = rig({ slotCount: 2 });
      await seed(r);

      const result = await r.sync.refresh(NOW);

      expect(r.repository.nodes).toHaveLength(2);
      expect(result.status).toBe("ok");
      expect(r.repository.subscription?.lastRefreshNote).toContain("Не хватило входов: 1 узел не подключён — увеличьте XRAY_SLOT_COUNT");
      expect(r.repository.subscription?.lastRefreshOk).toBe(false);
    });
  });

  it("два обновления разом: выполняется одно, второе отвечает «занято»", async () => {
    const r = rig();
    await seed(r);
    let release: () => void = () => undefined;
    r.fetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(answer(bodyOf(nodeLink(1))));
        }),
    );

    const first = r.sync.refresh(NOW);
    await vi.waitFor(() => expect(r.fetch).toHaveBeenCalledTimes(1));
    const second = await r.sync.refresh(NOW);
    release();

    expect(second).toEqual({ status: "busy" });
    expect((await first).status).toBe("ok");
    expect(r.fetch).toHaveBeenCalledTimes(1);
    // Замок снят своим токеном: следующее обновление идёт.
    expect(r.redis.values.size).toBe(0);
  });

  it("замок держит другая реплика: «занято», запроса нет", async () => {
    const r = rig();
    await seed(r);
    r.redis.hold("proxy-subscription:refresh:lock");

    expect(await r.sync.refresh(NOW)).toEqual({ status: "busy" });
    expect(r.fetch).not.toHaveBeenCalled();
  });

  it("нет подписки или она выключена: обновления нет", async () => {
    const r = rig();
    expect(await r.sync.refresh(NOW)).toEqual({ status: "absent" });
    await seed(r, { enabled: false });
    expect(await r.sync.refresh(NOW)).toEqual({ status: "disabled" });
    expect(r.fetch).not.toHaveBeenCalled();
  });
});

describe("узлы в переборе клиента исходящих", () => {
  const healthy = (key: string, slot: number, latencyMs: number, patch: Partial<StoredNode> = {}): StoredNode => nodeRow(key, slot, { state: "healthy", latencyMs, lastProbeAt: NOW, ...patch });

  const manual = (priority: number): StoredProxy => ({
    proxyId: "manual-1",
    name: "Ручной",
    scheme: "http",
    host: "proxy.example.com",
    port: 3128,
    username: null,
    passwordIv: null,
    passwordTag: null,
    passwordCt: null,
    passwordKeyId: null,
    country: "NL",
    enabled: true,
    priority,
    note: null,
    lastCheckAt: null,
    lastCheckOk: null,
    lastCheckNote: null,
    updatedBy: "00000000-0000-4000-8000-000000000001",
    updatedAt: NOW,
  });

  async function listed(r: Rig, rows: StoredProxy[] = []): Promise<readonly OutboundProxy[]> {
    const proxies = {
      list: async () => rows,
      modes: async () => [],
    } as unknown as ProxiesRepository;
    const config = loadAppConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const proxyRoutes = new ProxyRoutes(config, proxies, null, { publish: async () => 1 } as unknown as Redis, r.routes);
    await proxyRoutes.refresh();
    return proxyRoutes.list();
  }

  it("не больше candidates здоровых, быстрые первыми; socks5 на xray:<база + слот> без логина и пароля", async () => {
    const r = rig({ settings: { "proxy.subscription.candidates": 3 } });
    await seed(r);
    r.repository.nodes = [healthy("aaaa", 0, 300), healthy("bbbb", 5, 40), healthy("cccc", 2, 90), healthy("dddd", 3, 10), nodeRow("eeee", 4), nodeRow("ffff", 6, { state: "down", failures: 4 })];

    const list = await listed(r);

    expect(list.map((proxy) => proxy.id)).toEqual(["node:dddd", "node:bbbb", "node:cccc"]);
    expect(list.map((proxy) => [proxy.scheme, proxy.host, proxy.port, proxy.username, proxy.password])).toEqual([
      ["socks5", "xray", BASE_PORT + 3, null, null],
      ["socks5", "xray", BASE_PORT + 5, null, null],
      ["socks5", "xray", BASE_PORT + 2, null, null],
    ]);
  });

  it("ручные прокси впереди: приоритет узла выше любого ручного", async () => {
    const r = rig();
    await seed(r);
    r.repository.nodes = [healthy("aaaa", 0, 50), healthy("bbbb", 1, 60)];

    const list = await listed(r, [manual(40)]);

    expect(list.map((proxy) => proxy.id)).toEqual(["manual-1", "node:aaaa", "node:bbbb"]);
    const priorities = list.map((proxy) => proxy.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    expect(new Set(priorities).size).toBe(3);
  });

  it("фильтр стран подписки: узел без страны при фильтре не берётся", async () => {
    const r = rig();
    await seed(r, { countries: ["NL"] });
    r.repository.nodes = [healthy("aaaa", 0, 10, { country: "DE" }), healthy("bbbb", 1, 20, { country: "NL" }), healthy("cccc", 2, 5, { country: null })];

    expect((await listed(r)).map((proxy) => proxy.id)).toEqual(["node:bbbb"]);
  });

  it("без фильтра узел без страны подходит", async () => {
    const r = rig();
    await seed(r);
    r.repository.nodes = [healthy("cccc", 2, 5, { country: null })];

    expect((await listed(r)).map((proxy) => proxy.id)).toEqual(["node:cccc"]);
  });

  it("подписка выключена: узлов в переборе нет", async () => {
    const r = rig();
    await seed(r, { enabled: false });
    r.repository.nodes = [healthy("aaaa", 0, 10)];

    expect(await listed(r)).toEqual([]);
  });

  it("подписки нет: только ручные прокси", async () => {
    const r = rig();
    expect((await listed(r, [manual(10)])).map((proxy) => proxy.id)).toEqual(["manual-1"]);
  });

  it("узел с другим слотом получает другую метку правки: диспетчер соберётся заново", async () => {
    const r = rig();
    await seed(r);
    r.repository.nodes = [healthy("aaaa", 0, 10)];
    const first = (await listed(r))[0];
    r.repository.nodes = [healthy("aaaa", 4, 10)];
    const second = (await listed(r))[0];

    expect(first?.updatedAt).not.toBe(second?.updatedAt);
  });
});

describe("клиент исходящих и журнал", () => {
  it("proxy.subscription в каталоге, по умолчанию только напрямую", () => {
    expect(OUTBOUND_SERVICES).toContain("proxy.subscription");
    expect(defaultModeOf("proxy.subscription")).toBe("direct_only");
  });

  it("безопасный путь для секретного сервиса — всегда /***, даже короткий токен и query", () => {
    expect(safePath("https://sub.example.com/api/v1/client/tok-9f8e?token=x", { maskPath: true })).toEqual({ host: "sub.example.com", path: "/***" });
    expect(safePath("https://sub.example.com/short", { maskPath: true }).path).toBe("/***");
    // Для остальных сервисов путь прежний.
    expect(safePath("https://sub.example.com/short").path).toBe("/short");
  });

  it("запись журнала запроса подписки: хост есть, пути и токена нет; прокси чужим узлам адрес не отдаёт", async () => {
    const records: OutboundRecord[] = [];
    const stub = vi.fn(async () => answer("ok"));
    vi.stubGlobal("fetch", stub);
    const proxyFetch = vi.fn<ProxyFetch>(async () => answer("не должен вызываться"));
    const outbound = new Outbound({ write: (record) => void records.push(record) }, () => NOW, { list: () => [{ id: "p1", scheme: "http", host: "p", port: 1, username: null, password: null, priority: 1, updatedAt: 1 }], modeOf: (service) => defaultModeOf(service) }, undefined, proxyFetch);

    await outbound.forService("proxy.subscription")("https://sub.example.com/api/v1/client/tok-9f8e7d6c5b4a?key=SECRETKEY");
    vi.unstubAllGlobals();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ service: "proxy.subscription", host: "sub.example.com", path: "/***", via: "direct" });
    expect(JSON.stringify(records)).not.toMatch(/tok-9f8e|SECRETKEY/);
    expect(proxyFetch).not.toHaveBeenCalled();
  });
});

describe("расписание обновления и проверок", () => {
  const ipify = (): Response => answer(JSON.stringify({ ip: "203.0.113.7" }));

  function scheduled(options: { settings?: Record<string, SettingValue> } = {}) {
    const r = rig(options);
    const proxyFetch = vi.fn<ProxyFetch>(async () => ipify());
    const scheduler = new SubscriptionScheduler({ repository: r.repository, routes: r.routes, sync: r.sync, writer: r.writer, proxyFetch, redis: r.redis, settings: r.settings, changed: r.changed });
    return { ...r, proxyFetch, scheduler };
  }
  const after = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);

  it("ни разу не обновлялась: тик обновляет подписку", async () => {
    const s = scheduled();
    await seed(s);

    await s.scheduler.tick(NOW);

    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(s.repository.nodes).toHaveLength(3);
  });

  it("период = max(настройка, интервал поставщика), потолок 168 ч: раньше срока обновления нет", async () => {
    const s = scheduled({ settings: { "proxy.subscription.refresh-hours": 6 } });
    await seed(s, { lastRefreshAt: NOW, lastRefreshOk: true, providerIntervalHours: 12 });

    await s.scheduler.tick(after(11 * 3600));
    expect(s.fetch).not.toHaveBeenCalled();
    await s.scheduler.tick(after(12 * 3600 + 1));
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });

  it("интервал поставщика выше потолка: ждём не больше 168 часов", async () => {
    const s = scheduled();
    await seed(s, { lastRefreshAt: NOW, lastRefreshOk: true, providerIntervalHours: 1000 });

    await s.scheduler.tick(after(168 * 3600 + 1));

    expect(s.fetch).toHaveBeenCalledTimes(1);
  });

  it("после неудачи повтор раньше срока: через 15 минут, а не через период", async () => {
    const s = scheduled();
    await seed(s, { lastRefreshAt: NOW, lastRefreshOk: false, lastRefreshNote: "Подписка пустая" });

    await s.scheduler.tick(after(14 * 60));
    expect(s.fetch).not.toHaveBeenCalled();
    await s.scheduler.tick(after(15 * 60 + 1));
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });

  it("файла конфига нет, подписка свежая: тик обновляет сразу, не ждёт период", async () => {
    const s = scheduled();
    await seed(s, { lastRefreshAt: NOW, lastRefreshOk: true });
    s.writer.fileExists = false;

    await s.scheduler.tick(after(60));

    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(s.writer.written).toHaveLength(1);
    // Файл записан: следующий тик подписку не трогает.
    await s.scheduler.tick(after(120));
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });

  it("файл на месте, подписка свежая: тик подписку не обновляет", async () => {
    const s = scheduled();
    await seed(s, { lastRefreshAt: NOW, lastRefreshOk: true });

    await s.scheduler.tick(after(60));

    expect(s.fetch).not.toHaveBeenCalled();
  });

  it("файла нет, но каталога тома тоже нет (Xray не подключён): подписку не дёргаем", async () => {
    const s = scheduled();
    await seed(s, { lastRefreshAt: NOW, lastRefreshOk: true });
    s.writer.fileExists = false;
    s.writer.available_ = false;

    await s.scheduler.tick(after(60));

    expect(s.fetch).not.toHaveBeenCalled();
  });

  it("файла нет, но прошлое обновление провалилось: действует повтор через 15 минут, а не каждый тик", async () => {
    const s = scheduled();
    await seed(s, { lastRefreshAt: NOW, lastRefreshOk: false, lastRefreshNote: "Подписка пустая" });
    s.writer.fileExists = false;

    await s.scheduler.tick(after(60));
    expect(s.fetch).not.toHaveBeenCalled();
    await s.scheduler.tick(after(15 * 60 + 1));
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });

  it("выключенная подписка: тик ничего не делает", async () => {
    const s = scheduled();
    await seed(s, { enabled: false });

    await s.scheduler.tick(NOW);

    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.proxyFetch).not.toHaveBeenCalled();
  });

  it("проверки узлов не раньше 20 секунд после записи конфига", async () => {
    const s = scheduled();
    await seed(s);
    await s.scheduler.tick(NOW);
    expect(s.proxyFetch).not.toHaveBeenCalled();

    await s.scheduler.tick(after(10));
    expect(s.proxyFetch).not.toHaveBeenCalled();
    await s.scheduler.tick(after(21));
    expect(s.proxyFetch).toHaveBeenCalledTimes(3);
  });

  it("проверка идёт через узел на ipify; итог в таблице: здоров, задержка, следующая проверка", async () => {
    const s = scheduled();
    await seed(s);
    await s.scheduler.tick(NOW);

    await s.scheduler.tick(after(30));

    const [proxy, url] = s.proxyFetch.mock.calls[0] ?? [];
    expect(proxy).toMatchObject({ scheme: "socks5", host: "xray", username: null, password: null });
    expect(url).toBe("https://api.ipify.org?format=json");
    expect(s.repository.nodes.map((node) => node.state)).toEqual(["healthy", "healthy", "healthy"]);
    expect(s.repository.nodes[0]?.latencyMs).not.toBeNull();
    expect(s.repository.nodes[0]?.nextProbeAt.getTime()).toBeGreaterThan(after(30).getTime());
  });

  it("узел не ответил дважды: «лежит», в перебор не попадает", async () => {
    const s = scheduled();
    await seed(s);
    await s.scheduler.tick(NOW);
    s.proxyFetch.mockRejectedValue(new TypeError("fetch failed"));

    await s.scheduler.tick(after(30));
    await s.scheduler.tick(after(70));

    expect(s.repository.nodes.map((node) => node.state)).toEqual(["down", "down", "down"]);
    expect(s.routes.list(0)).toEqual([]);
  });

  it("не больше пяти проверок параллельно", async () => {
    const s = scheduled();
    await seed(s, { lastRefreshAt: after(-3600), lastRefreshOk: true });
    s.repository.nodes = Array.from({ length: 12 }, (_, index) => nodeRow(`k${String(index).padStart(3, "0")}`, index));
    await s.routes.reload();
    let running = 0;
    let peak = 0;
    s.proxyFetch.mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return ipify();
    });

    await s.scheduler.tick(after(60));

    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
    expect(s.proxyFetch).toHaveBeenCalledTimes(12);
  });

  it("замок у другой реплики: проверок нет", async () => {
    const s = scheduled();
    await seed(s, { lastRefreshAt: after(-3600), lastRefreshOk: true });
    s.repository.nodes = [nodeRow("aaaa", 0)];
    s.redis.hold("proxy-subscription:refresh:lock");

    await s.scheduler.tick(NOW);

    expect(s.proxyFetch).not.toHaveBeenCalled();
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it("при смене probe-minutes пул пересоздаётся с сохранённым состоянием, следующая проверка считается по новому периоду", async () => {
    const s = scheduled({ settings: { "proxy.subscription.probe-minutes": 5 } });
    await seed(s);
    await s.scheduler.tick(NOW);
    await s.scheduler.tick(after(30));
    expect(s.repository.nodes[0]?.state).toBe("healthy");

    s.settings.set("proxy.subscription.probe-minutes", 1);
    await s.scheduler.tick(after(400));

    const node = s.repository.nodes[0];
    expect(node?.state).toBe("healthy");
    expect(node?.nextProbeAt.getTime()).toBe(after(400).getTime() + 60_000);
  });
});

describe("подписка по HTTP в панели", () => {
  const AUDIT_URL = /tok-9f8e7d6c5b4a|SECRETKEY|sub\.example\.com\/api/;
  let app: NestFastifyApplication | null = null;
  let r: Rig;
  let roles: MemoryRolesRepository;
  let sealing: SecretCipher | null;

  async function boot(options: { encryption: boolean } = { encryption: true }): Promise<void> {
    r = rig();
    // Сервис и обновление шифруют одним ключом, как в приложении.
    sealing = options.encryption ? r.cipher : null;
    const accounts = new MemoryAccountRepository();
    roles = new MemoryRolesRepository();
    const store = new MemoryAdminSessionStore();
    const publish = vi.fn(async () => 1);
    const proxies = { list: async () => [], modes: async () => [] } as unknown as ProxiesRepository;

    @Module({
      controllers: [AdminProxySubscriptionController],
      providers: [
        { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: "777000111" } as NodeJS.ProcessEnv) },
        { provide: REDIS, useValue: Object.assign(r.redis, { publish }) },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: PROXIES_REPOSITORY, useValue: proxies },
        { provide: PROXY_CIPHER, useValue: sealing },
        { provide: SUBSCRIPTION_REPOSITORY, useValue: r.repository },
        { provide: CONFIG_WRITER, useValue: r.writer },
        { provide: OUTBOUND_PROXY_FETCH, useValue: vi.fn() },
        { provide: SubscriptionRoutes, useValue: r.routes },
        { provide: SubscriptionSync, useValue: r.sync },
        { provide: ProxyRoutes, useValue: { changed: r.changed } },
        ProxySubscriptionService,
        RateLimiter,
        RolesService,
        PermissionGuard,
        AdminSessionService,
        AdminSessionGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    for (const [token, id, role] of [
      ["own", "700000", "owner"],
      ["adm", "700001", "admin"],
      ["mod", "700002", "moderator"],
    ] as const) {
      const account = await accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Человек ${id}`, username: null, photoUrl: null }, NOW.getTime());
      await roles.grant(account.accountId, role, null);
      await store.put(hashSessionToken(token), { accountId: account.accountId, platform: "telegram", platformUserId: id, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    }
  }

  beforeEach(async () => {
    await boot();
  });

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  function server(): NestFastifyApplication {
    if (app === null) throw new Error("приложение не поднято");
    return app;
  }
  const headersOf = (token: string) => ({ cookie: `${ADMIN_SESSION_COOKIE}=${token}`, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE });
  const call = (method: "GET" | "POST" | "PUT" | "DELETE", path: string, token: string, payload?: unknown) =>
    server().inject({ method, url: `/api/v1/admin/proxy-subscription${path}`, headers: headersOf(token), ...(payload === undefined ? {} : { payload: payload as object }) });
  const save = (body: Record<string, unknown> = {}, token = "own") => call("PUT", "", token, { name: "Основная", url: URL_SECRET, countries: ["DE", "NL"], enabled: true, ...body });
  const auditText = async (): Promise<string> => JSON.stringify(await roles.recentAudit(100));

  it("смотреть: владелец и администратор — 200, модератор — 403, без сессии — 401", async () => {
    expect((await call("GET", "", "own")).statusCode).toBe(200);
    expect((await call("GET", "", "adm")).statusCode).toBe(200);
    expect((await call("GET", "", "mod")).statusCode).toBe(403);
    expect((await server().inject({ method: "GET", url: "/api/v1/admin/proxy-subscription" })).statusCode).toBe(401);
  });

  it("менять без proxies.edit (администратор, модератор) — 403, ничего не записано", async () => {
    for (const token of ["adm", "mod"]) {
      expect((await save({}, token)).statusCode, token).toBe(403);
      expect((await call("POST", "/refresh", token)).statusCode, token).toBe(403);
      expect((await call("POST", "/probe", token)).statusCode, token).toBe(403);
      expect((await call("DELETE", "", token)).statusCode, token).toBe(403);
    }
    expect(r.repository.subscription).toBeNull();
    expect(r.fetch).not.toHaveBeenCalled();
    expect(await auditText()).not.toContain("proxy_subscription");
  });

  it("пусто: подписки нет, контейнер подключён", async () => {
    const body = (await call("GET", "", "own")).json() as { data: { subscription: unknown; nodes: unknown[]; sidecar: { connected: boolean }; encryption: boolean } };
    expect(body.data).toMatchObject({ subscription: null, nodes: [], sidecar: { connected: true }, encryption: true });

    r.writer.available_ = false;
    expect(((await call("GET", "", "own")).json() as typeof body).data.sidecar.connected).toBe(false);
  });

  const BAD: [string, Record<string, unknown>][] = [
    ["http", { url: "http://sub.example.com/s" }],
    ["с логином", { url: "https://user:pass@sub.example.com/s" }],
    ["закрытый адрес", { url: "https://10.0.0.5/s" }],
    ["мусор вместо адреса", { url: "не адрес" }],
    ["страна строчными", { countries: ["de"] }],
    ["страна из трёх букв", { countries: ["DEU"] }],
    ["больше десяти стран", { countries: ["AA", "AB", "AC", "AD", "AE", "AF", "AG", "AH", "AI", "AJ", "AK"] }],
    ["пустое название", { name: " " }],
    ["лишнее поле", { extra: 1 }],
  ];
  for (const [name, patch] of BAD) {
    it(`сохранение: ${name} — 400, ничего не записано`, async () => {
      const response = await save(patch);
      expect(response.statusCode).toBe(400);
      expect(r.repository.subscription).toBeNull();
    });
  }

  it("сохранение: адрес шифртекстом, в ответе, журнале и аудите его нет; есть подсказка", async () => {
    const response = await save();

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(AUDIT_URL);
    const data = (response.json() as { data: { subscription: Record<string, unknown> } }).data.subscription;
    expect(data).toMatchObject({ name: "Основная", countries: ["DE", "NL"], enabled: true, urlHint: "sub.example.com …TKEY" });
    expect(Object.keys(data).some((key) => /^url(Iv|Tag|Ct|KeyId)?$/i.test(key))).toBe(false);

    const row = r.repository.subscription;
    expect(Buffer.from(row?.urlCt ?? []).toString("utf8")).not.toContain("sub.example.com");
    expect(await auditText()).not.toMatch(AUDIT_URL);
    const entry = (await roles.recentAudit(10)).find((item) => item.action === "proxy_subscription.save");
    expect(entry?.after).toMatchObject({ name: "Основная", urlHint: "sub.example.com …TKEY", countries: ["DE", "NL"], enabled: true });
  });

  it("PUT без url оставляет прежний адрес и узлы; с новым — узлы прежней подписки сбрасываются", async () => {
    await save();
    const sealed = Buffer.from(r.repository.subscription?.urlCt ?? []).toString("hex");
    r.repository.nodes = [nodeRow("aaaa", 0)];

    const keep = await call("PUT", "", "own", { name: "Новое имя", countries: [], enabled: false });
    expect(keep.statusCode).toBe(200);
    expect(Buffer.from(r.repository.subscription?.urlCt ?? []).toString("hex")).toBe(sealed);
    expect(r.repository.subscription).toMatchObject({ name: "Новое имя", enabled: false, countries: [] });
    expect(r.repository.nodes).toHaveLength(1);

    await save({ url: "https://other.example.com/new-token-1234567890" });
    expect(Buffer.from(r.repository.subscription?.urlCt ?? []).toString("hex")).not.toBe(sealed);
    expect(r.repository.nodes).toEqual([]);
    expect(r.repository.subscription?.lastRefreshAt).toBeNull();
  });

  it("первое сохранение без url — 400", async () => {
    expect((await call("PUT", "", "own", { name: "Основная", countries: [], enabled: true })).statusCode).toBe(400);
  });

  it("без ключа шифрования сохранить нельзя — 409", async () => {
    await app?.close();
    await boot({ encryption: false });
    const response = await save();
    expect(response.statusCode).toBe(409);
    expect(r.repository.subscription).toBeNull();
    expect(((await call("GET", "", "own")).json() as { data: { encryption: boolean } }).data.encryption).toBe(false);
  });

  it("ручное «Обновить» дважды за минуту: второе — 429, обновление было одно", async () => {
    await save();
    expect((await call("POST", "/refresh", "own")).statusCode).toBe(200);
    expect(r.fetch).toHaveBeenCalledTimes(1);

    const second = await call("POST", "/refresh", "own");

    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ error: { message: "Подождите минуту" } });
    expect(r.fetch).toHaveBeenCalledTimes(1);
  });

  it("«Проверить узлы» не чаще раза в минуту; отмечает все узлы к проверке сейчас", async () => {
    await save();
    const far = Date.now() + 10 * 3_600_000;
    r.repository.nodes = [nodeRow("aaaa", 0, { nextProbeAt: new Date(far) })];

    expect((await call("POST", "/probe", "own")).statusCode).toBe(200);
    expect(r.repository.nodes[0]?.nextProbeAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await call("POST", "/probe", "own")).statusCode).toBe(429);
  });

  it("обновление пишет аудит без адреса и возвращает итог", async () => {
    await save();
    const response = await call("POST", "/refresh", "own");

    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: { subscription: { lastRefreshNote: string } } }).data.subscription.lastRefreshNote).toBe("3 узла, пропущено 1 (протокол: 1)");
    expect(await auditText()).not.toMatch(AUDIT_URL);
    expect((await roles.recentAudit(10)).some((item) => item.action === "proxy_subscription.refresh")).toBe(true);
  });

  it("узлы в ответе: рабочие сверху, секретов узла (uuid, пароль) нет", async () => {
    await save();
    r.repository.nodes = [nodeRow("down1", 0, { state: "down", failures: 3 }), nodeRow("ok-slow", 1, { state: "healthy", latencyMs: 200 }), nodeRow("ok-fast", 2, { state: "healthy", latencyMs: 30 }), nodeRow("new1", 3)];

    const response = await call("GET", "", "adm");
    const nodes = (response.json() as { data: { nodes: { name: string; state: string }[] } }).data.nodes;

    expect(nodes.map((node) => node.state)).toEqual(["healthy", "healthy", "unknown", "down"]);
    expect(response.body).not.toContain(UUID);
  });

  it("включить и выключить: аудит toggle, в перебор выключенная не попадает", async () => {
    await save();
    r.repository.nodes = [nodeRow("aaaa", 0, { state: "healthy", latencyMs: 10 })];
    await r.routes.reload();
    expect(r.routes.list(0)).toHaveLength(1);

    const off = await call("PUT", "", "own", { name: "Основная", countries: [], enabled: false });

    expect(off.statusCode).toBe(200);
    expect(r.routes.list(0)).toEqual([]);
    expect((await roles.recentAudit(10)).some((item) => item.action === "proxy_subscription.toggle")).toBe(true);
  });

  it("удаление: в конфиг пишется пустой, строка и узлы удалены, аудит delete; повторное — 404", async () => {
    await save();
    await call("POST", "/refresh", "own");
    expect(r.repository.nodes.length).toBeGreaterThan(0);

    expect((await call("DELETE", "", "own")).statusCode).toBe(200);

    expect(r.repository.subscription).toBeNull();
    expect(r.repository.nodes).toEqual([]);
    expect((r.writer.last as { inbounds: unknown[] }).inbounds).toEqual([]);
    expect(r.routes.list(0)).toEqual([]);
    expect((await roles.recentAudit(10)).some((item) => item.action === "proxy_subscription.delete")).toBe(true);
    expect((await call("DELETE", "", "own")).statusCode).toBe(404);
  });

  it("удаление без контейнера Xray не падает: подписка всё равно удаляется", async () => {
    await save();
    r.writer.available_ = false;

    expect((await call("DELETE", "", "own")).statusCode).toBe(200);
    expect(r.repository.subscription).toBeNull();
  });
});
