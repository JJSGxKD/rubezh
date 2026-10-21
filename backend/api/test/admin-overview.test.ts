import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import type { DayStats, DayWindow } from "../src/modules/admin-notify/daily-stats.js";
import type { DailyStatsRepository, DayPoint } from "../src/modules/admin-notify/daily-stats.repository.js";
import { ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminOverviewController } from "../src/modules/admin/admin-overview.controller.js";
import { AdminOverviewService } from "../src/modules/admin/admin-overview.service.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import type { AdFunnelRow, AdsCatalogRepository } from "../src/modules/ads/ads-catalog.repository.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import type { Account } from "../src/modules/auth/account.repository.js";
import type { BroadcastRecord } from "../src/modules/broadcasts/broadcasts.repository.js";
import type { BroadcastsService } from "../src/modules/broadcasts/broadcasts.service.js";
import { segmentSchema } from "../src/modules/broadcasts/segment.js";
import type { ChangelogEntryRecord } from "../src/modules/changelog/changelog.repository.js";
import type { ChangelogService } from "../src/modules/changelog/changelog.service.js";
import type { Role } from "../src/modules/roles/permissions.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import type { ReviewRow } from "../src/modules/runs/runs.repository.js";
import type { RunsViewService } from "../src/modules/runs/runs-view.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Сводка панели: окна суток по Москве, сравнение со вчера к тому же часу,
 * выручка — только по праву, «ждёт вас» — по правам того, кто смотрит, и
 * без падения, если один источник не ответил.
 */

/** 1 октября 2026, 21:30 по Москве */
const NOW = new Date("2026-10-01T18:30:00.000Z");
const HOUR = 3_600_000;

function stats(active: number): DayStats {
  return {
    accounts: { organic: 2, click: 3 },
    active,
    sessions: active * 2,
    runs: { finished: 10, players: 4, medianSurvivalSec: 300 },
    revenue: { stars: 150, purchases: 3, refunds: 0 },
    funnel: { entered: 5, appOpened: 5, firstRun: 4, runs5: 1, returnedD1: 2, returnedD7: 0, firstPurchase: 1 },
  };
}

class FakeStats implements DailyStatsRepository {
  readonly windows: DayWindow[] = [];
  seriesRange: [Date, Date] | null = null;
  async day(window: DayWindow): Promise<DayStats> {
    this.windows.push(window);
    return stats(window.day === "2026-10-01" ? 40 : 30);
  }
  async series(from: Date, to: Date): Promise<DayPoint[]> {
    this.seriesRange = [from, to];
    // Сутки от `from` до `to` — как у настоящего ряда: длину графика проверяет тест.
    const points: DayPoint[] = [];
    for (let at = from.getTime(); at < to.getTime(); at += 86_400_000) {
      points.push({ day: new Date(at + 3 * HOUR).toISOString().slice(0, 10), newAccounts: 5, active: 40, finishedRuns: 10, stars: 150, purchases: 3, adsCompleted: 7 });
    }
    return points;
  }
}

const TOTALS = { offered: 0, shown: 0, clicked: 0, completed: 0, claimed: 0, failed: 0 };
const row = (networkKey: string, place: AdFunnelRow["place"], values: Partial<Omit<AdFunnelRow, "networkKey" | "place">>): AdFunnelRow => ({ networkKey, place, ...TOTALS, ...values });

/** Воронка рекламы: сейчас — два места у двух сетей, до этого — одно. */
class FakeAds {
  readonly calls: [Date, Date][] = [];
  failing = false;
  async funnel(from: Date, to: Date): Promise<AdFunnelRow[]> {
    this.calls.push([from, to]);
    if (this.failing) throw new Error("база не ответила");
    if (this.calls.length === 2) return [row("adsgram", "wheel_spin", { offered: 10, shown: 8, completed: 6, claimed: 5, failed: 1 })];
    return [
      row("taddy", "wheel_spin", { offered: 5, shown: 4, clicked: 1, completed: 3, claimed: 3, failed: 0 }),
      row("adsgram", "wheel_spin", { offered: 20, shown: 16, completed: 12, claimed: 11, failed: 2 }),
      row("adsgram", "second_chance", { offered: 6, shown: 5, completed: 4, claimed: 4, failed: 1 }),
    ];
  }
}

function line(version: string, published: boolean): ChangelogEntryRecord {
  const at = new Date(NOW.getTime() - HOUR);
  return { entryId: `${version}-${String(published)}`, version, platforms: [], kind: "added", text: "строка", publishedAt: published ? at : null, createdAt: at, updatedAt: at, updatedBy: null, sourceKey: null };
}

function broadcast(createdBy: string, status: BroadcastRecord["status"]): BroadcastRecord {
  return {
    broadcastId: `${createdBy}-${status}`,
    title: "Рассылка",
    platform: "telegram",
    text: "Текст",
    buttonText: null,
    buttonUrl: null,
    linkCode: null,
    segment: segmentSchema.parse({}),
    status,
    audience: null,
    createdBy,
    approvedBy: null,
    startedBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: null,
    finishedAt: null,
  };
}

