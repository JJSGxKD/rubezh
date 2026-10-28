import "reflect-metadata";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { AdminNameRulesController } from "../src/modules/admin/admin-name-rules.controller.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import type { NameRulesCache } from "../src/modules/name-rules/name-rules-cache.service.js";
import type { NameRulesRepository, StoredNameRule } from "../src/modules/name-rules/name-rules.repository.js";
import { NameRulesService } from "../src/modules/name-rules/name-rules.service.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPanelLoginStore } from "./helpers/memory-panel-login.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Правила фильтра имён в панели по HTTP (tasks/T-0338): сессия, право
 * names.edit, разбор тела и полный круг. Слова нейтральные.
 */

const OWNER_ID = "777000333";

class MemoryNameRules implements NameRulesRepository {
  readonly rows = new Map<string, StoredNameRule>();

  async list(): Promise<StoredNameRule[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  async listActive(): Promise<StoredNameRule[]> {
    return (await this.list()).filter((row) => row.active);
  }

  async findByKey(category: string, kind: string, pattern: string): Promise<StoredNameRule | null> {
    return [...this.rows.values()].find((row) => row.category === category && row.kind === kind && row.pattern === pattern) ?? null;
  }

  async count(): Promise<number> {
    return this.rows.size;
  }

  async insert(row: StoredNameRule): Promise<void> {
    this.rows.set(row.ruleId, { ...row });
  }

  async update(ruleId: string, patch: Partial<Pick<StoredNameRule, "category" | "kind" | "pattern" | "active" | "note">>, at: Date, by: string | null): Promise<StoredNameRule | null> {
    const row = this.rows.get(ruleId);
    if (row === undefined) return null;
    const next = { ...row, ...patch, updatedAt: at, updatedBy: by };
    this.rows.set(ruleId, next);
    return { ...next };
  }

  async remove(ruleId: string): Promise<boolean> {
    return this.rows.delete(ruleId);
  }
}

describe("правила фильтра имён в панели по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function person(accounts: MemoryAccountRepository, roles: MemoryRolesRepository, id: string, role: "game_designer" | "moderator"): Promise<AccountRef> {
    const account = await accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, Date.now());
    await roles.grant(account.accountId, role, null);
    return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
  }

  it("без сессии — 401, геймдизайнеру — 403, модератору — чтение; полный круг у владельца", async () => {
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    const accounts = new MemoryAccountRepository();
    const roles = new MemoryRolesRepository();
    const repository = new MemoryNameRules();
    const published: string[] = [];
    const cache = { publishChanged: async (ruleId: string) => void published.push(ruleId) } as unknown as NameRulesCache;
    const service = new NameRulesService(repository, cache, new RolesService(cfg, roles, accounts));
    const store = new MemoryAdminSessionStore();

    @Module({
      controllers: [AdminSessionController, AdminNameRulesController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: AppLinks, useValue: new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]) },
        { provide: NameRulesService, useValue: service },
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

    expect((await app.inject({ method: "GET", url: "/api/v1/admin/name-rules" })).statusCode).toBe(401);

    const designer = await person(accounts, roles, "901", "game_designer");
    await store.put(hashSessionToken("designer"), { ...designer, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    const asDesigner = { cookie: `${ADMIN_SESSION_COOKIE}=designer` };
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/name-rules", headers: asDesigner })).statusCode).toBe(403);

    const moderator = await person(accounts, roles, "902", "moderator");
    await store.put(hashSessionToken("mod"), { ...moderator, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    const asModerator = { cookie: `${ADMIN_SESSION_COOKIE}=mod` };
    const listed = await app.inject({ method: "GET", url: "/api/v1/admin/name-rules", headers: asModerator });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ data: { rules: unknown[]; limits: { patternMax: number } } }>().data).toMatchObject({ rules: [], limits: { patternMax: 100 } });

    const login = await app.inject({ method: "POST", url: "/api/v1/admin/session/dev", payload: { devUser: `dev-${OWNER_ID}:Владелец` } });
    const cookie = `${ADMIN_SESSION_COOKIE}=${/rubezh_admin_session=([^;]+)/.exec(String(login.headers["set-cookie"]))?.[1] ?? ""}`;
    const headers = { cookie, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE };

    // без заголовка панели изменяющая ручка закрыта
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/name-rules", headers: { cookie }, payload: { category: "brand", kind: "exact", pattern: "пример-бренд" } })).statusCode).toBe(403);

    const dangerous = await app.inject({ method: "POST", url: "/api/v1/admin/name-rules", headers, payload: { category: "ads", kind: "regex", pattern: "(a+)+" } });
    expect(dangerous.statusCode).toBe(400);
    expect(dangerous.json<{ error: { code: string } }>().error.code).toBe("name_rule_invalid");
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/name-rules", headers, payload: { category: "brand", kind: "exact", pattern: "пример", лишнее: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/name-rules", headers, payload: { category: "spam", kind: "exact", pattern: "пример" } })).statusCode).toBe(400);

    const created = await app.inject({ method: "POST", url: "/api/v1/admin/name-rules", headers, payload: { category: "brand", kind: "exact", pattern: "пример-бренд", note: "чужой бренд" } });
    expect(created.statusCode).toBe(201);
    const rule = created.json<{ data: { ruleId: string; active: boolean } }>().data;
    expect(rule.active).toBe(true);

    const duplicate = await app.inject({ method: "POST", url: "/api/v1/admin/name-rules", headers, payload: { category: "brand", kind: "exact", pattern: "ПРИМЕР-бренд" } });
    expect(duplicate.statusCode).toBe(409);

    const after = await app.inject({ method: "GET", url: "/api/v1/admin/name-rules", headers });
    expect(after.json<{ data: { rules: { ruleId: string }[] } }>().data.rules.map((item) => item.ruleId)).toEqual([rule.ruleId]);

    // PATCH: хотя бы одно поле, id в пути — uuid
    expect((await app.inject({ method: "PATCH", url: `/api/v1/admin/name-rules/${rule.ruleId}`, headers, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/api/v1/admin/name-rules/не-uuid", headers, payload: { active: false } })).statusCode).toBe(400);
    const patched = await app.inject({ method: "PATCH", url: `/api/v1/admin/name-rules/${rule.ruleId}`, headers, payload: { active: false, note: null } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<{ data: { active: boolean; note: string | null } }>().data).toMatchObject({ active: false, note: null });
    expect((await app.inject({ method: "PATCH", url: "/api/v1/admin/name-rules/00000000-0000-4000-8000-0000000000ff", headers, payload: { active: true } })).statusCode).toBe(404);

    // проверка на примерах ничего не пишет
    const before = published.length;
    const probe = await app.inject({ method: "POST", url: "/api/v1/admin/name-rules/test", headers, payload: { category: "brand", kind: "exact", pattern: "пример-бренд", samples: ["Вася пример-бренд"] } });
    expect(probe.statusCode).toBe(200);
    expect(probe.json<{ data: { results: unknown[] } }>().data.results).toEqual([{ sample: "Вася пример-бренд", name: "Вася", verdict: "symbols", candidateHit: true, saved: false }]);
    expect(published).toHaveLength(before);
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/name-rules/test", headers, payload: { category: "brand", kind: "exact", pattern: "пример", samples: [] } })).statusCode).toBe(400);

    const removed = await app.inject({ method: "DELETE", url: `/api/v1/admin/name-rules/${rule.ruleId}`, headers });
    expect(removed.statusCode).toBe(200);
    expect(removed.json<{ data: { removed: boolean } }>().data).toEqual({ removed: true });
    expect(repository.rows.size).toBe(0);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/admin/name-rules/${rule.ruleId}`, headers })).statusCode).toBe(404);
  });
});
