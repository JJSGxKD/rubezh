import "reflect-metadata";
import { Decimal, type CurrencyCode, type Rate, type RatesSnapshot } from "@bh/fx";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminMyProjectController } from "../src/modules/admin/admin-my-project.controller.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE } from "../src/modules/admin/admin-session.store.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { FxService } from "../src/modules/fx/fx.service.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { monthKey } from "../src/modules/stakeholders/stakeholder-rules.js";
import { PROJECT_MONTH_REPOSITORY, type ProjectMonthRepository } from "../src/modules/stakeholders/project-month.repository.js";
import type { PurchaseRow } from "../src/modules/stakeholders/project-month.js";
import { ProjectMonthService } from "../src/modules/stakeholders/project-month.service.js";
import { STAKEHOLDERS_REPOSITORY, type ParticipantRow, type StakeholdersRepository, type StoredShare } from "../src/modules/stakeholders/stakeholders.repository.js";
import { SETTINGS_READER } from "../src/modules/settings/settings.service.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPanelLoginStore } from "./helpers/memory-panel-login.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Кабинет «Мой проект» по HTTP (Р218, tasks/T-0453): `GET /admin/my-project`. Настоящие охранники панели, права и
 * сервис; доли, покупки и курсы — в памяти. Расчёты проверяет `project-month.test.ts`, выборку из базы — интеграционный
 * тест, здесь — кто что видит и какие запросы отклоняются.
 */

const OWNER_ID = "777000333";
const URL_BASE = "/api/v1/admin/my-project";
const DAY_MS = 86_400_000;

/** Сервис считает «сейчас» по реальным часам, поэтому месяцы теста — от настоящего. */
const NOW = new Date();
const monthAhead = (offset: number): string => monthKey(new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + offset, 1)));
const CURRENT = monthAhead(0);
/** Начало текущего месяца: оплата в нём не опаздывает ни в какой день месяца. */
const START = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1));

class MemoryShares implements StakeholdersRepository {
  rows: StoredShare[] = [];
  names = new Map<string, string>();

  async history(): Promise<StoredShare[]> {
    return [...this.rows];
  }

  async participants(): Promise<ParticipantRow[]> {
    return [...new Set(this.rows.map((row) => row.accountId))].map((accountId) => ({ accountId, displayName: this.names.get(accountId) ?? "", hasRole: true }));
  }

  async account(): Promise<ParticipantRow | null> {
    return null;
  }

  async setShare(): Promise<never> {
    throw new Error("запись долей в этом тесте не нужна");
  }
}

class MemoryProjectMonth implements ProjectMonthRepository {
  rows: PurchaseRow[] = [];

  async purchases(from: Date, to: Date): Promise<PurchaseRow[]> {
    return this.rows.filter((row) => row.paidAt >= from && row.paidAt < to);
  }

  async firstPaidMonth(): Promise<string | null> {
    const first = this.rows.map((row) => row.paidAt.getTime()).sort((a, b) => a - b)[0];
    return first === undefined ? null : monthKey(new Date(first));
  }
}

/** Курсы: звезда по выплате 0,013 $, доллар — 90 ₽; `withRates: false` — курса выплаты звезды нет. */
function snapshot(withRates: boolean): RatesSnapshot {
  const rate = (currency: "XTR" | "RUB", usd: Decimal): Rate => ({ currency, usdPerUnit: usd, sources: ["test"], observedAt: NOW });
  return {
    id: "snapshot",
    takenAt: NOW,
    rates: new Map<CurrencyCode, Rate>([["RUB", rate("RUB", new Decimal(1).div(90))]]),
    payout: withRates ? new Map<CurrencyCode, Rate>([["XTR", rate("XTR", new Decimal("0.013"))]]) : new Map<CurrencyCode, Rate>(),
  };
}

interface ViewJson {
  data: {
    month: string;
    months: string[];
    viewer: { role: string; sharePercent: number | null; shareFrom: string | null };
    participants: { name: string; sharePercent: number; me: boolean }[];
    ownerSharePercent: number;
    rates: { starUsd: string; usdRub: string; at: string } | null;
    project: {
      revenue: { stars: { paid: number; refunded: number; net: number }; usd: string | null; rub: string | null };
      hold: { days: number };
      draft: { sharePercent: number; usd: string | null; rub: string | null; stars: number } | null;
    };
  };
}