function flagged(hoursAgo: number): ReviewRow {
  return { runId: `r${String(hoursAgo)}`, accountId: "a", verdict: "suspicious", verdictReasons: [], difficulty: "easy", survivalSec: 60, level: 1, enemiesKilled: 1, finishedAt: new Date(NOW.getTime() - hoursAgo * HOUR) };
}

async function setup(options: { changelogFails?: boolean } = {}) {
  const ads = new FakeAds();
  const accounts = new MemoryAccountRepository();
  const rolesRepository = new MemoryRolesRepository();
  const roles = new RolesService(loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv), rolesRepository, accounts);
  const person = async (id: string, role: Role) => {
    const account: Account = await accounts.upsert({ platform: "telegram", platformUserId: id, displayName: id, username: null, photoUrl: null }, Date.now());
    await rolesRepository.grant(account.accountId, role, null);
    return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
  };
  const owner = await person("1", "owner");
  const colleague = await person("2", "marketer");
  const stats = new FakeStats();
  let changelogListed = 0;
  const changelog = {
    list: async () => {
      changelogListed++;
      if (options.changelogFails === true) throw new Error("база не ответила");
      return { entries: [line("0.6.0", false), line("0.6.0", false), line("0.6.1", false), line("0.5.0", true)], releases: [] };
    },
  } as unknown as ChangelogService;
  const broadcasts = {
    list: async () => [broadcast(colleague.accountId, "draft"), broadcast(owner.accountId, "draft"), broadcast(colleague.accountId, "done")],
  } as unknown as BroadcastsService;
  const runs = { review: async () => [flagged(2), flagged(30)] } as unknown as RunsViewService;
  return { service: new AdminOverviewService(stats, roles, changelog, broadcasts, runs, ads as unknown as AdsCatalogRepository), stats, ads, owner, person, changelogCalls: () => changelogListed };
}

