import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@nestjs/common";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { DisabledError, DomainError, UnauthorizedError, ValidationError } from "../src/common/domain-error.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE, clearedSessionCookie, parseCookies, sessionCookie } from "../src/modules/admin/admin-cookie.js";
import { CsrfRejectedError, PanelAccessError } from "../src/modules/admin/admin-errors.js";
import { AdminSessionGuard, adminSessionOf } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { accountOf } from "../src/modules/auth/auth.guard.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Cookie-сессия панели (docs/29-admin-panel.md §8; docs/35-stage4-plan.md,
 * WP17). Закрепляется то, где панель обычно течёт: вход без роли, сессия
 * после отзыва роли или блокировки, истёкшая сессия, изменяющий запрос без
 * заголовка панели, cookie без `HttpOnly`.
 */

const NOW = Date.UTC(2026, 8, 26, 10);
const DEV_ENV = { ...AUTH_ENV, NODE_ENV: "development", AUTH_DEV_LOGIN: "true", ADMIN_PANEL_ENABLED: "true", ADMIN_SESSION_TTL_MIN: "60" } as const;

function config(patch: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ ...DEV_ENV, ...patch } as NodeJS.ProcessEnv);
}

function setup(patch: Record<string, string> = {}) {
  const accounts = new MemoryAccountRepository();
  const roles = new MemoryRolesRepository();
  const store = new MemoryAdminSessionStore();
  const cfg = config(patch);
  const rolesService = new RolesService(cfg, roles, accounts);
  const service = new AdminSessionService(cfg, accounts, store, rolesService);
  return { accounts, roles, store, service, guard: new AdminSessionGuard(service), config: cfg };
}

