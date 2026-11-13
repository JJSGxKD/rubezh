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
import { AdminMediaController } from "../src/modules/admin/admin-media.controller.js";
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
import { LedgerOperationInvalidError, LedgerOperationNotDraftError, LedgerOperationNotPendingError } from "../src/modules/ledger/operations/operation-errors.js";
import type { OperationInput } from "../src/modules/ledger/operations/operation-input.js";
import type { OperationPage, OperationView } from "../src/modules/ledger/operations/operation-view.js";
import type { OperationFilter } from "../src/modules/ledger/operations/operations.repository.js";
import { OperationsService } from "../src/modules/ledger/operations/operations.service.js";
import { IMAGE_FILE, imageIdOf, imagePath } from "../src/modules/media/image-rules.js";
import { MediaController } from "../src/modules/media/media.controller.js";
import { MEDIA_REPOSITORY } from "../src/modules/media/media.repository.js";
import { MediaService } from "../src/modules/media/media.service.js";
import { LedgerTemplateInvalidError } from "../src/modules/ledger/templates/template-errors.js";
import type { CreateTemplateInput, UpdateTemplateInput } from "../src/modules/ledger/templates/template-input.js";
import { TemplatesService, type DraftPeriodResult, type TemplateView } from "../src/modules/ledger/templates/templates.service.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import type { Role } from "../src/modules/roles/permissions.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryMedia } from "./helpers/memory-media.js";
import { MemoryPanelLoginStore } from "./helpers/memory-panel-login.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Журнал учёта в панели по HTTP (Р219, tasks/T-0457): `GET /admin/ledger/balances` и `GET /admin/ledger/journal`;
 * места хранения и статьи (Р220, tasks/T-0460): `/admin/ledger/places` и `/admin/ledger/articles`;
 * ручные операции (Р220, tasks/T-0461): `/admin/ledger/operations`;
 * шаблоны повторяющихся расходов (Р220, tasks/T-0463): `/admin/ledger/templates`.
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

const OPERATION_ID = "00000000-0000-4000-8000-0000000000a1";

const OPERATION: OperationView = {
  operationId: OPERATION_ID,
  kind: "expense",
  status: "draft",
  input: { kind: "expense", note: "Оплата сервера за ноябрь", at: "2026-11-10", from: "bank.rub", article: "vps", amount: "1500" },
  amountUsd: "18.75",
  createdBy: "00000000-0000-4000-8000-0000000000b1",
  createdAt: "2026-11-13T12:00:00.000Z",
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  templateId: null,
  templatePeriod: null,
  receiptMissing: false,
  entry: null,
  loan: null,
};

const OPERATION_PAGE: OperationPage = { operations: [OPERATION], next: null };

/** Подменный сервис операций: помнит вызовы с автором и отдаёт готовые ответы; может отказать, как настоящий. */
class FakeOperations {
  readonly calls: { method: string; actor: string | null; args: unknown[] }[] = [];
  failWith: Error | null = null;

  private record(method: string, actor: { accountId: string } | null, ...args: unknown[]): void {
    this.calls.push({ method, actor: actor?.accountId ?? null, args });
    if (this.failWith !== null) throw this.failWith;
  }

  async list(filter: OperationFilter, cursor: string | null, limit: number): Promise<OperationPage> {
    this.record("list", null, filter, cursor, limit);
    return OPERATION_PAGE;
  }

  async get(operationId: string): Promise<OperationView> {
    this.record("get", null, operationId);
    return OPERATION;
  }

  async create(actor: { accountId: string }, input: OperationInput): Promise<OperationView> {
    this.record("create", actor, input);
    return OPERATION;
  }

  async update(actor: { accountId: string }, operationId: string, input: OperationInput): Promise<OperationView> {
    this.record("update", actor, operationId, input);
    return OPERATION;
  }

  async submit(actor: { accountId: string }, operationId: string): Promise<OperationView> {
    this.record("submit", actor, operationId);
    return { ...OPERATION, status: "posted" };
  }

  async discard(actor: { accountId: string }, operationId: string): Promise<void> {
    this.record("discard", actor, operationId);
  }