describe("сводка панели", () => {
  it("сегодня — с московской полуночи, вчера — до того же часа, ряд — четырнадцать суток", async () => {
    const { service, stats, owner } = await setup();
    const overview = await service.overview(owner, 1, NOW);
    expect(overview.day).toBe("2026-10-01");
    expect(overview.from).toBe("2026-09-30T21:00:00.000Z");
    expect(stats.windows).toEqual([
      { day: "2026-10-01", from: new Date("2026-09-30T21:00:00.000Z"), to: NOW },
      { day: "2026-09-30", from: new Date("2026-09-29T21:00:00.000Z"), to: new Date("2026-09-30T18:30:00.000Z") },
    ]);
    expect(stats.seriesRange).toEqual([new Date("2026-09-17T21:00:00.000Z"), NOW]);
    expect([overview.today.active, overview.yesterday.active]).toEqual([40, 30]);
    expect(overview.days).toBe(1);
    expect(overview.series).toHaveLength(14);
  });

  it("реклама: места суммой по сетям в порядке AD_PLACES, сети по досмотрам, прошлое окно — для сравнения", async () => {
    const { service, ads, owner } = await setup();
    const overview = await service.overview(owner, 1, NOW);
    expect(ads.calls).toEqual([
      [new Date("2026-09-30T21:00:00.000Z"), NOW],
      [new Date("2026-09-29T21:00:00.000Z"), new Date("2026-09-30T18:30:00.000Z")],
    ]);
    expect(overview.ads).toEqual({
      now: { offered: 31, shown: 25, completed: 19, claimed: 18, failed: 3 },
      before: { offered: 10, shown: 8, completed: 6, claimed: 5, failed: 1 },
      places: [
        { place: "second_chance", offered: 6, shown: 5, completed: 4, claimed: 4, failed: 1 },
        { place: "wheel_spin", offered: 25, shown: 20, completed: 15, claimed: 14, failed: 2 },
      ],
      networks: [
        { networkKey: "adsgram", completed: 16 },
        { networkKey: "taddy", completed: 3 },
      ],
    });
  });

  it("семь дней — последние семь суток против предыдущих семи, ряд всё равно четырнадцать", async () => {
    const { service, stats, ads, owner } = await setup();
    const overview = await service.overview(owner, 7, NOW);
    expect(stats.windows).toEqual([
      { day: "2026-09-25", from: new Date("2026-09-24T21:00:00.000Z"), to: NOW },
      { day: "2026-09-18", from: new Date("2026-09-17T21:00:00.000Z"), to: new Date("2026-09-24T18:30:00.000Z") },
    ]);
    // Реклама смотрит на те же окна, что и сводка.
    expect(ads.calls).toEqual([
      [new Date("2026-09-24T21:00:00.000Z"), NOW],
      [new Date("2026-09-17T21:00:00.000Z"), new Date("2026-09-24T18:30:00.000Z")],
    ]);
    expect(overview.days).toBe(7);
    expect(overview.day).toBe("2026-10-01");
    expect(overview.series).toHaveLength(14);
  });

  it("тридцать дней — ряд тридцать суток", async () => {
    const { service, stats, owner } = await setup();
    const overview = await service.overview(owner, 30, NOW);
    expect(overview.series).toHaveLength(30);
    expect(stats.seriesRange).toEqual([new Date("2026-09-01T21:00:00.000Z"), NOW]);
    expect(stats.windows[0]).toEqual({ day: "2026-09-02", from: new Date("2026-09-01T21:00:00.000Z"), to: NOW });
  });

  it("без ads.view — рекламы нет, и её репозиторий не зовётся", async () => {
    const { service, ads, person } = await setup();
    const analyst = await person("3", "analyst");
    const overview = await service.overview(analyst, 1, NOW);
    expect(overview.ads).toBeNull();
    expect(ads.calls).toEqual([]);
  });

  it("чтение рекламы упало — без рекламы, но со всем остальным", async () => {
    const { service, ads, owner } = await setup();
    ads.failing = true;
    const overview = await service.overview(owner, 1, NOW);
    expect(overview.ads).toBeNull();
    expect(overview.today.active).toBe(40);
    expect(overview.attention.length).toBeGreaterThan(0);
  });

  it("владельцу — выручка и всё, что ждёт: рассылки коллег, свежий разбор; черновики версий не напоминаются (Р125)", async () => {
    const { service, owner } = await setup();
    const overview = await service.overview(owner, 1, NOW);
    expect(overview.today.revenue).toEqual({ stars: 150, purchases: 3, refunds: 0 });
    expect(overview.series[0]?.stars).toBe(150);
    expect(overview.series[0]?.purchases).toBe(3);
    expect(overview.attention).toEqual([
      // Свой черновик и законченная рассылка не ждут.
      { section: "broadcasts", count: 1, text: "Рассылки коллег в черновиках — проверить, одобрить и запустить: 1" },
      { section: "review", count: 1, text: "Забегов на разбор за сутки: 1" },
    ]);
  });

  it("журнал скрыт у игроков: черновики версий в сводке не показываются и не запрашиваются", async () => {
    const { service, owner, changelogCalls } = await setup();
    const overview = await service.overview(owner, 1, NOW);
    expect(overview.attention.map((item) => item.section)).not.toContain("changelog");
    expect(changelogCalls()).toBe(0);
  });

  it("аналитику — без выручки и без чужих дел; модератору сводка закрыта", async () => {
    const { service, person } = await setup();
    const analyst = await person("3", "analyst");
    const overview = await service.overview(analyst, 1, NOW);
    expect(overview.today.revenue).toBeNull();
    expect(overview.series[0]?.stars).toBeNull();
    // Покупки — деньги, как звёзды; досмотренная реклама — нет.
    expect(overview.series[0]?.purchases).toBeNull();
    expect(overview.series[0]?.adsCompleted).toBe(7);
    expect(overview.attention).toEqual([]);
    expect(overview.ads).toBeNull();

    const moderator = await person("4", "moderator");
    await expect(service.overview(moderator, 1, NOW)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("источник, который не ответил, — без своей строки, а не без сводки", async () => {
    const { service, owner } = await setup({ changelogFails: true });
    const overview = await service.overview(owner, 1, NOW);
    expect(overview.attention.map((item) => item.section)).toEqual(["broadcasts", "review"]);
  });
});

describe("сводка по HTTP", () => {
  let app: NestFastifyApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start() {
    const accounts = new MemoryAccountRepository();
    const rolesRepository = new MemoryRolesRepository();
    const store = new MemoryAdminSessionStore();
    const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);
    const owner = await accounts.upsert({ platform: "telegram", platformUserId: "1", displayName: "Вера", username: null, photoUrl: null }, Date.now());
    await rolesRepository.grant(owner.accountId, "owner", null);
    await store.put(hashSessionToken("own"), { accountId: owner.accountId, platform: "telegram", platformUserId: "1", issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    const asked: number[] = [];
    const overview = { overview: async (_actor: unknown, days: number) => (asked.push(days), { days }) };

    @Module({
      controllers: [AdminOverviewController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: REDIS, useValue: {} as unknown as Redis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: rolesRepository },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: AdminOverviewService, useValue: overview },
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
    return { app, asked };
  }

  const get = (server: NestFastifyApplication, query: string) =>
    server.inject({ method: "GET", url: `/api/v1/admin/overview${query}`, headers: { cookie: `${ADMIN_SESSION_COOKIE}=own` } });

  it("период — 1, 7 или 30; без параметра — сутки; чужое значение — 400", async () => {
    const { app: server, asked } = await start();
    expect((await get(server, "")).statusCode).toBe(200);
    expect((await get(server, "?days=7")).statusCode).toBe(200);
    expect((await get(server, "?days=30")).statusCode).toBe(200);
    expect(asked).toEqual([1, 7, 30]);

    for (const bad of ["?days=14", "?days=0", "?days=abc", "?days="]) {
      const response = await get(server, bad);
      expect(response.statusCode, bad).toBe(400);
      expect(response.json().error.message).toBe("Период — 1, 7 или 30 дней");
    }
    expect(asked).toEqual([1, 7, 30]);
  });
});
