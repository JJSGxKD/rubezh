import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { ADMIN_LIMITS } from "../src/modules/admin/admin-limits.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { AdminTasksController } from "../src/modules/admin/admin-tasks.controller.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { NetworkTasksService } from "../src/modules/tasks/network-tasks.service.js";
import { TasksService } from "../src/modules/tasks/tasks.service.js";
import { SourceAvatarRejectedError, SourceAvatarUnavailableError, SourceAvatars, type SourceAvatar, type SourceImage, type SourceRef } from "../src/platforms/ports/source-avatar.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPanelLoginStore } from "./helpers/memory-panel-login.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Картинка источника задания в панели (docs/35-stage4-plan.md Р158):
 * `POST /admin/tasks/source-avatar` отдаёт байты аватарки как есть, а
 * кадрирует и сжимает панель. Право — `tasks.edit`, лимит — 30 за 10 минут.
 */

const OWNER_ID = "777000111";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const URL_PATH = "/api/v1/admin/tasks/source-avatar";

class FakeAvatar implements SourceAvatar {
  readonly platform = "telegram" as const;
  readonly asked: SourceRef[] = [];
  answer: SourceImage | null = { bytes: JPEG, contentType: "image/jpeg" };
  failWith: Error | null = null;

  async fetch(source: SourceRef): Promise<SourceImage | null> {
    this.asked.push(source);
    if (this.failWith !== null) throw this.failWith;
    return this.answer;
  }
}