  async approve(actor: { accountId: string }, operationId: string, note?: string): Promise<OperationView> {
    this.record("approve", actor, operationId, note);
    return { ...OPERATION, status: "posted" };
  }

  async reject(actor: { accountId: string }, operationId: string, note: string): Promise<OperationView> {
    this.record("reject", actor, operationId, note);
    return { ...OPERATION, status: "rejected", decisionNote: note };
  }
}

/** WebP без потерь (`VP8L`) нужных сторон: заголовок настоящий, содержимое — заполнитель. */
function receiptWebp(width: number, height: number): Buffer {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const body = Buffer.from([0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff, ...new Array<number>(16).fill(7)]);
  const header = Buffer.alloc(20);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(12 + body.length, 4);
  header.write("WEBPVP8L", 8, "latin1");
  header.writeUInt32LE(body.length, 16);
  return Buffer.concat([header, body]);
}

const TEMPLATE: TemplateView = {
  templateId: "vps",
  name: "VPS",
  articleId: "vps",
  articleName: "Сервер (VPS)",
  placeAccountId: "bank.karta-t-banka",
  placeName: "Карта Т-Банка",
  currency: "RUB",
  amount: "1500.00",
  schedule: "monthly",
  month: null,
  note: null,
  archived: false,
};

const DRAFT_RESULT: DraftPeriodResult = { period: "2026-11", created: 1, existing: 0, failed: [] };

/** Подменный сервис шаблонов: помнит вызовы с автором и отдаёт готовые ответы; может отказать, как настоящий. */
class FakeTemplates {
  readonly calls: { method: string; actor: string | null; args: unknown[] }[] = [];
  failWith: Error | null = null;

  private record(method: string, actor: { accountId: string } | null, ...args: unknown[]): void {
    this.calls.push({ method, actor: actor?.accountId ?? null, args });
    if (this.failWith !== null) throw this.failWith;
  }

  async list(): Promise<TemplateView[]> {
    this.record("list", null);
    return [TEMPLATE];
  }

  async create(actor: { accountId: string }, input: CreateTemplateInput): Promise<TemplateView> {
    this.record("create", actor, input);
    return TEMPLATE;
  }

  async update(actor: { accountId: string }, templateId: string, input: UpdateTemplateInput): Promise<TemplateView> {
    this.record("update", actor, templateId, input);
    return TEMPLATE;
  }

  async archive(actor: { accountId: string }, templateId: string): Promise<void> {
    this.record("archive", actor, templateId);
  }

