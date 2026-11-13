import "reflect-metadata";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminLedgerController } from "../src/modules/admin/admin-ledger.controller.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE } from "../src/modules/admin/admin-session.store.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { LedgerCursorInvalidError } from "../src/modules/ledger/ledger-errors.js";
import type { AccountBalanceView, JournalFilterInput, JournalPage } from "../src/modules/ledger/ledger-view.js";
import { LedgerService } from "../src/modules/ledger/ledger.service.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import type { Role } from "../src/modules/roles/permissions.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPanelLoginStore } from "./helpers/memory-panel-login.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Журнал учёта в панели по HTTP (Р219, tasks/T-0457): `GET /admin/ledger/balances` и `GET /admin/ledger/journal`.
 * Настоящие охранники панели и права, сервис учёта подменён: что он считает и как пишет в базу, проверяют
 * `ledger-journal.test.ts` и интеграционный тест; здесь — кто и с какими параметрами пускается к журналу.
 */

const OWNER_ID = "777000222";
const BASE = "/api/v1/admin/ledger";

const BALANCES: AccountBalanceView[] = [
  { accountId: "stars.bot.hold", name: "Звёзды бота — в холде", type: "asset", currency: "XTR", balance: "50" },
  { accountId: "revenue.shop.telegram", name: "Выручка: магазин, Telegram", type: "revenue", currency: "XTR", balance: "50" },
];

const PAGE: JournalPage = {
  entries: [
    {
      entryId: "00000000-0000-4000-8000-000000000001",
      sourceKey: "purchase:42:paid",
      at: "2026-11-13T12:00:00.000Z",
      period: "2026-11",
      memo: "Набор «Старт»",
      reversalOf: null,
      createdBy: null,
      meta: null,
      lines: [
        { accountId: "stars.bot.hold", accountName: "Звёзды бота — в холде", currency: "XTR", amount: "50" },
        { accountId: "revenue.shop.telegram", accountName: "Выручка: магазин, Telegram", currency: "XTR", amount: "-50" },
      ],
    },
  ],
  next: "следующая-страница",
};

/** Подменный сервис: помнит, с чем его позвали, и отдаёт готовые ответы. */
class FakeLedger {
  readonly journalCalls: { filter: JournalFilterInput; cursor: string | null; limit: number | undefined }[] = [];
  balanceCalls = 0;
  cursorIsBad = false;

  async balances(): Promise<AccountBalanceView[]> {
    this.balanceCalls += 1;
    return BALANCES;
  }

  async journal(filter: JournalFilterInput, cursor: string | null, limit?: number): Promise<JournalPage> {
    this.journalCalls.push({ filter, cursor, limit });
    if (this.cursorIsBad) throw new LedgerCursorInvalidError();
    return PAGE;
  }
}