describe("картинка источника задания по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(avatar: FakeAvatar, store = new MemoryAdminSessionStore(), accounts = new MemoryAccountRepository(), roles = new MemoryRolesRepository()) {
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    @Module({
      controllers: [AdminSessionController, AdminTasksController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: TasksService, useValue: {} },
        { provide: NetworkTasksService, useValue: {} },
        { provide: SourceAvatars, useValue: new SourceAvatars([avatar]) },
        PanelLoginService,
        RateLimiter,
        RolesService,
        PermissionGuard,
        AuthGuard,
        AdminSessionService,
        AdminSessionGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return { server: app, store, accounts, roles };
  }

  async function ownerHeaders(server: NestFastifyApplication): Promise<Record<string, string>> {
    const login = await server.inject({ method: "POST", url: "/api/v1/admin/session/dev", payload: { devUser: `dev-${OWNER_ID}:Владелец` } });
    const cookie = `${ADMIN_SESSION_COOKIE}=${/rubezh_admin_session=([^;]+)/.exec(String(login.headers["set-cookie"]))?.[1] ?? ""}`;
    return { cookie, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE };
  }

  const channel = { kind: "channel", platform: "telegram", chat: "@rubezh_game" };

  it("без сессии — 401, без заголовка панели — 403, без права tasks.edit — 403; адаптер не спрашивали", async () => {
    const avatar = new FakeAvatar();
    const { server, store, accounts, roles } = await start(avatar);
    const headers = await ownerHeaders(server);
    expect((await server.inject({ method: "POST", url: URL_PATH, payload: channel })).statusCode).toBe(401);
    expect((await server.inject({ method: "POST", url: URL_PATH, headers: { cookie: headers.cookie ?? "" }, payload: channel })).statusCode).toBe(403);

    const moderator = await accounts.upsert({ platform: "telegram", platformUserId: "600001", displayName: "Мод", username: null, photoUrl: null }, Date.now());
    await roles.grant(moderator.accountId, "moderator", null);
    await store.put(hashSessionToken("mod"), { accountId: moderator.accountId, platform: "telegram", platformUserId: "600001", issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    const denied = await server.inject({ method: "POST", url: URL_PATH, headers: { cookie: `${ADMIN_SESSION_COOKIE}=mod`, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE }, payload: channel });
    expect(denied.statusCode).toBe(403);
    expect(avatar.asked).toEqual([]);
  });

  it("канал — 200: байты как есть, тип источника, no-store и nosniff", async () => {
    const avatar = new FakeAvatar();
    const { server } = await start(avatar);
    const response = await server.inject({ method: "POST", url: URL_PATH, headers: await ownerHeaders(server), payload: channel });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/jpeg");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(new Uint8Array(response.rawPayload)).toEqual(JPEG);
    expect(avatar.asked).toEqual([{ kind: "channel", chat: "@rubezh_game" }]);
  });

  it("бот и Mini App — по ссылке; тип png и webp передаётся как есть", async () => {
    const avatar = new FakeAvatar();
    avatar.answer = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]), contentType: "image/png" };
    const { server } = await start(avatar);
    const response = await server.inject({ method: "POST", url: URL_PATH, headers: await ownerHeaders(server), payload: { kind: "bot", platform: "telegram", url: "https://t.me/some_bot/app?startapp=x" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(avatar.asked).toEqual([{ kind: "bot", url: "https://t.me/some_bot/app?startapp=x" }]);
  });

  it("у источника нет картинки — 404 source_avatar_missing", async () => {
    const avatar = new FakeAvatar();
    avatar.answer = null;
    const { server } = await start(avatar);
    const response = await server.inject({ method: "POST", url: URL_PATH, headers: await ownerHeaders(server), payload: channel });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "source_avatar_missing" } });
  });

  it("площадка без адаптера (MAX, VK) — 404 source_avatar_missing, а не ошибка сервера", async () => {
    const avatar = new FakeAvatar();
    const { server } = await start(avatar);
    const headers = await ownerHeaders(server);
    for (const platform of ["max", "vk"]) {
      const response = await server.inject({ method: "POST", url: URL_PATH, headers, payload: { ...channel, platform } });
      expect(response.statusCode, platform).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "source_avatar_missing" } });
    }
    expect(avatar.asked).toEqual([]);
  });

  it("источник не разобран — 422; тело не по схеме — 400", async () => {
    const avatar = new FakeAvatar();
    avatar.failWith = new SourceAvatarRejectedError("ссылка не похожа на бота или Mini App Telegram");
    const { server } = await start(avatar);
    const headers = await ownerHeaders(server);
    const bad = await server.inject({ method: "POST", url: URL_PATH, headers, payload: { kind: "bot", platform: "telegram", url: "https://evil.example/x" } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: { code: "source_avatar_invalid" } });

    for (const payload of [
      { kind: "link", platform: "telegram", url: "https://t.me/x_bot" },
      { kind: "channel", platform: "telegram" },
      { kind: "bot", platform: "telegram" },
      { kind: "channel", platform: "icq", chat: "@x_chan" },
      { kind: "bot", platform: "telegram", url: "http://t.me/some_bot" },
      { ...channel, extra: 1 },
      "не объект",
    ]) {
      expect((await server.inject({ method: "POST", url: URL_PATH, headers, payload: payload as Record<string, unknown> })).statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("площадка не ответила — 503 source_avatar_unavailable", async () => {
    const avatar = new FakeAvatar();
    avatar.failWith = new SourceAvatarUnavailableError("Telegram не ответил");
    const { server } = await start(avatar);
    const response = await server.inject({ method: "POST", url: URL_PATH, headers: await ownerHeaders(server), payload: channel });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "source_avatar_unavailable" } });
  });

  it("31-й запрос за десять минут — 429", async () => {
    expect(ADMIN_LIMITS.sourceAvatar).toMatchObject({ limit: 30, windowSec: 600 });
    const avatar = new FakeAvatar();
    const { server } = await start(avatar);
    const headers = await ownerHeaders(server);
    for (let index = 0; index < 30; index += 1) {
      expect((await server.inject({ method: "POST", url: URL_PATH, headers, payload: channel })).statusCode, `запрос ${String(index + 1)}`).toBe(200);
    }
    const limited = await server.inject({ method: "POST", url: URL_PATH, headers, payload: channel });
    expect(limited.statusCode).toBe(429);
    expect(avatar.asked).toHaveLength(30);
  });
});
