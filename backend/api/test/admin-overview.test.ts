import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { DayStats, DayWindow } from "../src/modules/admin-notify/daily-stats.js";
import type { DailyStatsRepository, DayPoint } from "../src/modules/admin-notify/daily-stats.repository.js";
import { AdminOverviewService } from "../src/modules/admin/admin-overview.service.js";
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
    return [{ day: "2026-10-01", newAccounts: 5, active: 40, finishedRuns: 10, stars: 150 }];
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
  const changelog = {
    list: async () => {
      if (options.changelogFails === true) throw new Error("база не ответила");
      return { entries: [line("0.6.0", false), line("0.6.0", false), line("0.6.1", false), line("0.5.0", true)], releases: [] };
    },
  } as unknown as ChangelogService;
  const broadcasts = {
    list: async () => [broadcast(colleague.accountId, "draft"), broadcast(owner.accountId, "draft"), broadcast(colleague.accountId, "done")],
  } as unknown as BroadcastsService;
  const runs = { review: async () => [flagged(2), flagged(30)] } as unknown as RunsViewService;
  return { service: new AdminOverviewService(stats, roles, changelog, broadcasts, runs), stats, owner, person };
}

describe("сводка панели", () => {
  it("сегодня — с московской полуночи, вчера — до того же часа, ряд — четырнадцать суток", async () => {
    const { service, stats, owner } = await setup();
    const overview = await service.overview(owner, NOW);
    expect(overview.day).toBe("2026-10-01");
    expect(overview.from).toBe("2026-09-30T21:00:00.000Z");
    expect(stats.windows).toEqual([
      { day: "2026-10-01", from: new Date("2026-09-30T21:00:00.000Z"), to: NOW },
      { day: "2026-09-30", from: new Date("2026-09-29T21:00:00.000Z"), to: new Date("2026-09-30T18:30:00.000Z") },
    ]);
    expect(stats.seriesRange).toEqual([new Date("2026-09-17T21:00:00.000Z"), NOW]);
    expect([overview.today.active, overview.yesterday.active]).toEqual([40, 30]);
  });

  it("владельцу — выручка и всё, что ждёт: черновики версий, рассылки коллег, свежий разбор", async () => {
    const { service, owner } = await setup();
    const overview = await service.overview(owner, NOW);
    expect(overview.today.revenue).toEqual({ stars: 150, purchases: 3, refunds: 0 });
    expect(overview.series[0]?.stars).toBe(150);
    expect(overview.attention).toEqual([
      { section: "changelog", count: 2, text: "«Что нового» ждёт публикации — версии 0.6.0, 0.6.1" },
      // Свой черновик и законченная рассылка не ждут.
      { section: "broadcasts", count: 1, text: "Рассылки коллег в черновиках — проверить, одобрить и запустить: 1" },
      { section: "review", count: 1, text: "Забегов на разбор за сутки: 1" },
    ]);
  });

  it("аналитику — без выручки и без чужих дел; модератору сводка закрыта", async () => {
    const { service, person } = await setup();
    const analyst = await person("3", "analyst");
    const overview = await service.overview(analyst, NOW);
    expect(overview.today.revenue).toBeNull();
    expect(overview.series[0]?.stars).toBeNull();
    expect(overview.attention).toEqual([]);

    const moderator = await person("4", "moderator");
    await expect(service.overview(moderator, NOW)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("источник, который не ответил, — без своей строки, а не без сводки", async () => {
    const { service, owner } = await setup({ changelogFails: true });
    const overview = await service.overview(owner, NOW);
    expect(overview.attention.map((item) => item.section)).toEqual(["broadcasts", "review"]);
  });
});
