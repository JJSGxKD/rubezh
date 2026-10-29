import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { OUTBOUND_PROXY_FETCH, type OutboundProxy, type ProxyFetch } from "../src/infra/outbound/outbound-route.js";
import { OUTBOUND_SERVICES } from "../src/infra/outbound/outbound-services.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminProxiesController } from "../src/modules/admin/admin-proxies.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PROXY_CIPHER, openPassword, proxySecretName, sealPassword } from "../src/modules/proxies/proxy-password.js";
import { PROXIES_CHANNEL, ProxyRoutes } from "../src/modules/proxies/proxy-routes.service.js";
import { PROXIES_REPOSITORY, type ProxiesRepository, type StoredMode, type StoredProxy } from "../src/modules/proxies/proxies.repository.js";
import { PROXY_LIMITS } from "../src/modules/proxies/proxies-rules.js";
import { ProxiesService } from "../src/modules/proxies/proxies.service.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS } from "../src/modules/roles/permissions.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { SecretCipher } from "../src/modules/secrets/secret-cipher.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Прокси для исходящих запросов в панели по HTTP (docs/35-stage4-plan.md Р91,
 * tasks/T-0065): права, пароль только шифртекстом и ни в одном ответе и записи
 * аудита, разбор формы, проверка через прокси и режимы сервисов. Хранилище —
 * подмена: путь запроса до него и то, что из его строк собирает сервис.
 */

const NOW = new Date("2026-10-29T12:00:00.000Z");
const PASSWORD = "Pa55-w0rd-SECRET-zzz";
const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: "777000111" } as NodeJS.ProcessEnv);
const newCipher = () => new SecretCipher([randomBytes(32).toString("base64")]);

/** Прокси и режимы в памяти: то, что в базе лежит таблицами `outbound_proxy` и `outbound_service_mode`. */
class MemoryProxies implements ProxiesRepository {
  readonly rows = new Map<string, StoredProxy>();
  readonly modeRows = new Map<string, StoredMode>();

  async list(): Promise<StoredProxy[]> {
    return [...this.rows.values()].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  }
  async find(proxyId: string): Promise<StoredProxy | null> {
    return this.rows.get(proxyId) ?? null;
  }
  async insert(row: StoredProxy): Promise<void> {
    this.rows.set(row.proxyId, row);
  }
  async replace(row: StoredProxy): Promise<boolean> {
    if (!this.rows.has(row.proxyId)) return false;
    this.rows.set(row.proxyId, row);
    return true;
  }
  async saveCheck(proxyId: string, check: { at: Date; ok: boolean; note: string }): Promise<StoredProxy | null> {
    const row = this.rows.get(proxyId);
    if (row === undefined) return null;
    const next = { ...row, lastCheckAt: check.at, lastCheckOk: check.ok, lastCheckNote: check.note };
    this.rows.set(proxyId, next);
    return next;
  }
  async modes(): Promise<StoredMode[]> {
    return [...this.modeRows.values()];
  }
  async saveMode(row: StoredMode): Promise<void> {
    this.modeRows.set(row.service, row);
  }
}

interface ProxyBody {
  data: {
    proxyId: string;
    name: string;
    scheme: string;
    host: string;
    port: number;
    username: string | null;
    passwordSet: boolean;
    passwordUnreadable: boolean;
    country: string;
    enabled: boolean;
    priority: number;
    note: string | null;
    lastCheck: { at: string; ok: boolean; note: string | null } | null;
  };
}
interface ListBody {
  data: { enabled: boolean; proxies: ProxyBody["data"][] };
}
interface ModesBody {
  data: { modes: { service: string; mode: string; default: string; custom: boolean; updatedAt: string | null }[] };
}
interface CheckBody {
  data: { ok: boolean; message: string; proxy: ProxyBody["data"] };
}

const VALID = { name: "Фермерский", scheme: "http", host: "proxy.example.com", port: 3128, country: "DE" };