  async draftPeriod(actor: { accountId: string }, period: string): Promise<DraftPeriodResult> {
    this.record("draftPeriod", actor, period);
    return DRAFT_RESULT;
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
    const operations = new FakeOperations();
    const templates = new FakeTemplates();
    const limiter = { consume: async () => true } as unknown as RateLimiter;
    const images = new MemoryMedia();
    @Module({
      controllers: [AdminSessionController, AdminLedgerController, AdminMediaController, MediaController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: new MemoryAdminSessionStore() },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: LedgerService, useValue: ledger },
        { provide: LedgerChartService, useValue: chart },
        { provide: OperationsService, useValue: operations },
        { provide: MEDIA_REPOSITORY, useValue: images },
        MediaService,
        { provide: TemplatesService, useValue: templates },
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

    return { ledger, chart, operations, templates, images, login, staff };
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

  // ---- Ручные операции (Р220, tasks/T-0461) ----

  const EXPENSE_BODY = { kind: "expense", note: "Оплата сервера за ноябрь", at: "2026-11-10", from: "bank.rub", article: "vps", amount: "1500" };

  /** Правильное тело каждого вида: сервис получает ровно его, без добавленных и потерянных полей. */
  const BODIES: Record<string, object> = {
    transfer: { kind: "transfer", note: "Перевод на карту", at: "2026-11-10", from: "bank.rub", to: "bank.tbank", amount: "1000", fee: { amount: "15", fixed: { amount: "0.05", currency: "GRAM", from: "wallet.ton" } } },
    exchange: { kind: "exchange", note: "Вывод 10 000 ⭐ через Fragment", at: "2026-11-10T09:30:00Z", from: "stars.bot.available", to: "wallet.ton", given: "10000", received: "52.3", receipt: { payer: "individual", number: "1" } },
    expense: EXPENSE_BODY,
    income: { kind: "income", note: "Выплата AdsGram за октябрь", at: "2026-11-10", to: "bank.rub", article: "ads_adsgram", amount: "120.40", forMonth: "2026-10", link: "https://example.com/report" },
    loan: { kind: "loan", note: "Заём на рекламу", at: "2026-11-10", to: "bank.rub", lender: "Иван Петров", amount: "100000", premium: "10000", repaymentBp: 2500 },
    reversal: { kind: "reversal", note: "Оплатили с другого счёта", at: "2026-11-10", sourceKey: "op:00000000-0000-4000-8000-0000000000a1" },
  };

  it("операции читает тот, кто видит журнал: финансы и владелец — 200, маркетолог, администратор и участник проекта — 403", async () => {
    const ctx = await start();
    const finance = await ctx.staff("980", "Финансы", "finance");
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);
    const denied = [await ctx.staff("981", "Маркетолог", "marketer"), await ctx.staff("982", "Администратор", "admin"), await ctx.staff("983", "Участник", "stakeholder")];

    for (const cookie of [finance, owner]) {
      const list = await get("/operations", cookie);
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({ data: OPERATION_PAGE });
      const one = await get(`/operations/${OPERATION_ID}`, cookie);
      expect(one.statusCode).toBe(200);
      expect(one.json()).toEqual({ data: { operation: OPERATION } });
    }
    for (const cookie of denied) {
      expect((await get("/operations", cookie)).statusCode).toBe(403);
      expect((await get(`/operations/${OPERATION_ID}`, cookie)).statusCode).toBe(403);
    }
    expect(ctx.operations.calls.map((call) => call.method)).toEqual(["list", "get", "list", "get"]);
  });

  it("список: параметры доходят до сервиса, без параметров — страница в 50 записей без фильтров", async () => {
    const ctx = await start();
    const finance = await ctx.staff("984", "Финансы", "finance");

    expect((await get("/operations", finance)).statusCode).toBe(200);
    expect((await get("/operations?status=pending&kind=loan&cursor=abc_DEF-1&limit=20", finance)).statusCode).toBe(200);
    expect((await get("/operations?status=&kind=&cursor=", finance)).statusCode).toBe(200);

    expect(ctx.operations.calls.map((call) => call.args)).toEqual([
      [{ status: undefined, kind: undefined }, null, 50],
      [{ status: "pending", kind: "loan" }, "abc_DEF-1", 20],
      [{ status: undefined, kind: undefined }, null, 50],
    ]);
  });

  it.each(["status=done", "kind=payout", "limit=0", "limit=101", "limit=abc", "unknown=1", "cursor=%20%20", "status=draft&status=posted"])("список: некорректный запрос %s — 400", async (query) => {
    const ctx = await start();
    const finance = await ctx.staff("985", "Финансы", "finance");

    expect((await get(`/operations?${query}`, finance)).statusCode).toBe(400);
    expect(ctx.operations.calls).toHaveLength(0);
  });

  it("операция по идентификатору: не uuid — 400, сервис не вызывается", async () => {
    const ctx = await start();
    const finance = await ctx.staff("986", "Финансы", "finance");

    for (const id of ["abc", "123", "00000000-0000-4000-8000-00000000000g", "%20"]) {
      expect((await get(`/operations/${id}`, finance)).statusCode, id).toBe(400);
    }
    expect(ctx.operations.calls).toHaveLength(0);
  });

  it("участник проекта, маркетолог и администратор не вносят и не проводят операции: 403, сервис не вызывается", async () => {
    const ctx = await start();
    const staffCookies = [await ctx.staff("987", "Участник", "stakeholder"), await ctx.staff("988", "Маркетолог", "marketer"), await ctx.staff("989", "Администратор", "admin")];

    for (const cookie of staffCookies) {
      expect((await send("POST", "/operations", cookie, EXPENSE_BODY)).statusCode).toBe(403);
      expect((await send("PATCH", `/operations/${OPERATION_ID}`, cookie, EXPENSE_BODY)).statusCode).toBe(403);
      expect((await send("POST", `/operations/${OPERATION_ID}/submit`, cookie, {})).statusCode).toBe(403);
      expect((await send("POST", `/operations/${OPERATION_ID}/discard`, cookie, {})).statusCode).toBe(403);
    }
    expect(ctx.operations.calls).toHaveLength(0);
  });

  it("без сессии — 401 на внесении и на проведении", async () => {
    const ctx = await start();

    expect((await app!.inject({ method: "POST", url: `${BASE}/operations`, payload: EXPENSE_BODY })).statusCode).toBe(401);
    expect((await app!.inject({ method: "POST", url: `${BASE}/operations/${OPERATION_ID}/submit`, payload: {} })).statusCode).toBe(401);
    expect(ctx.operations.calls).toHaveLength(0);
  });

  it.each(Object.keys(BODIES))("финансы вносят операцию вида %s: 200, в сервис уходит тело как есть, автор — аккаунт", async (kind) => {
    const ctx = await start();
    const finance = await ctx.staff("990", "Финансы", "finance");

    const response = await send("POST", "/operations", finance, BODIES[kind]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { operation: OPERATION } });
    const call = ctx.operations.calls[0];
    expect(call?.method).toBe("create");
    expect(call?.actor).not.toBeNull();
    expect(call?.args).toEqual([BODIES[kind]]);
  });