function contextOf(request: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

function requestWith(token: string, method = "GET", headers: Record<string, string> = {}): Record<string, unknown> {
  return { method, headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}`, ...headers } };
}

describe("cookie", () => {
  it("разбирает заголовок и берёт первое значение при повторе имени", () => {
    const cookies = parseCookies(`a=1; ${ADMIN_SESSION_COOKIE}=abc%3Ddef; a=2; broken; =x`);
    expect(cookies.get(ADMIN_SESSION_COOKIE)).toBe("abc=def");
    expect(cookies.get("a")).toBe("1");
    expect(cookies.size).toBe(2);
    expect(parseCookies(undefined).size).toBe(0);
    expect(parseCookies(["x=1", "y=2"]).get("y")).toBe("2");
    expect(parseCookies("bad=%E0%A4%A").get("bad")).toBe("%E0%A4%A");
  });

  it("ставит HttpOnly, SameSite=Strict, путь панели и Secure вне разработки", () => {
    const secure = sessionCookie("tok", 3600, true);
    expect(secure).toBe(`${ADMIN_SESSION_COOKIE}=tok; Max-Age=3600; Path=/api/v1/admin; HttpOnly; SameSite=Strict; Secure`);
    expect(sessionCookie("tok", 60, false)).not.toContain("Secure");
    expect(clearedSessionCookie(true)).toBe(`${ADMIN_SESSION_COOKIE}=; Max-Age=0; Path=/api/v1/admin; HttpOnly; SameSite=Strict; Secure`);
  });
});

describe("конфигурация панели", () => {
  it("включённая панель требует авторизации, срок сессии — в пределах", () => {
    expect(() => loadAppConfig({ NODE_ENV: "test", ADMIN_PANEL_ENABLED: "true" } as NodeJS.ProcessEnv)).toThrow(/AUTH_ENABLED/);
    expect(() => config({ ADMIN_SESSION_TTL_MIN: "1" })).toThrow();
    expect(config().admin).toEqual({ enabled: true, sessionTtlSec: 3600 });
    expect(loadAppConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv).admin).toEqual({ enabled: false, sessionTtlSec: 480 * 60 });
  });
});

describe("вход разработчика", () => {
  it("выключенная панель отвечает 404 — и на вход, и на проверку сессии", async () => {
    const { service } = setup({ ADMIN_PANEL_ENABLED: "false" });
    await expect(service.loginAsDeveloper("dev-1:Ира", NOW)).rejects.toBeInstanceOf(DisabledError);
    await expect(service.authenticate("что-то", NOW)).rejects.toBeInstanceOf(DisabledError);
  });

  it("без флага разработчика вход закрыт, мусор вместо имени — 400", async () => {
    const { service } = setup({ AUTH_DEV_LOGIN: "false", NODE_ENV: "test" });
    await expect(service.loginAsDeveloper("dev-1:Ира", NOW)).rejects.toBeInstanceOf(DisabledError);
    const dev = setup();
    await expect(dev.service.loginAsDeveloper("555:Игрок", NOW)).rejects.toBeInstanceOf(ValidationError);
  });

  it("разработчик входит владельцем: аккаунт, роли, права, срок и запись в журнале", async () => {
    const { service, store, roles, accounts } = setup();
    const login = await service.loginAsDeveloper("dev-1:Ира", NOW);

    expect(login.roles).toEqual(["owner"]);
    expect(login.permissions).toContain("roles.assign");
    expect(login.account.displayName).toBe("Ира");
    expect(login.expiresAtMs).toBe(NOW + 3600_000);
    expect(login.token.length).toBeGreaterThanOrEqual(43);
    expect(store.sessions.get(hashSessionToken(login.token))).toMatchObject({ accountId: login.account.accountId, platformUserId: "dev-1", issuedAtMs: NOW });
    expect(roles.entries.map((entry) => entry.action)).toEqual(["admin.login"]);
    expect(await accounts.byPlatformUser("telegram", "dev-1")).not.toBeNull();
  });

  it("без роли в панель не пускают, даже если аккаунт есть", async () => {
    // Вне машины разработчика флага нет: сессия проверяется через хранилище напрямую.
    const { service, accounts, store } = setup();
    const player = await accounts.upsert({ platform: "telegram", platformUserId: "555", displayName: "Игрок", username: null, photoUrl: null }, NOW);
    await store.put(hashSessionToken("stray"), { accountId: player.accountId, platform: "telegram", platformUserId: "555", issuedAtMs: NOW, expiresAtMs: NOW + 1000 });

    await expect(service.authenticate("stray", NOW)).rejects.toBeInstanceOf(PanelAccessError);
    expect(store.sessions.size).toBe(0);
  });

  it("заблокированный не входит и теряет сессии", async () => {
    const { service, accounts, store } = setup();
    const login = await service.loginAsDeveloper("dev-1:Ира", NOW);
    accounts.ban(login.account.accountId, "спам");

    await expect(service.authenticate(login.token, NOW + 1000)).rejects.toThrow("Аккаунт заблокирован");
    expect(store.sessions.size).toBe(0);
    await expect(service.loginAsDeveloper("dev-1:Ира", NOW)).rejects.toBeInstanceOf(DomainError);
  });
});

describe("проверка сессии", () => {
  let s: ReturnType<typeof setup>;
  let token: string;

  beforeEach(async () => {
    s = setup();
    token = (await s.service.loginAsDeveloper("dev-1:Ира", NOW)).token;
  });

  it("живая сессия даёт аккаунт в форме токена доступа — гвард прав работает без правок", async () => {
    const authenticated = await s.service.authenticate(token, NOW + 1000);
    expect(authenticated.account).toEqual({ accountId: authenticated.session.accountId, platform: "telegram", platformUserId: "dev-1" });
    expect(authenticated.tokenHash).toBe(hashSessionToken(token));
  });

  it("пустой, чужой и истёкший токен — 401; истёкший удаляется", async () => {
    await expect(s.service.authenticate("", NOW)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(s.service.authenticate("nope", NOW)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(s.service.authenticate(token, NOW + 3600_000)).rejects.toThrow(/истекла/);
    expect(s.store.sessions.size).toBe(0);
  });

  it("выход гасит сессию; повторный выход не ошибка", async () => {
    await s.service.logout(hashSessionToken(token));
    await expect(s.service.authenticate(token, NOW)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(s.service.logout(hashSessionToken(token))).resolves.toBeUndefined();
  });

  it("отзыв по аккаунту снимает все его сессии и не трогает чужие", async () => {
    const second = await s.service.loginAsDeveloper("dev-1:Ира", NOW);
    const other = await s.service.loginAsDeveloper("dev-2:Юра", NOW);
    expect(await s.service.revokeAll(second.account.accountId)).toBe(2);
    await expect(s.service.authenticate(other.token, NOW)).resolves.toBeDefined();
  });

  it("identity читает роли заново: снятая роль видна сразу", async () => {
    // Без флага разработчика роли — только из базы: выдаём и снимаем руками.
    const plain = setup({ AUTH_DEV_LOGIN: "false", NODE_ENV: "test" });
    const account = await plain.accounts.upsert({ platform: "telegram", platformUserId: "777", displayName: "Админ", username: null, photoUrl: null }, NOW);
    await plain.roles.grant(account.accountId, "moderator", null);
    await plain.store.put(hashSessionToken("mod"), { accountId: account.accountId, platform: "telegram", platformUserId: "777", issuedAtMs: NOW, expiresAtMs: NOW + 60_000 });

    const before = await plain.service.identity({ accountId: account.accountId, platform: "telegram", platformUserId: "777" });
    expect(before.roles).toEqual(["moderator"]);
    expect(before.permissions).toEqual(["players.view", "players.ban"]);

    await plain.roles.revoke(account.accountId, "moderator");
    await expect(plain.service.authenticate("mod", NOW)).rejects.toBeInstanceOf(PanelAccessError);
    expect(plain.store.sessions.size).toBe(0);
  });
});

describe("гвард", () => {
  let s: ReturnType<typeof setup>;
  let token: string;

  beforeEach(async () => {
    s = setup();
    // Гвард проверяет сессию по настоящим часам, поэтому и открывается она
    // сейчас, а не на фиксированный NOW: иначе тест падал бы через час после
    // NOW — сессия «истекала».
    token = (await s.service.loginAsDeveloper("dev-1:Ира", Date.now())).token;
  });

  it("кладёт аккаунт и хэш сессии в запрос", async () => {
    const request = requestWith(token);
    expect(await s.guard.canActivate(contextOf(request))).toBe(true);
    expect(accountOf(request).platformUserId).toBe("dev-1");
    expect(adminSessionOf(request)).toBe(hashSessionToken(token));
  });

  it("без cookie — 401, с чужой cookie — тоже", async () => {
    await expect(s.guard.canActivate(contextOf({ method: "GET", headers: {} }))).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(s.guard.canActivate(contextOf({ method: "GET", headers: { cookie: "other=1" } }))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("изменяющий запрос без заголовка панели отклоняется, с заголовком — проходит", async () => {
    await expect(s.guard.canActivate(contextOf(requestWith(token, "POST")))).rejects.toBeInstanceOf(CsrfRejectedError);
    await expect(s.guard.canActivate(contextOf(requestWith(token, "post", { [ADMIN_CSRF_HEADER]: "something-else" })))).rejects.toBeInstanceOf(CsrfRejectedError);
    expect(await s.guard.canActivate(contextOf(requestWith(token, "POST", { [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE })))).toBe(true);
    expect(await s.guard.canActivate(contextOf(requestWith(token, "HEAD")))).toBe(true);
  });

  it("сессия без гварда на маршруте — ошибка программиста, а не тихий undefined", () => {
    expect(() => adminSessionOf({})).toThrow(/гвард/);
    expect(() => accountOf({ headers: {} })).toThrow(UnauthorizedError);
  });

  it("не пускает случайный uuid вместо токена", async () => {
    await expect(s.guard.canActivate(contextOf(requestWith(randomUUID())))).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
