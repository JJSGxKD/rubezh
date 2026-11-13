import "reflect-metadata";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { AdminStakeholdersController } from "../src/modules/admin/admin-stakeholders.controller.js";
import { ADMIN_SESSION_STORE } from "../src/modules/admin/admin-session.store.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { StakeholderSharesOverError } from "../src/modules/stakeholders/stakeholder-errors.js";
import { monthKey, type ShareRecord } from "../src/modules/stakeholders/stakeholder-rules.js";
import {
  STAKEHOLDERS_REPOSITORY,
  type ParticipantRow,
  type SetShareInput,
  type SetShareResult,
  type ShareCheck,
  type StakeholdersRepository,
  type StoredShare,
} from "../src/modules/stakeholders/stakeholders.repository.js";
import { StakeholdersService } from "../src/modules/stakeholders/stakeholders.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPanelLoginStore } from "./helpers/memory-panel-login.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Доли участников в панели по HTTP (Р217, tasks/T-0452): `GET /admin/stakeholders` и
 * `PUT /admin/stakeholders/:accountId/share`. Настоящие охранники панели, права и сервис, хранилище долей
 * в памяти; запись в базу, гонку и аудит проверяет интеграционный тест.
 */

const OWNER_ID = "777000222";
const URL_BASE = "/api/v1/admin/stakeholders";

/** Хранилище долей в памяти — то же правило предела, что у базы: проверка идёт через переданный `check`. */
class MemoryStakeholders implements StakeholdersRepository {
  readonly rows: StoredShare[] = [];

  constructor(
    private readonly accounts: MemoryAccountRepository,
    private readonly roles: MemoryRolesRepository,
  ) {}

  async history(): Promise<StoredShare[]> {
    return [...this.rows];
  }

  async participants(): Promise<ParticipantRow[]> {
    const withRole = (await this.roles.assignments()).filter((entry) => entry.role === "stakeholder").map((entry) => entry.accountId);
    const ids = [...new Set([...withRole, ...this.rows.map((row) => row.accountId)])];
    const names = await this.accounts.displayNames(ids);
    return ids.map((accountId) => ({ accountId, displayName: names.get(accountId) ?? "", hasRole: withRole.includes(accountId) }));
  }

  async account(accountId: string): Promise<ParticipantRow | null> {
    const found = await this.accounts.byId(accountId);
    if (found === null) return null;
    return { accountId, displayName: found.displayName, hasRole: (await this.roles.rolesOf(accountId)).includes("stakeholder") };
  }

  async setShare(input: SetShareInput, check: ShareCheck): Promise<SetShareResult> {
    const all: ShareRecord[] = this.rows.map(({ accountId, fromMonth, shareBp }) => ({ accountId, fromMonth, shareBp }));
    const change: ShareRecord = { accountId: input.accountId, fromMonth: input.fromMonth, shareBp: input.shareBp };
    const over = check(all, change);
    if (over !== null) throw new StakeholderSharesOverError(over.month, over.totalBp);
    const index = this.rows.findIndex((row) => row.accountId === input.accountId && row.fromMonth === input.fromMonth);
    const before = index === -1 ? null : { fromMonth: input.fromMonth, shareBp: this.rows[index]!.shareBp };
    const setter = await this.accounts.byId(input.setBy);
    const next: StoredShare = { ...change, note: input.note, setBy: input.setBy, setByName: setter?.displayName ?? "", setAt: input.at };
    if (index === -1) this.rows.push(next);
    else this.rows[index] = next;
    return { before, after: { fromMonth: input.fromMonth, shareBp: input.shareBp } };
  }
}

/** Ближайший будущий месяц по реальным часам: сервис считает «сейчас» сам, поэтому тест не фиксирует даты. */
function monthAhead(offset: number): string {
  const now = new Date();
  return monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)));
}

interface ViewJson {
  data: {
    month: string;
    ownerSharePercent: number;
    participants: { accountId: string; name: string; hasRole: boolean; current: unknown; next: { sharePercent: number; fromMonth: string } | null; history: Record<string, unknown>[] }[];
  };
}

