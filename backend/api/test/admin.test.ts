import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminReviewController } from "../src/modules/admin/admin-review.controller.js";
import { AdminRolesController } from "../src/modules/admin/admin-roles.controller.js";
import { AdminRolesService } from "../src/modules/admin/admin-roles.service.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import type { FunnelMilestones, FunnelRepository } from "../src/modules/funnel/funnel.repository.js";
import { FUNNEL_REPOSITORY } from "../src/modules/funnel/funnel.repository.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { LEADERBOARD_STORE } from "../src/modules/runs/leaderboard.store.js";
import { RunsViewService } from "../src/modules/runs/runs-view.service.js";
import { RUNS_REPOSITORY } from "../src/modules/runs/runs.repository.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryLeaderboardStore, MemoryRunsRepository } from "./helpers/memory-runs.js";

/**
 * Панель по HTTP (docs/29-admin-panel.md §4, §8): cookie ставится и снимается
 * ответом, изменяющие запросы требуют заголовка панели, права проверяются тем
 * же гвардом, что у игры, выключенная панель отвечает 404.
 */

const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

class FakeFunnel implements FunnelRepository {
  calls: Array<{ from: Date; to: Date }> = [];
  async entered(): Promise<void> {}
  async appOpened(): Promise<void> {}
  async firstRunStarted(): Promise<void> {}
  async runRecorded(): Promise<void> {}
  async firstPurchase(): Promise<void> {}
  async milestones(): Promise<FunnelMilestones | null> {
    return null;
  }
  async report(from: Date, to: Date): Promise<[]> {
    this.calls.push({ from, to });
    return [];
  }
}

