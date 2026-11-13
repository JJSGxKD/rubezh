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
import type { ArticleView, CreateArticleInput, CreatePlaceInput, PlaceView, UpdatePlaceInput } from "../src/modules/ledger/ledger-chart.js";
import { LedgerChartService } from "../src/modules/ledger/ledger-chart.service.js";
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
 * Журнал учёта в панели по HTTP (Р219, tasks/T-0457): `GET /admin/ledger/balances` и `GET /admin/ledger/journal`;
 * места хранения и статьи (Р220, tasks/T-0460): `/admin/ledger/places` и `/admin/ledger/articles`.
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

const PLACE: PlaceView = {
  placeId: "bank.karta-t-banka",
  name: "Карта Т-Банка",
  currency: "RUB",
  archived: false,
  balance: "0.00",
  fee: null,
  accounts: [{ accountId: "bank.karta-t-banka", name: "Карта Т-Банка", balance: "0.00" }],
};

const ARTICLE: ArticleView = { articleId: "vps", kind: "expense", name: "Сервер (VPS)", system: false, archived: false };

/** Подменный сервис мест и статей: помнит вызовы и отдаёт готовые ответы. */
class FakeChart {
  readonly calls: { method: string; actor: string | null; args: unknown[] }[] = [];

  private record(method: string, actor: { accountId: string } | null, ...args: unknown[]): void {
    this.calls.push({ method, actor: actor?.accountId ?? null, args });
  }

  async places(): Promise<PlaceView[]> {
    this.record("places", null);
    return [PLACE];
  }

  async createPlace(actor: { accountId: string }, input: CreatePlaceInput): Promise<PlaceView> {
    this.record("createPlace", actor, input);
    return PLACE;
  }

  async updatePlace(actor: { accountId: string }, placeId: string, input: UpdatePlaceInput): Promise<PlaceView> {
    this.record("updatePlace", actor, placeId, input);
    return PLACE;
  }

  async archivePlace(actor: { accountId: string }, placeId: string): Promise<void> {
    this.record("archivePlace", actor, placeId);
  }

  async articles(): Promise<ArticleView[]> {
    this.record("articles", null);
    return [ARTICLE];
  }

  async createArticle(actor: { accountId: string }, input: CreateArticleInput): Promise<ArticleView> {
    this.record("createArticle", actor, input);
    return ARTICLE;
  }

  async renameArticle(actor: { accountId: string }, articleId: string, name: string): Promise<ArticleView> {
    this.record("renameArticle", actor, articleId, name);
    return ARTICLE;
  }