describe("доли участников в панели по HTTP", () => {
  let app: NestFastifyApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start() {
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    const accounts = new MemoryAccountRepository();
    const roles = new MemoryRolesRepository();
    const storage = new MemoryStakeholders(accounts, roles);
    const limiter = { consume: async () => true } as unknown as RateLimiter;
    @Module({
      controllers: [AdminSessionController, AdminStakeholdersController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: new MemoryAdminSessionStore() },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: STAKEHOLDERS_REPOSITORY, useValue: storage },
        { provide: RateLimiter, useValue: limiter },
        StakeholdersService,
        PanelLoginService,
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

    const login = async (user: string) => {
      const response = await app!.inject({ method: "POST", url: "/api/v1/admin/session/dev", payload: { devUser: user } });
      return `${ADMIN_SESSION_COOKIE}=${/rubezh_admin_session=([^;]+)/.exec(String(response.headers["set-cookie"]))?.[1] ?? ""}`;
    };

    /** Человек с ролью: аккаунт заводится входом, роль выдаётся напрямую. */
    const staff = async (id: string, name: string, role: "stakeholder" | "finance" | "moderator") => {
      const account = await accounts.upsert({ platform: "telegram", platformUserId: `dev-player-${id}`, displayName: name, username: null, photoUrl: null }, Date.now());
      await roles.grant(account.accountId, role, null);
      return { accountId: account.accountId, cookie: await login(`dev-player-${id}:${name}`) };
    };

    return { accounts, roles, storage, login, staff };
  }

  const headers = (cookie: string) => ({ cookie, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE });
  const put = (accountId: string, payload: unknown, cookie: string) =>
    app!.inject({ method: "PUT", url: `${URL_BASE}/${accountId}/share`, headers: headers(cookie), payload: payload as Record<string, unknown> });
  const get = (cookie: string) => app!.inject({ method: "GET", url: URL_BASE, headers: headers(cookie) });

  it("без сессии — 401 и на чтении, и на записи", async () => {
    await start();

    expect((await app!.inject({ method: "GET", url: URL_BASE })).statusCode).toBe(401);
    expect((await app!.inject({ method: "PUT", url: `${URL_BASE}/00000000-0000-4000-8000-000000000001/share`, headers: { [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE }, payload: { sharePercent: 10, fromMonth: monthAhead(1), note: "причина" } })).statusCode).toBe(401);
  });

  it("владелец назначает долю: в списке у участника next, ответ PUT — обновлённый список", async () => {
    const ctx = await start();
    const anna = await ctx.staff("931", "Анна", "stakeholder");
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);
    const fromMonth = monthAhead(1);

    const response = await put(anna.accountId, { sharePercent: 25.5, fromMonth, note: "договорённость от 13.11" }, owner);

    expect(response.statusCode).toBe(200);
    const view = response.json<ViewJson>().data;
    expect(view.participants.find((entry) => entry.accountId === anna.accountId)).toMatchObject({ name: "Анна", hasRole: true, current: null, next: { sharePercent: 25.5, fromMonth } });
    expect(view.ownerSharePercent).toBe(100);
    expect(ctx.storage.rows).toHaveLength(1);
    expect(ctx.storage.rows[0]).toMatchObject({ shareBp: 2_550, note: "договорённость от 13.11" });

    // повтор того же запроса — та же запись, а не вторая
    expect((await put(anna.accountId, { sharePercent: 25.5, fromMonth, note: "договорённость от 13.11" }, owner)).statusCode).toBe(200);
    expect(ctx.storage.rows).toHaveLength(1);
  });

  it("участник видит всех участников с долями, но без причин и автора; финансы — с причинами", async () => {
    const ctx = await start();
    const anna = await ctx.staff("932", "Анна", "stakeholder");
    const boris = await ctx.staff("933", "Борис", "stakeholder");
    const finance = await ctx.staff("934", "Финансы", "finance");
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);
    const fromMonth = monthAhead(1);
    expect((await put(anna.accountId, { sharePercent: 30, fromMonth, note: "тайная причина" }, owner)).statusCode).toBe(200);
    expect((await put(boris.accountId, { sharePercent: 20, fromMonth, note: "ещё причина" }, owner)).statusCode).toBe(200);

    const asStakeholder = await get(anna.cookie);
    expect(asStakeholder.statusCode).toBe(200);
    const seen = asStakeholder.json<ViewJson>().data;
    expect(seen.participants.map((entry) => entry.name).sort()).toEqual(["Анна", "Борис"]);
    expect(seen.participants.find((entry) => entry.accountId === boris.accountId)?.next).toMatchObject({ sharePercent: 20, fromMonth });
    for (const entry of seen.participants) {
      for (const item of entry.history) {
        expect(item).not.toHaveProperty("note");
        expect(item).not.toHaveProperty("setBy");
      }
    }
    expect(asStakeholder.body).not.toContain("тайная причина");
    expect(asStakeholder.body).not.toContain("ещё причина");

    const asFinance = await get(finance.cookie);
    expect(asFinance.statusCode).toBe(200);
    const annaHistory = asFinance.json<ViewJson>().data.participants.find((entry) => entry.accountId === anna.accountId)?.history;
    expect(annaHistory?.[0]).toMatchObject({ sharePercent: 30, fromMonth, note: "тайная причина", setBy: expect.any(String) });
    expect((await get(owner)).json<ViewJson>().data.participants).toHaveLength(2);
  });

  it("участник и финансы на PUT — 403, посторонняя роль и на чтении — 403; доли не меняются", async () => {
    const ctx = await start();
    const anna = await ctx.staff("935", "Анна", "stakeholder");
    const finance = await ctx.staff("936", "Финансы", "finance");
    const moderator = await ctx.staff("937", "Модератор", "moderator");
    const body = { sharePercent: 10, fromMonth: monthAhead(1), note: "причина" };

    expect((await put(anna.accountId, body, anna.cookie)).statusCode).toBe(403);
    expect((await put(anna.accountId, body, finance.cookie)).statusCode).toBe(403);
    expect((await put(anna.accountId, body, moderator.cookie)).statusCode).toBe(403);
    expect((await get(moderator.cookie)).statusCode).toBe(403);
    expect(ctx.storage.rows).toHaveLength(0);
  });

  it("тело с лишним полем, долей 101, отрицательной, чужим форматом месяца или короткой причиной — 400", async () => {
    const ctx = await start();
    const anna = await ctx.staff("938", "Анна", "stakeholder");
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);
    const ok = { sharePercent: 10, fromMonth: monthAhead(1), note: "причина" };

    expect((await put(anna.accountId, { ...ok, extra: 1 }, owner)).statusCode).toBe(400);
    expect((await put(anna.accountId, { ...ok, sharePercent: 101 }, owner)).statusCode).toBe(400);
    expect((await put(anna.accountId, { ...ok, sharePercent: -1 }, owner)).statusCode).toBe(400);
    expect((await put(anna.accountId, { ...ok, sharePercent: 12.345 }, owner)).statusCode).toBe(400);
    expect((await put(anna.accountId, { ...ok, fromMonth: "2026-13" }, owner)).statusCode).toBe(400);
    expect((await put(anna.accountId, { ...ok, fromMonth: "2026-1" }, owner)).statusCode).toBe(400);
    expect((await put(anna.accountId, { ...ok, note: "  " }, owner)).statusCode).toBe(400);
    expect((await put(anna.accountId, { ...ok, note: "ab" }, owner)).statusCode).toBe(400);
    expect((await put(anna.accountId, { ...ok, note: "я".repeat(501) }, owner)).statusCode).toBe(400);
    expect((await put(anna.accountId, { sharePercent: 10 }, owner)).statusCode).toBe(400);
    expect((await put("не-идентификатор", ok, owner)).statusCode).toBe(400);
    expect(ctx.storage.rows).toHaveLength(0);
  });

  it("месяц в прошлом — 400 stakeholder_month_past, сумма больше 100 % — 409, нет роли — 409, нет аккаунта — 404", async () => {
    const ctx = await start();
    const anna = await ctx.staff("939", "Анна", "stakeholder");
    const boris = await ctx.staff("940", "Борис", "stakeholder");
    const stranger = await ctx.accounts.upsert({ platform: "telegram", platformUserId: "dev-player-941", displayName: "Без роли", username: null, photoUrl: null }, Date.now());
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);
    const fromMonth = monthAhead(1);

    const past = await put(anna.accountId, { sharePercent: 10, fromMonth: monthAhead(-1), note: "причина" }, owner);
    expect(past.statusCode).toBe(400);
    expect(past.json<{ error: { code: string } }>().error.code).toBe("stakeholder_month_past");

    expect((await put(anna.accountId, { sharePercent: 60, fromMonth, note: "причина" }, owner)).statusCode).toBe(200);
    const over = await put(boris.accountId, { sharePercent: 60, fromMonth, note: "причина" }, owner);
    expect(over.statusCode).toBe(409);
    expect(over.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: "stakeholder_shares_over" });
    expect(over.json<{ error: { message: string } }>().error.message).toContain("120");

    const noRole = await put(stranger.accountId, { sharePercent: 5, fromMonth, note: "причина" }, owner);
    expect(noRole.statusCode).toBe(409);
    expect(noRole.json<{ error: { code: string } }>().error.code).toBe("stakeholder_role_required");
    expect((await put(stranger.accountId, { sharePercent: 0, fromMonth, note: "причина" }, owner)).statusCode).toBe(200);

    expect((await put("00000000-0000-4000-8000-000000000009", { sharePercent: 5, fromMonth, note: "причина" }, owner)).statusCode).toBe(404);
  });
});