describe("панель по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  let accounts: MemoryAccountRepository;
  let roles: MemoryRolesRepository;
  let store: MemoryAdminSessionStore;
  let funnel: FakeFunnel;

  async function start(env: Record<string, string> = {}): Promise<NestFastifyApplication> {
    accounts = new MemoryAccountRepository();
    roles = new MemoryRolesRepository();
    store = new MemoryAdminSessionStore();
    funnel = new FakeFunnel();
    const config = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_PANEL_ENABLED: "true", ...env } as NodeJS.ProcessEnv);

    @Module({
      controllers: [AdminSessionController, AdminRolesController, AdminReviewController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: FUNNEL_REPOSITORY, useValue: funnel },
        { provide: RUNS_REPOSITORY, useValue: new MemoryRunsRepository() },
        { provide: LEADERBOARD_STORE, useValue: new MemoryLeaderboardStore() },
        RateLimiter,
        RolesService,
        PermissionGuard,
        RunsViewService,
        AdminSessionService,
        AdminSessionGuard,
        AdminRolesService,
      ],
    })
    class TestModule {}

    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  }

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function login(server: NestFastifyApplication, devUser = "dev-1:Ира"): Promise<string> {
    const response = await server.inject({ method: "POST", url: "/api/v1/admin/session/dev", payload: { devUser } });
    expect(response.statusCode).toBe(201);
    const cookie = response.headers["set-cookie"];
    const line = Array.isArray(cookie) ? cookie[0] : cookie;
    expect(line).toContain("HttpOnly");
    expect(line).toContain("SameSite=Strict");
    expect(line).toContain("Path=/api/v1/admin");
    // Разработка — без Secure: панель открыта по http на localhost.
    expect(line).not.toContain("Secure");
    return `${ADMIN_SESSION_COOKIE}=${/rubezh_admin_session=([^;]+)/.exec(line ?? "")?.[1] ?? ""}`;
  }

  it("выключенная панель отвечает 404 на вход и на сессию", async () => {
    const server = await start({ ADMIN_PANEL_ENABLED: "false" });
    expect((await server.inject({ method: "POST", url: "/api/v1/admin/session/dev", payload: { devUser: "dev-1:Ира" } })).statusCode).toBe(404);
    expect((await server.inject({ method: "GET", url: "/api/v1/admin/session" })).statusCode).toBe(404);
  });

  it("вход ставит cookie, сессия отвечает ролями и правами, выход снимает cookie", async () => {
    const server = await start();
    const cookie = await login(server);

    const me = await server.inject({ method: "GET", url: "/api/v1/admin/session", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.roles).toEqual(["owner"]);
    expect(me.json().data.account.displayName).toBe("Ира");

    const logout = await server.inject({ method: "POST", url: "/api/v1/admin/session/logout", headers: { cookie, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE } });
    expect(logout.statusCode).toBe(201);
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");
    expect((await server.inject({ method: "GET", url: "/api/v1/admin/session", headers: { cookie } })).statusCode).toBe(401);
  });

  it("без cookie — 401, изменяющий запрос без заголовка панели — 403 csrf_rejected", async () => {
    const server = await start();
    const cookie = await login(server);
    expect((await server.inject({ method: "GET", url: "/api/v1/admin/session" })).statusCode).toBe(401);

    const csrf = await server.inject({ method: "POST", url: "/api/v1/admin/session/logout", headers: { cookie } });
    expect(csrf.statusCode).toBe(403);
    expect(csrf.json().error.code).toBe("csrf_rejected");
  });

  it("мусор во входе — 400, а не 500", async () => {
    const server = await start();
    const response = await server.inject({ method: "POST", url: "/api/v1/admin/session/dev", payload: { devUser: "" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_failed");
  });

  it("права решает тот же гвард: владелец читает роли, модератор — нет", async () => {
    const server = await start();
    const ownerCookie = await login(server);
    expect((await server.inject({ method: "GET", url: "/api/v1/admin/roles", headers: { cookie: ownerCookie } })).statusCode).toBe(200);

    // Модератор без флага разработчика: сессия кладётся в хранилище напрямую.
    const moderator = await accounts.upsert({ platform: "telegram", platformUserId: "600001", displayName: "Мод", username: null, photoUrl: null }, Date.now());
    await roles.grant(moderator.accountId, "moderator", null);
    await store.put(hashSessionToken("mod"), { accountId: moderator.accountId, platform: "telegram", platformUserId: "600001", issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    const denied = await server.inject({ method: "GET", url: "/api/v1/admin/roles", headers: { cookie: `${ADMIN_SESSION_COOKIE}=mod` } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("forbidden");
    // Очередь разбора модератору открыта: право players.view у него есть.
    expect((await server.inject({ method: "GET", url: "/api/v1/admin/runs/review", headers: { cookie: `${ADMIN_SESSION_COOKIE}=mod` } })).statusCode).toBe(200);
  });

  it("выдача и отзыв роли из панели: снятая последняя роль гасит сессии панели", async () => {
    const server = await start();
    const cookie = await login(server);
    const headers = { cookie, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE };
    const target = await accounts.upsert({ platform: "telegram", platformUserId: "600002", displayName: "Юра", username: null, photoUrl: null }, Date.now());
    await store.put(hashSessionToken("yura"), { accountId: target.accountId, platform: "telegram", platformUserId: "600002", issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });

    const granted = await server.inject({ method: "POST", url: "/api/v1/admin/roles/grant", headers, payload: { platformUserId: "600002", role: "analyst" } });
    expect(granted.statusCode).toBe(201);
    expect(granted.json().data).toEqual({ granted: true });
    const list = await server.inject({ method: "GET", url: "/api/v1/admin/roles", headers: { cookie } });
    expect(list.json().data.assignments).toEqual([expect.objectContaining({ accountId: target.accountId, displayName: "Юра", role: "analyst" })]);

    const revoked = await server.inject({ method: "POST", url: "/api/v1/admin/roles/revoke", headers, payload: { accountId: target.accountId, role: "analyst" } });
    expect(revoked.json().data).toEqual({ revoked: true, sessionsRevoked: 1 });
    expect(store.sessions.has(hashSessionToken("yura"))).toBe(false);

    const unknown = await server.inject({ method: "POST", url: "/api/v1/admin/roles/grant", headers, payload: { platformUserId: "0", role: "analyst" } });
    expect(unknown.statusCode).toBe(400);
    const audit = await server.inject({ method: "GET", url: "/api/v1/admin/audit?limit=10", headers: { cookie } });
    expect(audit.json().data.entries.map((entry: { action: string }) => entry.action)).toEqual(["roles.revoke", "roles.assign", "admin.login"]);
  });

  it("воронка: период по умолчанию — тридцать дней, обратный период — 400", async () => {
    const server = await start();
    const cookie = await login(server);
    const ok = await server.inject({ method: "GET", url: "/api/v1/admin/funnel", headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    const [call] = funnel.calls;
    expect(call && call.to.getTime() - call.from.getTime()).toBe(30 * 86_400_000);

    const reversed = await server.inject({ method: "GET", url: "/api/v1/admin/funnel?from=2026-09-20T00:00:00Z&to=2026-09-10T00:00:00Z", headers: { cookie } });
    expect(reversed.statusCode).toBe(400);
    const garbage = await server.inject({ method: "GET", url: "/api/v1/admin/funnel?from=вчера", headers: { cookie } });
    expect(garbage.statusCode).toBe(400);
  });

  it("случайный токен в cookie не открывает панель", async () => {
    const server = await start();
    const response = await server.inject({ method: "GET", url: "/api/v1/admin/session", headers: { cookie: `${ADMIN_SESSION_COOKIE}=${randomUUID()}` } });
    expect(response.statusCode).toBe(401);
  });
});