describe("прокси в панели по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  let repository: MemoryProxies;
  let roles: MemoryRolesRepository;
  let cipher: SecretCipher | null;
  let publish: ReturnType<typeof vi.fn>;
  let proxyFetch: ReturnType<typeof vi.fn<ProxyFetch>>;

  async function boot(options: { cipher: SecretCipher | null }): Promise<void> {
    cipher = options.cipher;
    repository = new MemoryProxies();
    publish = vi.fn(async () => 1);
    proxyFetch = vi.fn<ProxyFetch>(async () => new Response(JSON.stringify({ ip: "203.0.113.7" }), { status: 200 }));
    const accounts = new MemoryAccountRepository();
    roles = new MemoryRolesRepository();
    const store = new MemoryAdminSessionStore();

    @Module({
      controllers: [AdminProxiesController],
      providers: [
        { provide: APP_CONFIG, useValue: config() },
        { provide: REDIS, useValue: { eval: async () => Promise.reject(new Error("connection refused")), publish } as unknown as Redis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: PROXIES_REPOSITORY, useValue: repository },
        { provide: PROXY_CIPHER, useValue: cipher },
        { provide: OUTBOUND_PROXY_FETCH, useValue: proxyFetch },
        ProxyRoutes,
        ProxiesService,
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
    await boot({ cipher: newCipher() });
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
  const call = (method: "GET" | "POST" | "PATCH" | "PUT", path: string, token: string, payload?: unknown) =>
    server().inject({ method, url: `/api/v1/admin/proxies${path}`, headers: headersOf(token), ...(payload === undefined ? {} : { payload: payload as object }) });
  const create = (body: Record<string, unknown> = {}, token = "own") => call("POST", "", token, { ...VALID, ...body });
  const idOf = async (body: Record<string, unknown> = {}): Promise<string> => ((await create(body)).json() as ProxyBody).data.proxyId;
  const auditText = async (): Promise<string> => JSON.stringify(await roles.recentAudit(100));

  describe("права", () => {
    it("proxies.view — владелец и администратор, proxies.edit — только владелец", () => {
      expect(PERMISSIONS).toContain("proxies.view");
      expect(PERMISSIONS).toContain("proxies.edit");
      for (const role of ROLES) {
        expect(ROLE_PERMISSIONS[role].includes("proxies.view"), `view ${role}`).toBe(role === "owner" || role === "admin");
        expect(ROLE_PERMISSIONS[role].includes("proxies.edit"), `edit ${role}`).toBe(role === "owner");
      }
    });

    it("смотреть: владелец и администратор — 200, модератор — 403, без сессии — 401", async () => {
      expect((await call("GET", "", "own")).statusCode).toBe(200);
      expect((await call("GET", "", "adm")).statusCode).toBe(200);
      expect((await call("GET", "/modes", "adm")).statusCode).toBe(200);
      expect((await call("GET", "", "mod")).statusCode).toBe(403);
      expect((await call("GET", "/modes", "mod")).statusCode).toBe(403);
      expect((await server().inject({ method: "GET", url: "/api/v1/admin/proxies" })).statusCode).toBe(401);
    });

    it("без proxies.edit (администратор, модератор) всё изменяющее — 403, ничего не записано, аудит пуст", async () => {
      const id = await idOf();
      const rowsBefore = JSON.stringify([...repository.rows.values()]);
      const auditBefore = await auditText();

      for (const token of ["adm", "mod"]) {
        expect((await create({}, token)).statusCode, token).toBe(403);
        expect((await call("PATCH", `/${id}`, token, { name: "Чужой" })).statusCode, token).toBe(403);
        expect((await call("POST", `/${id}/check`, token)).statusCode, token).toBe(403);
        expect((await call("PUT", "/modes/fx.cbr", token, { mode: "proxy_only" })).statusCode, token).toBe(403);
      }

      expect(JSON.stringify([...repository.rows.values()])).toBe(rowsBefore);
      expect(repository.modeRows.size).toBe(0);
      expect(proxyFetch).not.toHaveBeenCalled();
      expect(await auditText()).toBe(auditBefore);
    });
  });

  describe("пароль", () => {
    it("запись: ответ без пароля, в хранилище — шифртекст, расшифровывается тем же ключом", async () => {
      const response = await create({ username: "farmer", password: PASSWORD });
      expect(response.statusCode).toBe(201);
      const body = response.json() as ProxyBody;
      expect(body.data).toMatchObject({ name: "Фермерский", scheme: "http", host: "proxy.example.com", port: 3128, username: "farmer", passwordSet: true, passwordUnreadable: false, country: "DE", enabled: true });
      expect(response.body).not.toContain(PASSWORD);

      const row = repository.rows.get(body.data.proxyId);
      expect(row?.passwordCt).toBeDefined();
      expect(Buffer.from(row?.passwordCt ?? []).toString("utf8")).not.toContain("SECRET");
      expect(row?.passwordIv).toHaveLength(12);
      expect(row?.passwordTag).toHaveLength(16);
      expect(row?.passwordKeyId).toBe(cipher?.currentKeyId);
      expect(row === undefined || cipher === null ? null : openPassword(cipher, row)).toBe(PASSWORD);
    });

    it("ни список, ни аудит, ни проверка пароль не показывают: ключей password* в ответе нет вовсе", async () => {
      const id = await idOf({ username: "farmer", password: PASSWORD });
      await call("PATCH", `/${id}`, "own", { note: "правка" });
      const listed = await call("GET", "", "adm");
      const checked = await call("POST", `/${id}/check`, "own");

      for (const text of [listed.body, checked.body, await auditText()]) {
        expect(text).not.toContain(PASSWORD);
        expect(text).not.toMatch(/password(Ct|Iv|Tag|KeyId)/);
      }
      expect((listed.json() as ListBody).data.proxies[0]).toMatchObject({ username: "farmer", passwordSet: true });
    });

    it("аудит создания несёт название, схему, адрес и порт — и признак пароля вместо пароля", async () => {
      await create({ username: "farmer", password: PASSWORD });
      const entries = await roles.recentAudit(10);
      const entry = entries.find((item) => item.action === "proxies.create");
      expect(entry?.after).toMatchObject({ name: "Фермерский", scheme: "http", host: "proxy.example.com", port: 3128, username: "farmer", passwordSet: true });
    });

    it("правка с пустым полем пароля оставляет прежний шифртекст", async () => {
      const id = await idOf({ username: "farmer", password: PASSWORD });
      const before = repository.rows.get(id);

      for (const patch of [{ note: "без пароля" }, { password: "" }, { name: "Новое имя", password: "" }]) {
        expect((await call("PATCH", `/${id}`, "own", patch)).statusCode).toBe(200);
      }

      const after = repository.rows.get(id);
      expect(Buffer.from(after?.passwordCt ?? [])).toEqual(Buffer.from(before?.passwordCt ?? []));
      expect(Buffer.from(after?.passwordIv ?? [])).toEqual(Buffer.from(before?.passwordIv ?? []));
      expect(after?.name).toBe("Новое имя");
    });

    it("новый пароль заменяет прежний: другой шифртекст и другое IV, читается новый", async () => {
      const id = await idOf({ username: "farmer", password: PASSWORD });
      const before = repository.rows.get(id);
      const response = await call("PATCH", `/${id}`, "own", { password: "Новый-пароль-777" });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("Новый-пароль-777");
      const after = repository.rows.get(id);
      expect(Buffer.from(after?.passwordCt ?? [])).not.toEqual(Buffer.from(before?.passwordCt ?? []));
      expect(Buffer.from(after?.passwordIv ?? [])).not.toEqual(Buffer.from(before?.passwordIv ?? []));
      expect(after === undefined || cipher === null ? null : openPassword(cipher, after)).toBe("Новый-пароль-777");
    });

    it("«Удалить пароль» — явно: clearPassword стирает все четыре колонки", async () => {
      const id = await idOf({ username: "farmer", password: PASSWORD });
      const response = await call("PATCH", `/${id}`, "own", { clearPassword: true });
      expect((response.json() as ProxyBody).data.passwordSet).toBe(false);
      const row = repository.rows.get(id);
      expect([row?.passwordIv, row?.passwordTag, row?.passwordCt, row?.passwordKeyId]).toEqual([null, null, null, null]);
    });

    it("пароль нельзя задать вместе с очисткой, а без логина пароля не бывает", async () => {
      const id = await idOf({ username: "farmer", password: PASSWORD });
      expect((await call("PATCH", `/${id}`, "own", { password: "x", clearPassword: true })).statusCode).toBe(400);
      expect((await create({ password: PASSWORD })).statusCode).toBe(400);
      expect((await call("PATCH", `/${id}`, "own", { username: null })).statusCode).toBe(400);
      expect((await call("PATCH", `/${id}`, "own", { username: null, clearPassword: true })).statusCode).toBe(200);
    });

    it("шифртекст привязан к прокси: из строки другого прокси он не читается", async () => {
      const first = await idOf({ username: "farmer", password: PASSWORD });
      const second = await idOf({ name: "Второй", username: "farmer", password: "другой" });
      const stolen = { ...(repository.rows.get(second) as StoredProxy), passwordCt: repository.rows.get(first)?.passwordCt ?? null, passwordIv: repository.rows.get(first)?.passwordIv ?? null, passwordTag: repository.rows.get(first)?.passwordTag ?? null };
      expect(() => (cipher === null ? null : openPassword(cipher, stolen))).toThrow();
      expect(proxySecretName(first)).not.toBe(proxySecretName(second));
    });

    it("без ключа шифрования пароль не сохранить (409), а прокси без пароля заводится", async () => {
      await app?.close();
      await boot({ cipher: null });

      const refused = await create({ username: "farmer", password: PASSWORD });
      expect(refused.statusCode).toBe(409);
      expect(refused.body).toContain("SECRETS_ENCRYPTION_KEY");
      expect(repository.rows.size).toBe(0);

      expect((await create()).statusCode).toBe(201);
      const listed = (await call("GET", "", "own")).json() as ListBody;
      expect(listed.data.enabled).toBe(false);
      expect(listed.data.proxies).toHaveLength(1);
    });

    it("пароль, зашифрованный другим ключом, помечен: passwordUnreadable, а правка остальных полей идёт", async () => {
      const id = await idOf({ username: "farmer", password: PASSWORD });
      await app?.close();
      const kept = repository;
      await boot({ cipher: newCipher() });
      for (const row of kept.rows.values()) repository.rows.set(row.proxyId, row);

      const listed = (await call("GET", "", "own")).json() as ListBody;
      expect(listed.data.proxies[0]).toMatchObject({ passwordSet: true, passwordUnreadable: true });
      expect((await call("PATCH", `/${id}`, "own", { note: "ничего" })).statusCode).toBe(200);
      expect((await call("PATCH", `/${id}`, "own", { password: "новый" })).statusCode).toBe(200);
      const fixed = (await call("GET", "", "own")).json() as ListBody;
      expect(fixed.data.proxies[0]?.passwordUnreadable).toBe(false);
    });
  });

  describe("разбор формы", () => {
    it.each([
      ["схема ftp", { scheme: "ftp" }],
      ["схема в верхнем регистре", { scheme: "HTTP" }],
      ["порт 0", { port: 0 }],
      ["порт 65536", { port: 65_536 }],
      ["порт дробный", { port: 80.5 }],
      ["порт строкой", { port: "3128" }],
      ["страна строчными", { country: "de" }],
      ["страна из трёх букв", { country: "DEU" }],
      ["страна с цифрой", { country: "D1" }],
      ["страна пустая", { country: "" }],
      ["хост со схемой", { host: "http://proxy.example.com" }],
      ["хост с путём", { host: "proxy.example.com/path" }],
      ["хост с портом", { host: "proxy.example.com:3128" }],
      ["хост с пробелом", { host: "bad host" }],
      ["хост пустой", { host: "" }],
      ["хост длиннее 255", { host: `${"a".repeat(64)}.${"b".repeat(64)}.${"c".repeat(64)}.${"d".repeat(64)}` }],
      ["название пустое", { name: "" }],
      ["название длиннее 60", { name: "я".repeat(61) }],
      ["приоритет отрицательный", { priority: -1 }],
      ["заметка длиннее 200", { note: "я".repeat(201) }],
      ["лишнее поле", { password2: "x" }],
    ])("создание: %s — 400, ничего не записано", async (_label, patch) => {
      const response = await create(patch);
      expect(response.statusCode).toBe(400);
      expect(repository.rows.size).toBe(0);
    });

    it.each([["proxy.example.com"], ["10.0.0.5"], ["tunnel"], ["my_tunnel.internal"], ["2001:db8::1"], ["EXAMPLE.COM"]])("хост «%s» принимается", async (host) => {
      expect((await create({ host })).statusCode).toBe(201);
    });

    it.each([["http"], ["https"], ["socks5"]])("схема %s принимается", async (scheme) => {
      expect((await create({ scheme })).statusCode).toBe(201);
    });

    it("правка: тоже строго — пустая правка и неверная схема отклоняются, чужой id — 404", async () => {
      const id = await idOf();
      expect((await call("PATCH", `/${id}`, "own", {})).statusCode).toBe(400);
      expect((await call("PATCH", `/${id}`, "own", { scheme: "ftp" })).statusCode).toBe(400);
      expect((await call("PATCH", `/${id}`, "own", { port: 70_000 })).statusCode).toBe(400);
      expect((await call("PATCH", "/не-идентификатор", "own", { name: "x" })).statusCode).toBe(400);
      expect((await call("PATCH", "/00000000-0000-4000-8000-000000000000", "own", { name: "x" })).statusCode).toBe(404);
      expect((await call("POST", "/00000000-0000-4000-8000-000000000000/check", "own")).statusCode).toBe(404);
    });

    it("прокси не больше предела — следующий отклонён 409", async () => {
      for (let index = 0; index < PROXY_LIMITS.countMax; index += 1) repository.rows.set(`id-${String(index)}`, rowOf(`id-${String(index)}`));
      const response = await create();
      expect(response.statusCode).toBe(409);
      expect(repository.rows.size).toBe(PROXY_LIMITS.countMax);
    });

    it("порядок: без priority новый прокси встаёт в конец", async () => {
      await idOf({ name: "Первый", priority: 10 });
      await idOf({ name: "Второй" });
      await idOf({ name: "Третий" });
      const listed = (await call("GET", "", "own")).json() as ListBody;
      expect(listed.data.proxies.map((proxy) => proxy.name)).toEqual(["Первый", "Второй", "Третий"]);
      const priorities = listed.data.proxies.map((proxy) => proxy.priority);
      expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
      expect(new Set(priorities).size).toBe(3);
    });
  });

  describe("правка и сообщение репликам", () => {
    it("создание, правка, проверка и смена режима шлют сообщение в канал прокси", async () => {
      const id = await idOf();
      await call("PATCH", `/${id}`, "own", { enabled: false });
      await call("POST", `/${id}/check`, "own");
      await call("PUT", "/modes/fx.cbr", "own", { mode: "proxy_only" });
      expect(publish.mock.calls.map((args) => args[0])).toEqual([PROXIES_CHANNEL, PROXIES_CHANNEL, PROXIES_CHANNEL, PROXIES_CHANNEL]);
    });

    it("недоступный Redis не мешает правке", async () => {
      publish.mockRejectedValue(new Error("redis лежит"));
      expect((await create()).statusCode).toBe(201);
    });

    it("аудит правки: до и после, без пароля; выключение видно", async () => {
      const id = await idOf({ username: "farmer", password: PASSWORD });
      await call("PATCH", `/${id}`, "own", { enabled: false, host: "other.example.com" });
      const entry = (await roles.recentAudit(10)).find((item) => item.action === "proxies.update");
      expect(entry).toMatchObject({ target: id, before: { enabled: true, host: "proxy.example.com" }, after: { enabled: false, host: "other.example.com", passwordSet: true } });
    });
  });

  describe("проверка", () => {
    it("запрос идёт через этот прокси к ipify с расшифрованным паролем; итог и внешний адрес сохранены", async () => {
      const id = await idOf({ username: "farmer", password: PASSWORD, scheme: "socks5", port: 1080 });

      const response = await call("POST", `/${id}/check`, "own");

      expect(response.statusCode).toBe(200);
      const body = response.json() as CheckBody;
      expect(body.data.ok).toBe(true);
      expect(body.data.message).toContain("203.0.113.7");
      expect(body.data.proxy.lastCheck).toMatchObject({ ok: true });
      expect(body.data.proxy.lastCheck?.note).toContain("203.0.113.7");

      expect(proxyFetch).toHaveBeenCalledTimes(1);
      const [proxy, url, init] = proxyFetch.mock.calls[0] as [OutboundProxy, string, RequestInit];
      expect(proxy).toMatchObject({ id, scheme: "socks5", host: "proxy.example.com", port: 1080, username: "farmer", password: PASSWORD });
      expect(url).toBe("https://api.ipify.org?format=json");
      expect(init.signal).toBeInstanceOf(AbortSignal);

      const row = repository.rows.get(id);
      expect([row?.lastCheckOk, row?.lastCheckNote]).toEqual([true, body.data.proxy.lastCheck?.note]);
      expect(row?.lastCheckAt).toBeInstanceOf(Date);
      const entry = (await roles.recentAudit(10)).find((item) => item.action === "proxies.check");
      expect(entry).toMatchObject({ target: id, after: { name: "Фермерский", host: "proxy.example.com", port: 1080, ok: true } });
      expect(JSON.stringify(entry)).not.toContain(PASSWORD);
    });

    it("сбой соединения: ok false, причина словами без текста исключения", async () => {
      const id = await idOf();
      proxyFetch.mockRejectedValue(Object.assign(new TypeError("fetch failed: http://u:SECRETPASS@host"), { cause: { code: "ECONNREFUSED" } }));
      const body = (await call("POST", `/${id}/check`, "own")).json() as CheckBody;
      expect(body.data.ok).toBe(false);
      expect(body.data.message).toContain("ECONNREFUSED");
      expect(body.data.message).not.toContain("SECRETPASS");
      expect(repository.rows.get(id)).toMatchObject({ lastCheckOk: false });
    });

    it("таймаут: «нет ответа», а не пустая причина", async () => {
      const id = await idOf();
      proxyFetch.mockRejectedValue(new DOMException("срок", "TimeoutError"));
      const body = (await call("POST", `/${id}/check`, "own")).json() as CheckBody;
      expect(body.data).toMatchObject({ ok: false });
      expect(body.data.message).toMatch(/нет ответа/i);
    });

    it("прокси ответил не 200 (например 407 — нужен логин) или не адресом: ok false", async () => {
      const id = await idOf();
      proxyFetch.mockResolvedValueOnce(new Response("auth", { status: 407 }));
      const refused = (await call("POST", `/${id}/check`, "own")).json() as CheckBody;
      expect(refused.data.ok).toBe(false);
      expect(refused.data.message).toContain("407");

      proxyFetch.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
      const garbage = (await call("POST", `/${id}/check`, "own")).json() as CheckBody;
      expect(garbage.data.ok).toBe(false);
    });

    it("пароль не расшифровывается: запроса нет, причина названа", async () => {
      const id = await idOf({ username: "farmer", password: PASSWORD });
      const row = repository.rows.get(id) as StoredProxy;
      repository.rows.set(id, { ...row, passwordKeyId: "чужой-ключ" });
      const body = (await call("POST", `/${id}/check`, "own")).json() as CheckBody;
      expect(body.data.ok).toBe(false);
      expect(body.data.message).toMatch(/пароль/i);
      expect(proxyFetch).not.toHaveBeenCalled();
    });
  });

  describe("режимы сервисов", () => {
    it("все сервисы клиента подряд; Bot API — «только напрямую» по умолчанию, остальные — «сначала напрямую»", async () => {
      const body = (await call("GET", "/modes", "adm")).json() as ModesBody;
      expect(body.data.modes.map((item) => item.service)).toEqual([...OUTBOUND_SERVICES]);
      for (const item of body.data.modes) {
        expect(item, item.service).toMatchObject({ mode: item.service === "telegram.bot" ? "direct_only" : "direct_first", custom: false, updatedAt: null });
        expect(item.default).toBe(item.mode);
      }
    });

    it("смена режима сохраняется, в списке виден как свой, аудит несёт было и стало", async () => {
      const response = await call("PUT", "/modes/telegram.bot", "own", { mode: "direct_first" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ data: { service: "telegram.bot", mode: "direct_first", default: "direct_only", custom: true } });
      expect(repository.modeRows.get("telegram.bot")).toMatchObject({ mode: "direct_first" });

      const listed = (await call("GET", "/modes", "adm")).json() as ModesBody;
      expect(listed.data.modes.find((item) => item.service === "telegram.bot")).toMatchObject({ mode: "direct_first", custom: true });

      const entry = (await roles.recentAudit(10)).find((item) => item.action === "outbound.mode");
      expect(entry).toMatchObject({ target: "telegram.bot", before: { mode: "direct_only" }, after: { mode: "direct_first" } });
    });

    it("неизвестный сервис — 404, неизвестный режим — 400, лишнее поле — 400; ничего не записано", async () => {
      expect((await call("PUT", "/modes/no.such", "own", { mode: "proxy_only" })).statusCode).toBe(404);
      expect((await call("PUT", "/modes/fx.cbr", "own", { mode: "always" })).statusCode).toBe(400);
      expect((await call("PUT", "/modes/fx.cbr", "own", { mode: "proxy_only", extra: 1 })).statusCode).toBe(400);
      expect((await call("PUT", "/modes/fx.cbr", "own", {})).statusCode).toBe(400);
      expect(repository.modeRows.size).toBe(0);
    });
  });
});

function rowOf(proxyId: string, extra: Partial<StoredProxy> = {}): StoredProxy {
  return {
    proxyId,
    name: `Прокси ${proxyId}`,
    scheme: "http",
    host: "proxy.example.com",
    port: 3128,
    username: null,
    passwordIv: null,
    passwordTag: null,
    passwordCt: null,
    passwordKeyId: null,
    country: "DE",
    enabled: true,
    priority: 10,
    note: null,
    lastCheckAt: null,
    lastCheckOk: null,
    lastCheckNote: null,
    updatedBy: "00000000-0000-4000-8000-000000000001",
    updatedAt: NOW,
    ...extra,
  };
}

describe("маршруты для клиента исходящих", () => {
  function routesOf(repository: ProxiesRepository, cipher: SecretCipher | null): ProxyRoutes {
    return new ProxyRoutes(config(), repository, cipher, { publish: async () => 1 } as unknown as Redis);
  }

  it("до первого чтения — пусто и умолчания: клиент работает как раньше", () => {
    const routes = routesOf(new MemoryProxies(), null);
    expect(routes.list()).toEqual([]);
    expect(routes.modeOf("telegram.bot")).toBe("direct_only");
    expect(routes.modeOf("fx.cbr")).toBe("direct_first");
  });

  it("только включённые, по priority, с расшифрованным паролем и меткой правки в миллисекундах", async () => {
    const cipher = newCipher();
    const repository = new MemoryProxies();
    repository.rows.set("b", rowOf("b", { priority: 20, ...sealed(sealPassword(cipher, "b", "bee")), username: "u-b", updatedAt: new Date(2_000) }));
    repository.rows.set("a", rowOf("a", { priority: 10, updatedAt: new Date(1_000) }));
    repository.rows.set("off", rowOf("off", { priority: 1, enabled: false }));
    const routes = routesOf(repository, cipher);

    await routes.refresh();

    expect(routes.list()).toEqual([
      { id: "a", scheme: "http", host: "proxy.example.com", port: 3128, username: null, password: null, priority: 10, updatedAt: 1_000 },
      { id: "b", scheme: "http", host: "proxy.example.com", port: 3128, username: "u-b", password: "bee", priority: 20, updatedAt: 2_000 },
    ]);
  });

  it("прокси с нечитаемым паролем в маршруты не попадает: без пароля он всё равно не пройдёт", async () => {
    const repository = new MemoryProxies();
    repository.rows.set("x", rowOf("x", { username: "u", ...sealed(sealPassword(newCipher(), "x", "secret")) }));
    repository.rows.set("y", rowOf("y", { priority: 20 }));
    const routes = routesOf(repository, newCipher());

    await routes.refresh();

    expect(routes.list().map((proxy) => proxy.id)).toEqual(["y"]);
  });

  it("режим из базы сильнее умолчания, остальные — умолчание", async () => {
    const repository = new MemoryProxies();
    await repository.saveMode({ service: "telegram.bot", mode: "proxy_only", updatedBy: "00000000-0000-4000-8000-000000000001", updatedAt: NOW });
    const routes = routesOf(repository, null);

    await routes.refresh();

    expect(routes.modeOf("telegram.bot")).toBe("proxy_only");
    expect(routes.modeOf("fx.cbr")).toBe("direct_first");
  });

  it("строка режима с неизвестным значением игнорируется: работает умолчание", async () => {
    const repository = new MemoryProxies();
    repository.modeRows.set("fx.cbr", { service: "fx.cbr", mode: "всегда" as never, updatedBy: "u", updatedAt: NOW });
    const routes = routesOf(repository, null);
    await routes.refresh();
    expect(routes.modeOf("fx.cbr")).toBe("direct_first");
  });

  it("база недоступна при перечитывании: остаётся последний снимок", async () => {
    const repository = new MemoryProxies();
    repository.rows.set("a", rowOf("a"));
    const routes = routesOf(repository, null);
    await routes.refresh();
    vi.spyOn(repository, "list").mockRejectedValue(new Error("база лежит"));

    await routes.refresh();

    expect(routes.list().map((proxy) => proxy.id)).toEqual(["a"]);
  });
});

/** Колонки строки из запечатанного пароля — как их кладёт сервис. */
function sealed(columns: { passwordIv: Uint8Array; passwordTag: Uint8Array; passwordCt: Uint8Array; passwordKeyId: string }): Partial<StoredProxy> {
  return columns;
}