describe("журнал учёта в панели по HTTP", () => {
  let app: NestFastifyApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start() {
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    const accounts = new MemoryAccountRepository();
    const roles = new MemoryRolesRepository();
    const ledger = new FakeLedger();
    const limiter = { consume: async () => true } as unknown as RateLimiter;
    @Module({
      controllers: [AdminSessionController, AdminLedgerController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: new MemoryAdminSessionStore() },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: LedgerService, useValue: ledger },
        { provide: AppLinks, useValue: new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]) },
        { provide: RateLimiter, useValue: limiter },
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
    const staff = async (id: string, name: string, role: Role) => {
      const account = await accounts.upsert({ platform: "telegram", platformUserId: `dev-player-${id}`, displayName: name, username: null, photoUrl: null }, Date.now());
      await roles.grant(account.accountId, role, null);
      return await login(`dev-player-${id}:${name}`);
    };

    return { ledger, login, staff };
  }

  const headers = (cookie: string) => ({ cookie, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE });
  const get = (path: string, cookie: string) => app!.inject({ method: "GET", url: `${BASE}${path}`, headers: headers(cookie) });

  it("без сессии — 401 на остатках и на журнале", async () => {
    const { ledger } = await start();

    expect((await app!.inject({ method: "GET", url: `${BASE}/balances` })).statusCode).toBe(401);
    expect((await app!.inject({ method: "GET", url: `${BASE}/journal` })).statusCode).toBe(401);
    expect(ledger.balanceCalls).toBe(0);
    expect(ledger.journalCalls).toHaveLength(0);
  });

  it("участник проекта, маркетолог и администратор — 403: права ledger.view у них нет, сервис не вызывается", async () => {
    const ctx = await start();
    const stakeholder = await ctx.staff("951", "Участник", "stakeholder");
    const marketer = await ctx.staff("952", "Маркетолог", "marketer");
    const admin = await ctx.staff("953", "Администратор", "admin");

    for (const cookie of [stakeholder, marketer, admin]) {
      expect((await get("/balances", cookie)).statusCode).toBe(403);
      expect((await get("/journal", cookie)).statusCode).toBe(403);
    }
    expect(ctx.ledger.balanceCalls).toBe(0);
    expect(ctx.ledger.journalCalls).toHaveLength(0);
  });

  it("финансы и владелец видят остатки: { data: { accounts } }", async () => {
    const ctx = await start();
    const finance = await ctx.staff("954", "Финансы", "finance");
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);

    for (const cookie of [finance, owner]) {
      const response = await get("/balances", cookie);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { accounts: BALANCES } });
    }
  });

  it("финансы и владелец видят журнал: { data: { entries, next } }, без параметров — лимит 50 и пустой фильтр", async () => {
    const ctx = await start();
    const finance = await ctx.staff("955", "Финансы", "finance");
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);

    for (const cookie of [finance, owner]) {
      const response = await get("/journal", cookie);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: PAGE });
    }
    expect(ctx.ledger.journalCalls[0]).toEqual({ filter: {}, cursor: null, limit: 50 });
  });

  it("параметры журнала доходят до сервиса: счёт, валюта, период, ключ по префиксу, курсор, лимит", async () => {
    const ctx = await start();
    const finance = await ctx.staff("956", "Финансы", "finance");

    const response = await get("/journal?account=stars.bot.hold&currency=XTR&from=2026-10&to=2026-11&source=purchase%3A&cursor=abc_DEF-1&limit=20", finance);

    expect(response.statusCode).toBe(200);
    expect(ctx.ledger.journalCalls).toEqual([{ filter: { accountId: "stars.bot.hold", currency: "XTR", from: "2026-10", to: "2026-11", sourcePrefix: "purchase:" }, cursor: "abc_DEF-1", limit: 20 }]);
  });

  it("пустые параметры фильтра — как будто их нет: форма панели шлёт «account=»", async () => {
    const ctx = await start();
    const finance = await ctx.staff("957", "Финансы", "finance");

    expect((await get("/journal?account=&currency=&from=&to=&source=&cursor=", finance)).statusCode).toBe(200);

    expect(ctx.ledger.journalCalls[0]).toEqual({ filter: {}, cursor: null, limit: 50 });
  });

  it.each(["limit=500", "limit=101", "limit=0", "limit=-1", "limit=abc", "limit=1.5", "limit=20&limit=30"])("недопустимый лимит %s — 400, сервис не вызывается", async (query) => {
    const ctx = await start();
    const finance = await ctx.staff("958", "Финансы", "finance");

    const response = await get(`/journal?${query}`, finance);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("validation_failed");
    expect(ctx.ledger.journalCalls).toHaveLength(0);
  });

  it("границы лимита 1 и 100 проходят", async () => {
    const ctx = await start();
    const finance = await ctx.staff("959", "Финансы", "finance");

    expect((await get("/journal?limit=1", finance)).statusCode).toBe(200);
    expect((await get("/journal?limit=100", finance)).statusCode).toBe(200);
    expect(ctx.ledger.journalCalls.map((call) => call.limit)).toEqual([1, 100]);
  });

  it.each(["from=2026-13", "from=2026-1", "to=26-11", "from=2026-11-01", "from=2026-12&to=2026-11", "unknown=1", "account=a&account=b", `account=${"a".repeat(65)}`, `source=${"s".repeat(129)}`, "currency=xtr", "cursor=%20%20"])(
    "некорректный запрос %s — 400",
    async (query) => {
      const ctx = await start();
      const finance = await ctx.staff("960", "Финансы", "finance");

      expect((await get(`/journal?${query}`, finance)).statusCode).toBe(400);
      expect(ctx.ledger.journalCalls).toHaveLength(0);
    },
  );

  it("остатки не принимают лишних параметров: строгая схема, а не молчаливое игнорирование", async () => {
    const ctx = await start();
    const finance = await ctx.staff("961", "Финансы", "finance");

    expect((await get("/balances?period=2026-11", finance)).statusCode).toBe(400);
    expect(ctx.ledger.balanceCalls).toBe(0);
  });

  it("нечитаемый курсор — ошибка сервиса доходит как 400 ledger_cursor_invalid", async () => {
    const ctx = await start();
    const finance = await ctx.staff("962", "Финансы", "finance");
    ctx.ledger.cursorIsBad = true;

    const response = await get("/journal?cursor=broken", finance);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("ledger_cursor_invalid");
  });

  it("журнал только читается: запись, правка и удаление по HTTP не заведены — 404", async () => {
    const ctx = await start();
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);

    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await app!.inject({ method, url: `${BASE}/journal`, headers: headers(owner), payload: {} });
      expect(response.statusCode, method).toBe(404);
    }
  });
});