  it("владелец вносит так же, как финансы", async () => {
    const ctx = await start();
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);

    expect((await send("POST", "/operations", owner, EXPENSE_BODY)).statusCode).toBe(200);
    expect(ctx.operations.calls[0]?.method).toBe("create");
  });

  it("лишнее поле в теле — 400, и в теле каждого вида, и в комиссии, и в чеке", async () => {
    const ctx = await start();
    const finance = await ctx.staff("991", "Финансы", "finance");

    for (const kind of Object.keys(BODIES)) {
      expect((await send("POST", "/operations", finance, { ...BODIES[kind], extra: 1 })).statusCode, kind).toBe(400);
    }
    expect((await send("POST", "/operations", finance, { ...BODIES.transfer, fee: { percent: 2 } })).statusCode).toBe(400);
    expect((await send("POST", "/operations", finance, { ...BODIES.exchange, receipt: { payer: "legal", picture: "x" } })).statusCode).toBe(400);
    expect(ctx.operations.calls).toHaveLength(0);
  });

  it.each([
    ["без вида", { ...EXPENSE_BODY, kind: undefined }],
    ["неизвестный вид", { ...EXPENSE_BODY, kind: "payout" }],
    ["отрицательная сумма", { ...EXPENSE_BODY, amount: "-5" }],
    ["сумма с порядком", { ...EXPENSE_BODY, amount: "1e3" }],
    ["сумма числом, а не строкой", { ...EXPENSE_BODY, amount: 1500 }],
    ["сумма с запятой", { ...EXPENSE_BODY, amount: "1,5" }],
    ["причина короче трёх знаков", { ...EXPENSE_BODY, note: "ab" }],
    ["без причины", { ...EXPENSE_BODY, note: undefined }],
    ["ссылка не https", { ...EXPENSE_BODY, link: "http://example.com/check" }],
    ["дата словами", { ...EXPENSE_BODY, at: "вчера" }],
    ["без даты", { ...EXPENSE_BODY, at: undefined }],
    ["пустое место", { ...EXPENSE_BODY, from: "" }],
    ["чужой вид поля: «received» у расхода", { ...EXPENSE_BODY, received: "1" }],
    ["месяц поступления вне 01–12", { ...BODIES.income, forMonth: "2026-13" }],
    ["ставка погашения больше 100 %", { ...BODIES.loan, repaymentBp: 10_001 }],
    ["валюта фиксы вне справочника", { ...BODIES.transfer, fee: { fixed: { amount: "1", currency: "ABC" } } }],
    ["плательщик чека не из списка", { ...BODIES.exchange, receipt: { payer: "company" } }],
  ])("внесение: %s — 400 validation_failed, сервис не вызывается", async (_title, body) => {
    const ctx = await start();
    const finance = await ctx.staff("992", "Финансы", "finance");

    const response = await send("POST", "/operations", finance, body);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("validation_failed");
    expect(ctx.operations.calls).toHaveLength(0);
  });

  it("ошибка схемы называет поле: форма операции длинная, «некорректно» без названия бесполезно", async () => {
    const ctx = await start();
    const finance = await ctx.staff("993", "Финансы", "finance");

    const response = await send("POST", "/operations", finance, { ...EXPENSE_BODY, amount: "-5" });

    expect(response.json<{ error: { message: string } }>().error.message).toContain("«amount»");
  });

  it("правка, проведение и удаление: финансы — 200, идентификатор и автор доходят до сервиса", async () => {
    const ctx = await start();
    const finance = await ctx.staff("994", "Финансы", "finance");

    const updated = await send("PATCH", `/operations/${OPERATION_ID}`, finance, EXPENSE_BODY);
    const submitted = await send("POST", `/operations/${OPERATION_ID}/submit`, finance, {});
    const discarded = await send("POST", `/operations/${OPERATION_ID}/discard`, finance, {});

    expect(updated.json()).toEqual({ data: { operation: OPERATION } });
    expect(submitted.json()).toEqual({ data: { operation: { ...OPERATION, status: "posted" } } });
    expect(discarded.json()).toEqual({ data: { ok: true } });
    expect(ctx.operations.calls.map((call) => [call.method, call.args[0]])).toEqual([
      ["update", OPERATION_ID],
      ["submit", OPERATION_ID],
      ["discard", OPERATION_ID],
    ]);
    expect(ctx.operations.calls.every((call) => call.actor !== null)).toBe(true);
  });

  it("правка, проведение и удаление: идентификатор не uuid — 400; правка с неверным телом — 400", async () => {
    const ctx = await start();
    const finance = await ctx.staff("995", "Финансы", "finance");

    expect((await send("PATCH", "/operations/abc", finance, EXPENSE_BODY)).statusCode).toBe(400);
    expect((await send("POST", "/operations/abc/submit", finance, {})).statusCode).toBe(400);
    expect((await send("POST", "/operations/abc/discard", finance, {})).statusCode).toBe(400);
    expect((await send("PATCH", `/operations/${OPERATION_ID}`, finance, { ...EXPENSE_BODY, amount: "-1" })).statusCode).toBe(400);
    expect(ctx.operations.calls).toHaveLength(0);
  });

  it("отказы сервиса доходят как есть: сборка — 400 ledger_operation_invalid с текстом, не черновик — 409", async () => {
    const ctx = await start();
    const finance = await ctx.staff("996", "Финансы", "finance");

    ctx.operations.failWith = new LedgerOperationInvalidError("Откуда: места хранения «bank.net» нет");
    const invalid = await send("POST", "/operations", finance, EXPENSE_BODY);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: "ledger_operation_invalid", message: "Откуда: места хранения «bank.net» нет" });

    ctx.operations.failWith = new LedgerOperationNotDraftError(OPERATION_ID, "posted");
    const conflict = await send("PATCH", `/operations/${OPERATION_ID}`, finance, EXPENSE_BODY);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ error: { code: string } }>().error.code).toBe("ledger_operation_not_draft");
  });

  // ---- Второй ключ и снимок чека (Р220, tasks/T-0462) ----

  it("подтверждает и отклоняет только владелец: финансы, администратор и маркетолог — 403, сервис не вызывается; без сессии — 401", async () => {
    const ctx = await start();
    const others = [await ctx.staff("1001", "Финансы", "finance"), await ctx.staff("1002", "Администратор", "admin"), await ctx.staff("1003", "Маркетолог", "marketer")];

    for (const cookie of others) {
      expect((await send("POST", `/operations/${OPERATION_ID}/approve`, cookie, {})).statusCode).toBe(403);
      expect((await send("POST", `/operations/${OPERATION_ID}/reject`, cookie, { note: "Не согласовано" })).statusCode).toBe(403);
    }
    expect((await app!.inject({ method: "POST", url: `${BASE}/operations/${OPERATION_ID}/approve`, payload: {} })).statusCode).toBe(401);
    expect(ctx.operations.calls).toHaveLength(0);
  });

  it("владелец: approve с комментарием и без, reject с причиной — сервису уходят id, автор и текст; ответ — операция", async () => {
    const ctx = await start();
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);

    const approved = await send("POST", `/operations/${OPERATION_ID}/approve`, owner, { note: "Согласовано" });
    const quiet = await send("POST", `/operations/${OPERATION_ID}/approve`, owner, {});
    const rejected = await send("POST", `/operations/${OPERATION_ID}/reject`, owner, { note: "Сумма не сходится" });

    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toEqual({ data: { operation: { ...OPERATION, status: "posted" } } });
    expect(quiet.statusCode).toBe(200);
    expect(rejected.json()).toEqual({ data: { operation: { ...OPERATION, status: "rejected", decisionNote: "Сумма не сходится" } } });
    expect(ctx.operations.calls.map((call) => [call.method, call.args])).toEqual([
      ["approve", [OPERATION_ID, "Согласовано"]],
      ["approve", [OPERATION_ID, undefined]],
      ["reject", [OPERATION_ID, "Сумма не сходится"]],
    ]);
    expect(ctx.operations.calls.every((call) => call.actor !== null)).toBe(true);
  });

  it("решение с неверным телом — 400 и сервис не вызывается: reject без причины, короткая причина, лишнее поле, плохой id", async () => {
    const ctx = await start();
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);

    expect((await send("POST", `/operations/${OPERATION_ID}/reject`, owner, {})).statusCode).toBe(400);
    expect((await send("POST", `/operations/${OPERATION_ID}/reject`, owner, { note: "  " })).statusCode).toBe(400);
    expect((await send("POST", `/operations/${OPERATION_ID}/reject`, owner, { note: "ab" })).statusCode).toBe(400);
    expect((await send("POST", `/operations/${OPERATION_ID}/approve`, owner, { note: "Согласовано", extra: 1 })).statusCode).toBe(400);
    expect((await send("POST", `/operations/${OPERATION_ID}/approve`, owner, { note: "x".repeat(501) })).statusCode).toBe(400);
    expect((await send("POST", "/operations/abc/approve", owner, {})).statusCode).toBe(400);
    expect((await send("POST", "/operations/abc/reject", owner, { note: "Нет такой" })).statusCode).toBe(400);
    expect(ctx.operations.calls).toHaveLength(0);
  });

  it("повторное решение доходит как 409 ledger_operation_not_pending", async () => {
    const ctx = await start();
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);
    ctx.operations.failWith = new LedgerOperationNotPendingError(OPERATION_ID, "posted");

    const response = await send("POST", `/operations/${OPERATION_ID}/approve`, owner, {});

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("ledger_operation_not_pending");
  });

  const uploadReceipt = (cookie: string, bytes: Buffer, profile = "finance_receipt") =>
    app!.inject({ method: "POST", url: "/api/v1/admin/media/images", headers: headers(cookie), payload: { profile, data: bytes.toString("base64") } });

  it("снимок чека: финансам и владельцу загрузка — 201, маркетологу — 403; 640×480 принимается, сторона меньше 300 или больше 1600 — нет", async () => {
    const ctx = await start();
    const finance = await ctx.staff("1010", "Финансы", "finance");
    const marketer = await ctx.staff("1011", "Маркетолог", "marketer");
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);
    const receipt = receiptWebp(640, 480);

    expect((await uploadReceipt(marketer, receipt)).statusCode).toBe(403);
    expect(ctx.images.rows.size).toBe(0);
    const uploaded = await uploadReceipt(finance, receipt);
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json()).toMatchObject({ data: { imageId: imageIdOf(receipt), width: 640, height: 480 } });
    expect((await uploadReceipt(owner, receiptWebp(1_600, 300))).statusCode).toBe(201);
    expect((await uploadReceipt(finance, receiptWebp(640, 299))).statusCode).toBe(400);
    expect((await uploadReceipt(finance, receiptWebp(1_601, 400))).statusCode).toBe(400);
  });

  it("снимок чека показывают только тем, кто видит учёт: финансы и владелец — 200, маркетолог и администратор — 403, без сессии — 401; игроку — 404", async () => {
    const ctx = await start();
    const finance = await ctx.staff("1012", "Финансы", "finance");
    const marketer = await ctx.staff("1013", "Маркетолог", "marketer");
    const admin = await ctx.staff("1014", "Администратор", "admin");
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);
    const receipt = receiptWebp(640, 480);
    const { imageId } = (await uploadReceipt(finance, receipt)).json<{ data: { imageId: string } }>().data;
    const adminPath = `/api/v1/admin/media/${imageId}.webp`;
    expect(IMAGE_FILE.test(`${imageId}.webp`)).toBe(true);

    for (const cookie of [finance, owner]) {
      const shown = await app!.inject({ method: "GET", url: adminPath, headers: headers(cookie) });
      expect(shown.statusCode).toBe(200);
      expect(shown.rawPayload.equals(receipt)).toBe(true);
      // Чек — не публичная картинка: ни CDN, ни общий кеш его хранить не должны.
      expect(String(shown.headers["cache-control"])).toMatch(/private/);
      expect(String(shown.headers["cache-control"])).not.toMatch(/public/);
    }
    for (const cookie of [marketer, admin]) expect((await app!.inject({ method: "GET", url: adminPath, headers: headers(cookie) })).statusCode).toBe(403);
    expect((await app!.inject({ method: "GET", url: adminPath })).statusCode).toBe(401);

    // Адреса игрока для чека нет, даже когда картинка уже в памяти реплики после показа в панели.
    expect((await app!.inject({ method: "GET", url: imagePath(imageId) })).statusCode).toBe(404);
  });

  it("картинки других профилей закрытие не задевает: слайд главной видит любой вошедший в панель и игрок", async () => {
    const ctx = await start();
    const marketer = await ctx.staff("1015", "Маркетолог", "marketer");
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);
    const square = receiptWebp(512, 512);

    expect((await uploadReceipt(owner, square, "home_slide")).statusCode).toBe(201);
    const imageId = imageIdOf(square);

    expect((await app!.inject({ method: "GET", url: `/api/v1/admin/media/${imageId}.webp`, headers: headers(marketer) })).statusCode).toBe(200);
    expect((await app!.inject({ method: "GET", url: imagePath(imageId) })).statusCode).toBe(200);
  });

  const TEMPLATE_BODY = { name: "VPS", articleId: "vps", placeAccountId: "bank.karta-t-banka", amount: "1500.00", schedule: "monthly" };

  it("шаблоны читает тот, кто видит журнал: финансы и владелец — 200, маркетолог, администратор и участник проекта — 403", async () => {
    const ctx = await start();
    const finance = await ctx.staff("1001", "Финансы", "finance");
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);
    const denied = [await ctx.staff("1002", "Маркетолог", "marketer"), await ctx.staff("1003", "Администратор", "admin"), await ctx.staff("1004", "Участник", "stakeholder")];

    for (const cookie of [finance, owner]) {
      const list = await get("/templates", cookie);
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({ data: { templates: [TEMPLATE] } });
    }
    for (const cookie of denied) expect((await get("/templates", cookie)).statusCode).toBe(403);
    expect(ctx.templates.calls.map((call) => call.method)).toEqual(["list", "list"]);
  });

  it("шаблоны не заводят, не правят, не архивируют и не запускают маркетолог, администратор и участник проекта: 403, сервис не вызывается", async () => {
    const ctx = await start();
    const denied = [await ctx.staff("1005", "Маркетолог", "marketer"), await ctx.staff("1006", "Администратор", "admin"), await ctx.staff("1007", "Участник", "stakeholder")];

    for (const cookie of denied) {
      expect((await send("POST", "/templates", cookie, TEMPLATE_BODY)).statusCode).toBe(403);
      expect((await send("PATCH", "/templates/vps", cookie, { amount: "1600" })).statusCode).toBe(403);
      expect((await send("POST", "/templates/vps/archive", cookie, {})).statusCode).toBe(403);
      expect((await send("POST", "/templates/draft-period", cookie, { period: "2026-11" })).statusCode).toBe(403);
    }
    expect(ctx.templates.calls).toHaveLength(0);
  });

  it("без сессии — 401 на заведении и на «Расходах месяца»", async () => {
    const ctx = await start();
    const bare = (url: string, payload: object) => app!.inject({ method: "POST", url: `${BASE}${url}`, payload });
    expect((await bare("/templates", TEMPLATE_BODY)).statusCode).toBe(401);
    expect((await bare("/templates/draft-period", { period: "2026-11" })).statusCode).toBe(401);
    expect(ctx.templates.calls).toHaveLength(0);
  });

  it("финансы заводят, правят и архивируют шаблон: разобранное тело и автор доходят до сервиса", async () => {
    const ctx = await start();
    const finance = await ctx.staff("1008", "Финансы", "finance");

    const created = await send("POST", "/templates", finance, { ...TEMPLATE_BODY, schedule: "yearly", month: 3, note: "Регистратор" });
    const updated = await send("PATCH", "/templates/vps", finance, { amount: "1600", month: null, note: null });
    const archived = await send("POST", "/templates/vps/archive", finance, {});

    expect(created.json()).toEqual({ data: { template: TEMPLATE } });
    expect(updated.json()).toEqual({ data: { template: TEMPLATE } });
    expect(archived.json()).toEqual({ data: { ok: true } });
    expect(ctx.templates.calls.map((call) => [call.method, ...call.args])).toEqual([
      ["create", { ...TEMPLATE_BODY, schedule: "yearly", month: 3, note: "Регистратор" }],
      ["update", "vps", { amount: "1600", month: null, note: null }],
      ["archive", "vps"],
    ]);
    expect(ctx.templates.calls.every((call) => call.actor !== null)).toBe(true);
  });

  it("«Расходы месяца»: период доходит до сервиса, ответ — { data: { period, created, existing, failed } }", async () => {
    const ctx = await start();
    const finance = await ctx.staff("1009", "Финансы", "finance");

    const response = await send("POST", "/templates/draft-period", finance, { period: "2026-11" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: DRAFT_RESULT });
    expect(ctx.templates.calls.map((call) => [call.method, call.args[0]])).toEqual([["draftPeriod", "2026-11"]]);
  });

  it("неверное тело — 400, сервис не вызывается: лишнее поле, сумма со знаком, график не из списка, месяц вне 1…12, пустая правка, период не строкой", async () => {
    const ctx = await start();
    const finance = await ctx.staff("1010", "Финансы", "finance");

    for (const body of [{ ...TEMPLATE_BODY, extra: 1 }, { ...TEMPLATE_BODY, amount: "-1" }, { ...TEMPLATE_BODY, schedule: "weekly" }, { ...TEMPLATE_BODY, schedule: "yearly", month: 13 }, { name: "VPS" }]) {
      expect((await send("POST", "/templates", finance, body)).statusCode).toBe(400);
    }
    expect((await send("PATCH", "/templates/vps", finance, {})).statusCode).toBe(400);
    expect((await send("PATCH", "/templates/vps", finance, { amount: "1e3" })).statusCode).toBe(400);
    expect((await send("PATCH", "/templates/Bad_Id", finance, { amount: "1" })).statusCode).toBe(400);
    expect((await send("POST", "/templates/draft-period", finance, {})).statusCode).toBe(400);
    expect((await send("POST", "/templates/draft-period", finance, { period: 202611 })).statusCode).toBe(400);
    expect((await send("POST", "/templates/draft-period", finance, { period: "2026-11", extra: 1 })).statusCode).toBe(400);
    expect(ctx.templates.calls).toHaveLength(0);
  });

  it("отказ сервиса доходит как есть: период вне окна — 400 ledger_template_invalid с текстом", async () => {
    const ctx = await start();
    const finance = await ctx.staff("1011", "Финансы", "finance");

    ctx.templates.failWith = new LedgerTemplateInvalidError("Расходы месяца создаются не раньше прошлого месяца");
    const response = await send("POST", "/templates/draft-period", finance, { period: "2026-01" });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: "ledger_template_invalid", message: "Расходы месяца создаются не раньше прошлого месяца" });
  });
});