  async archiveArticle(actor: { accountId: string }, articleId: string): Promise<void> {
    this.record("archiveArticle", actor, articleId);
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
    const chart = new FakeChart();
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
        { provide: LedgerChartService, useValue: chart },
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

    return { ledger, chart, login, staff };
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

  const send = (method: "POST" | "PATCH", path: string, cookie: string, payload: unknown) => app!.inject({ method, url: `${BASE}${path}`, headers: headers(cookie), payload: payload as object });

  it("места и статьи читает тот, кто видит журнал: финансы — 200, маркетолог — 403", async () => {
    const ctx = await start();
    const finance = await ctx.staff("970", "Финансы", "finance");
    const marketer = await ctx.staff("971", "Маркетолог", "marketer");

    const places = await get("/places", finance);
    expect(places.statusCode).toBe(200);
    expect(places.json()).toEqual({ data: { places: [PLACE] } });
    const articles = await get("/articles", finance);
    expect(articles.statusCode).toBe(200);
    expect(articles.json()).toEqual({ data: { articles: [ARTICLE] } });

    expect((await get("/places", marketer)).statusCode).toBe(403);
    expect((await get("/articles", marketer)).statusCode).toBe(403);
    expect(ctx.chart.calls.map((call) => call.method)).toEqual(["places", "articles"]);
  });

  it("маркетолог, администратор и участник проекта не меняют места и статьи: 403, сервис не вызывается", async () => {
    const ctx = await start();
    const staffCookies = [await ctx.staff("972", "Маркетолог", "marketer"), await ctx.staff("973", "Администратор", "admin"), await ctx.staff("974", "Участник", "stakeholder")];

    for (const cookie of staffCookies) {
      expect((await send("POST", "/places", cookie, { name: "Карта", currency: "RUB" })).statusCode).toBe(403);
      expect((await send("PATCH", "/places/bank.rub", cookie, { name: "Банк" })).statusCode).toBe(403);
      expect((await send("POST", "/places/bank.rub/archive", cookie, {})).statusCode).toBe(403);
      expect((await send("POST", "/articles", cookie, { name: "Аренда", kind: "expense" })).statusCode).toBe(403);
      expect((await send("PATCH", "/articles/vps", cookie, { name: "Сервер" })).statusCode).toBe(403);
      expect((await send("POST", "/articles/vps/archive", cookie, {})).statusCode).toBe(403);
    }
    expect(ctx.chart.calls).toHaveLength(0);
  });

  it("финансы заводят место: 200, в сервис уходят разобранные название, валюта и шаблон комиссии, автор — аккаунт", async () => {
    const ctx = await start();
    const finance = await ctx.staff("975", "Финансы", "finance");

    const response = await send("POST", "/places", finance, { name: "Карта Т-Банка", currency: "RUB", fee: { percentBp: 150, fixed: "10.50", fixedCurrency: "RUB" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { place: PLACE } });
    const call = ctx.chart.calls[0];
    expect(call?.method).toBe("createPlace");
    expect(call?.actor).not.toBeNull();
    expect(call?.args).toEqual([{ name: "Карта Т-Банка", currency: "RUB", fee: { percentBp: 150, fixed: "10.50", fixedCurrency: "RUB" } }]);
  });

  it("место без шаблона комиссии тоже заводится, а владелец проходит так же, как финансы", async () => {
    const ctx = await start();
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);

    expect((await send("POST", "/places", owner, { name: "Копилка", currency: "USD" })).statusCode).toBe(200);
    expect(ctx.chart.calls[0]?.args).toEqual([{ name: "Копилка", currency: "USD" }]);
  });

  it.each([
    ["валюта «ABC» вне справочника", { name: "Карта", currency: "ABC" }],
    ["валюта строчными", { name: "Карта", currency: "rub" }],
    ["без названия", { currency: "RUB" }],
    ["пустое название из пробелов", { name: "   ", currency: "RUB" }],
    ["лишнее поле — схема строгая", { name: "Карта", currency: "RUB", balance: "100" }],
    ["процент больше 100", { name: "Карта", currency: "RUB", fee: { percentBp: 10_001 } }],
    ["процент дробью", { name: "Карта", currency: "RUB", fee: { percentBp: 1.5 } }],
    ["фикса не числом", { name: "Карта", currency: "RUB", fee: { fixed: "много", fixedCurrency: "RUB" } }],
    ["валюта фиксы вне справочника", { name: "Карта", currency: "RUB", fee: { fixed: "1", fixedCurrency: "ABC" } }],
    ["лишнее поле в шаблоне", { name: "Карта", currency: "RUB", fee: { percent: 2 } }],
  ])("заведение места: %s — 400, сервис не вызывается", async (_title, payload) => {
    const ctx = await start();
    const finance = await ctx.staff("976", "Финансы", "finance");

    const response = await send("POST", "/places", finance, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("validation_failed");
    expect(ctx.chart.calls).toHaveLength(0);
  });

  it("правка места: название и шаблон доходят до сервиса, null снимает шаблон; пустое тело и чужие поля — 400", async () => {
    const ctx = await start();
    const finance = await ctx.staff("977", "Финансы", "finance");

    expect((await send("PATCH", "/places/stars.bot", finance, { fee: null })).statusCode).toBe(200);
    expect((await send("PATCH", "/places/bank.rub", finance, { name: "Банк", fee: { percentBp: 0 } })).statusCode).toBe(200);
    expect(ctx.chart.calls.map((call) => call.args)).toEqual([
      ["stars.bot", { fee: null }],
      ["bank.rub", { name: "Банк", fee: { percentBp: 0 } }],
    ]);

    expect((await send("PATCH", "/places/bank.rub", finance, {})).statusCode).toBe(400);
    expect((await send("PATCH", "/places/bank.rub", finance, { currency: "USD" })).statusCode).toBe(400);
    expect((await send("PATCH", "/places/BANK%20RUB", finance, { name: "Банк" })).statusCode).toBe(400);
    expect(ctx.chart.calls).toHaveLength(2);
  });

  it("архив места и статьи: 200 с телом { data: { ok: true } }", async () => {
    const ctx = await start();
    const finance = await ctx.staff("978", "Финансы", "finance");

    const place = await send("POST", "/places/bank.rub/archive", finance, {});
    const article = await send("POST", "/articles/vps/archive", finance, {});

    expect(place.statusCode).toBe(200);
    expect(place.json()).toEqual({ data: { ok: true } });
    expect(article.statusCode).toBe(200);
    expect(ctx.chart.calls.map((call) => [call.method, call.args[0]])).toEqual([
      ["archivePlace", "bank.rub"],
      ["archiveArticle", "vps"],
    ]);
  });

  it("статьи: заведение и переименование; вид только expense или income, название обязательно, лишнее — 400", async () => {
    const ctx = await start();
    const finance = await ctx.staff("979", "Финансы", "finance");

    expect((await send("POST", "/articles", finance, { name: "Аренда", kind: "expense" })).statusCode).toBe(200);
    expect((await send("PATCH", "/articles/vps", finance, { name: "Сервер" })).statusCode).toBe(200);
    expect(ctx.chart.calls.map((call) => call.args)).toEqual([[{ name: "Аренда", kind: "expense" }], ["vps", "Сервер"]]);

    expect((await send("POST", "/articles", finance, { name: "Аренда", kind: "revenue" })).statusCode).toBe(400);
    expect((await send("POST", "/articles", finance, { name: "Аренда" })).statusCode).toBe(400);
    expect((await send("POST", "/articles", finance, { name: "Аренда", kind: "expense", system: true })).statusCode).toBe(400);
    expect((await send("PATCH", "/articles/vps", finance, { name: "" })).statusCode).toBe(400);
    expect((await send("PATCH", "/articles/vps", finance, { name: "Сервер", kind: "income" })).statusCode).toBe(400);
    expect(ctx.chart.calls).toHaveLength(2);
  });
});