describe("«Мой проект» по HTTP", () => {
  let app: NestFastifyApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(options: { withRates?: boolean } = {}) {
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    const accounts = new MemoryAccountRepository();
    const roles = new MemoryRolesRepository();
    const shares = new MemoryShares();
    const months = new MemoryProjectMonth();
    const fx = { peek: async () => snapshot(options.withRates ?? true) };
    const limiter = { consume: async () => true } as unknown as RateLimiter;
    @Module({
      controllers: [AdminSessionController, AdminMyProjectController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: new MemoryAdminSessionStore() },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: STAKEHOLDERS_REPOSITORY, useValue: shares },
        { provide: PROJECT_MONTH_REPOSITORY, useValue: months },
        { provide: SETTINGS_READER, useValue: panelSettings() },
        { provide: FxService, useValue: fx },
        { provide: AppLinks, useValue: new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]) },
        { provide: RateLimiter, useValue: limiter },
        ProjectMonthService,
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
      shares.names.set(account.accountId, name);
      return { accountId: account.accountId, cookie: await login(`dev-player-${id}:${name}`) };
    };

    const share = (accountId: string, fromMonth: string, shareBp: number) =>
      shares.rows.push({ accountId, fromMonth, shareBp, note: "договорённость", setBy: accountId, setByName: "Владелец", setAt: NOW });

    /** Оплата в текущем месяце: 10 000 ⭐ и 300 ⭐ возврата — чистая выручка 9 700. */
    const revenue = () => {
      months.rows.push({ chargedStars: 10_000, paidAt: START, refundedAt: null, product: "shop_item", platform: "telegram" });
      months.rows.push({ chargedStars: 300, paidAt: START, refundedAt: new Date(START.getTime() + DAY_MS), product: "vip", platform: "vk" });
    };

    return { shares, months, login, staff, share, revenue };
  }

  const get = (cookie: string, query = "") => app!.inject({ method: "GET", url: `${URL_BASE}${query}`, headers: { cookie, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE } });

  it("без сессии — 401", async () => {
    await start();

    expect((await app!.inject({ method: "GET", url: URL_BASE })).statusCode).toBe(401);
  });

  it("без прав на доходы (модератор) — 403", async () => {
    const ctx = await start();
    const moderator = await ctx.staff("951", "Модератор", "moderator");

    expect((await get(moderator.cookie)).statusCode).toBe(403);
  });

  it("участник видит свою долю и me: true у себя, всех участников с долями, выручку и черновик части", async () => {
    const ctx = await start();
    const anna = await ctx.staff("952", "Анна", "stakeholder");
    const boris = await ctx.staff("953", "Борис", "stakeholder");
    ctx.share(anna.accountId, monthAhead(-2), 2_500);
    ctx.share(boris.accountId, CURRENT, 1_000);
    ctx.revenue();

    const response = await get(anna.cookie);

    expect(response.statusCode).toBe(200);
    const view = response.json<ViewJson>().data;
    expect(view.month).toBe(CURRENT);
    expect(view.viewer).toEqual({ role: "stakeholder", sharePercent: 25, shareFrom: monthAhead(-2) });
    expect(view.participants).toEqual([
      { name: "Анна", sharePercent: 25, me: true },
      { name: "Борис", sharePercent: 10, me: false },
    ]);
    expect(view.ownerSharePercent).toBe(65);
    expect(view.project.revenue.stars).toEqual({ paid: 10_300, refunded: 300, net: 9_700 });
    expect(view.project.revenue.usd).toBe("126.10");
    expect(view.project.revenue.rub).toBe("11349.00");
    expect(view.project.draft).toEqual({ sharePercent: 25, usd: "31.52", rub: "2837.25", stars: 2_425 });
    expect(view.project.hold.days).toBe(21);
    expect(view.rates).toMatchObject({ starUsd: "0.013", usdRub: "90" });
    expect(view.months).toEqual([CURRENT]);
  });

  it("владелец видит остаток после участников, финансы — без доли и без черновика", async () => {
    const ctx = await start();
    const anna = await ctx.staff("954", "Анна", "stakeholder");
    const finance = await ctx.staff("955", "Финансы", "finance");
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);
    ctx.share(anna.accountId, monthAhead(-1), 2_500);
    ctx.revenue();

    const asOwner = (await get(owner)).json<ViewJson>().data;
    expect(asOwner.viewer).toEqual({ role: "owner", sharePercent: 75, shareFrom: null });
    expect(asOwner.participants).toEqual([{ name: "Анна", sharePercent: 25, me: false }]);
    // 9 700 ⭐ × 75 % = 7 275 ⭐
    expect(asOwner.project.draft).toMatchObject({ sharePercent: 75, stars: 7_275 });

    const asFinance = await get(finance.cookie);
    expect(asFinance.statusCode).toBe(200);
    const view = asFinance.json<ViewJson>().data;
    expect(view.viewer).toEqual({ role: "finance", sharePercent: null, shareFrom: null });
    expect(view.project.draft).toBeNull();
    expect(view.project.revenue.stars.net).toBe(9_700);
    expect(view.participants).toHaveLength(1);
  });

  it("доля участника с будущего месяца — в этом месяце её у него нет: черновика нет, в списке его нет", async () => {
    const ctx = await start();
    const anna = await ctx.staff("956", "Анна", "stakeholder");
    ctx.share(anna.accountId, monthAhead(1), 2_500);
    ctx.revenue();

    const view = (await get(anna.cookie)).json<ViewJson>().data;

    expect(view.viewer).toEqual({ role: "stakeholder", sharePercent: 0, shareFrom: null });
    expect(view.participants).toEqual([]);
    expect(view.ownerSharePercent).toBe(100);
    expect(view.project.draft).toBeNull();
  });

  it("конец участия (доля 0 %) — участника нет в списке этого месяца, а в прошлом он есть", async () => {
    const ctx = await start();
    const anna = await ctx.staff("957", "Анна", "stakeholder");
    ctx.share(anna.accountId, monthAhead(-3), 2_000);
    ctx.share(anna.accountId, CURRENT, 0);
    ctx.months.rows.push({ chargedStars: 100, paidAt: new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 2, 5)), refundedAt: null, product: "shop_item", platform: "telegram" });

    const now = (await get(anna.cookie)).json<ViewJson>().data;
    expect(now.participants).toEqual([]);
    expect(now.project.draft).toBeNull();

    const past = (await get(anna.cookie, `?month=${monthAhead(-2)}`)).json<ViewJson>().data;
    expect(past.month).toBe(monthAhead(-2));
    expect(past.participants).toEqual([{ name: "Анна", sharePercent: 20, me: true }]);
    expect(past.project.revenue.stars.net).toBe(100);
    expect(past.months).toEqual([CURRENT, monthAhead(-1), monthAhead(-2)]);
  });

  it("курса выплаты звезды нет — rates: null, суммы в $ и ₽ null, звёзды есть", async () => {
    const ctx = await start({ withRates: false });
    const anna = await ctx.staff("958", "Анна", "stakeholder");
    ctx.share(anna.accountId, CURRENT, 2_500);
    ctx.revenue();

    const view = (await get(anna.cookie)).json<ViewJson>().data;

    expect(view.rates).toBeNull();
    expect(view.project.revenue.usd).toBeNull();
    expect(view.project.revenue.rub).toBeNull();
    expect(view.project.revenue.stars.net).toBe(9_700);
    expect(view.project.draft).toEqual({ sharePercent: 25, usd: null, rub: null, stars: 2_425 });
  });

  it("месяц 2026-13, чужой формат и лишнее поле запроса — 400; будущий и раньше первой оплаты — 400 project_month_out_of_range", async () => {
    const ctx = await start();
    const anna = await ctx.staff("959", "Анна", "stakeholder");
    ctx.share(anna.accountId, CURRENT, 2_500);
    ctx.revenue();

    expect((await get(anna.cookie, "?month=2026-13")).statusCode).toBe(400);
    expect((await get(anna.cookie, "?month=2026-1")).statusCode).toBe(400);
    expect((await get(anna.cookie, `?month=${CURRENT}&extra=1`)).statusCode).toBe(400);

    const future = await get(anna.cookie, `?month=${monthAhead(1)}`);
    expect(future.statusCode).toBe(400);
    expect(future.json<{ error: { code: string } }>().error.code).toBe("project_month_out_of_range");

    const early = await get(anna.cookie, `?month=${monthAhead(-1)}`);
    expect(early.statusCode).toBe(400);
    expect(early.json<{ error: { code: string } }>().error.code).toBe("project_month_out_of_range");

    expect((await get(anna.cookie, `?month=${CURRENT}`)).statusCode).toBe(200);
  });

  it("оплат ещё не было — доступен только текущий месяц, суммы нулевые", async () => {
    const ctx = await start();
    const anna = await ctx.staff("960", "Анна", "stakeholder");
    ctx.share(anna.accountId, CURRENT, 2_500);

    const view = (await get(anna.cookie)).json<ViewJson>().data;

    expect(view.months).toEqual([CURRENT]);
    expect(view.project.revenue.stars).toEqual({ paid: 0, refunded: 0, net: 0 });
    expect((await get(anna.cookie, `?month=${monthAhead(-1)}`)).statusCode).toBe(400);
  });
});
