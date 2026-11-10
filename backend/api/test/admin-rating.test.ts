import "reflect-metadata";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "../src/common/domain-error.js";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminRatingController } from "../src/modules/admin/admin-rating.controller.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE } from "../src/modules/admin/admin-session.store.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { divisionOf } from "../src/modules/rating/division-rules.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import type { Permission } from "../src/modules/roles/permissions.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import type { BestRunRow } from "../src/modules/runs/runs.repository.js";
import type { Difficulty } from "../src/modules/runs/run-rules.js";
import type { Season } from "../src/modules/seasons/season-rules.js";
import type { SeasonBoardEntry, SeasonBoardStore } from "../src/modules/seasons/season-board.store.js";
import { SeasonSchedule } from "../src/modules/seasons/seasons-schedule.js";
import { SeasonNotFoundError, SeasonsAdminService } from "../src/modules/seasons/seasons-admin.service.js";
import type { SeasonsAdminRepository } from "../src/modules/seasons/seasons-admin.repository.js";
import type { SeasonsRepository } from "../src/modules/seasons/seasons.repository.js";
import type { Board } from "../src/modules/runs/leaderboard.store.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPanelLoginStore } from "./helpers/memory-panel-login.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryLeaderboardStore } from "./helpers/memory-runs.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Рейтинг в панели без базы (tasks/T-0380, Р189): сервис на подменённых
 * хранилищах и маршруты по HTTP с настоящими охранниками панели. Запросы к
 * Postgres — в `admin-rating.integration.test.ts`.
 */

const OWNER_ID = "777000222";
const URL_BASE = "/api/v1/admin";
const AT = new Date("2026-11-04T12:00:00Z");
const ACTOR: AccountRef = { accountId: "00000000-0000-4000-8000-000000000001", platform: "telegram", platformUserId: "1" };

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Доски недели в памяти по ключам Redis: что спросили, видно по `asked`. */
class WeekStore implements Pick<SeasonBoardStore, "top" | "count"> {
  readonly tables = new Map<string, SeasonBoardEntry[]>();
  readonly asked: string[] = [];
  put(seasonKey: string, board: Board, difficulty: Difficulty, entries: SeasonBoardEntry[]): void {
    this.tables.set(`${seasonKey}:${board}:${difficulty}`, entries);
  }
  async top(seasonKey: string, difficulty: Difficulty, limit: number, board: Board = "common"): Promise<SeasonBoardEntry[]> {
    this.asked.push(`${seasonKey}:${board}:${difficulty}`);
    return (this.tables.get(`${seasonKey}:${board}:${difficulty}`) ?? []).slice(0, limit);
  }
  async count(seasonKey: string, difficulty: Difficulty, board: Board = "common"): Promise<number> {
    return (this.tables.get(`${seasonKey}:${board}:${difficulty}`) ?? []).length;
  }
}

function runRow(accountId: string, patch: Partial<BestRunRow> = {}): BestRunRow {
  return { accountId, displayName: `Игрок ${accountId.slice(-2)}`, photoUrl: null, survivalSec: 600, points: 1500, style: null, level: 10, startingWeaponId: "pistol", enemiesKilled: 100, ...patch };
}

function setup(options: { pointsFrom?: number; started?: boolean; granted?: readonly Permission[]; known?: readonly string[] } = {}) {
  const schedule = new SeasonSchedule(panelSettings({ "seasons.start-date": options.started === false ? 0 : 20261102, "rating.points-from": options.pointsFrom ?? 0 }));
  const week = new WeekStore();
  const all = new MemoryLeaderboardStore();
  const seen: { season: Season; scoring: string }[] = [];
  const seasonsRepo = {
    async boardRuns(ids: readonly string[], _difficulty: Difficulty, season: Season, _since: Date | null, scoring: string): Promise<BestRunRow[]> {
      seen.push({ season, scoring });
      return ids.filter((accountId) => (options.known ?? ids).includes(accountId)).map((accountId) => runRow(accountId, { survivalSec: 700, points: 1700 }));
    },
  } as unknown as SeasonsRepository;
  const runsRepo = {
    async bestRuns(ids: readonly string[]): Promise<BestRunRow[]> {
      return ids.filter((accountId) => (options.known ?? ids).includes(accountId)).map((accountId) => runRow(accountId));
    },
  } as never;
  const archive: SeasonsAdminRepository = {
    seasons: async () => ({ seasons: [], more: false }),
    season: async () => null,
    results: async () => ({ rows: [], total: 0 }),
    playerSeasons: async () => [],
  };
  const granted = new Set<Permission>(options.granted ?? ["players.view"]);
  const roles = { can: async (_actor: AccountRef, permission: Permission) => granted.has(permission) } as unknown as RolesService;
  const service = new SeasonsAdminService(schedule, week as unknown as SeasonBoardStore, all, seasonsRepo, runsRepo, archive, roles);
  return { service, week, all, seen, granted };
}

describe("SeasonsAdminService.boards: текущие доски", () => {
  it("неделя без идущего сезона: seasonKey null и пустые строки, хранилища не читаются", async () => {
    const { service, week } = setup({ started: false });
    const view = await service.boards(ACTOR, { difficulty: "hard", period: "week", board: "common", limit: 100 }, AT);
    expect(view).toMatchObject({ period: "week", difficulty: "hard", board: "common", seasonKey: null, total: 0, entries: [] });
    expect(week.asked).toEqual([]);
  });

  it("неделя до понедельника старта сезонов — тоже без сезона", async () => {
    const { service } = setup();
    const view = await service.boards(ACTOR, { difficulty: "hard", period: "week", board: "common", limit: 100 }, new Date("2026-10-30T12:00:00Z"));
    expect(view.seasonKey).toBeNull();
    expect(view.entries).toEqual([]);
  });

  it("сезон по очкам читает ключ pts:<сезон>, число доски — очки, время — подпись из базы", async () => {
    const { service, week, seen } = setup({ pointsFrom: 20261102 });
    week.put("pts:2026-11-02", "common", "hard", [
      { accountId: id(1), score: 4000 },
      { accountId: id(2), score: 3000 },
    ]);
    week.put("2026-11-02", "common", "hard", [{ accountId: id(9), score: 999 }]);
    const view = await service.boards(ACTOR, { difficulty: "hard", period: "week", board: "common", limit: 100 }, AT);
    expect(week.asked).toEqual(["pts:2026-11-02:common:hard"]);
    expect(view.scoring).toBe("points");
    expect(view.seasonKey).toBe("2026-11-02");
    expect(view.total).toBe(2);
    expect(view.entries.map((entry) => [entry.place, entry.accountId, entry.score, entry.survivalSec])).toEqual([
      [1, id(1), 4000, 700],
      [2, id(2), 3000, 700],
    ]);
    expect(seen[0]?.scoring).toBe("points");
    // Подписи строк берутся по сезону с ключом-датой, а не по ключу доски Redis.
    expect(seen[0]?.season.key).toBe("2026-11-02");
  });

  it("сезон по времени читает ключ <сезон>: число доски — секунды", async () => {
    const { service, week } = setup();
    week.put("2026-11-02", "common", "hard", [{ accountId: id(1), score: 840 }]);
    week.put("pts:2026-11-02", "common", "hard", [{ accountId: id(9), score: 999 }]);
    const view = await service.boards(ACTOR, { difficulty: "hard", period: "week", board: "common", limit: 100 }, AT);
    expect(week.asked).toEqual(["2026-11-02:common:hard"]);
    expect(view.scoring).toBe("time");
    expect(view.entries).toMatchObject([{ place: 1, accountId: id(1), score: 840, survivalSec: 840 }]);
  });

  it("строка проекции без подписи из базы не отдаётся, а места не сдвигаются", async () => {
    const { service, week } = setup({ known: [id(1), id(3)] });
    week.put("2026-11-02", "common", "hard", [
      { accountId: id(1), score: 900 },
      { accountId: id(2), score: 800 },
      { accountId: id(3), score: 700 },
    ]);
    const view = await service.boards(ACTOR, { difficulty: "hard", period: "week", board: "common", limit: 100 }, AT);
    expect(view.total).toBe(3);
    expect(view.entries.map((entry) => [entry.place, entry.accountId])).toEqual([
      [1, id(1)],
      [3, id(3)],
    ]);
  });

  it("то же для доски всех времён", async () => {
    const { service, all } = setup({ known: [id(2)] });
    await all.submit("hard", id(1), 5000, ["common"]);
    await all.submit("hard", id(2), 4000, ["common"]);
    const view = await service.boards(ACTOR, { difficulty: "hard", period: "all", board: "common", limit: 100 }, AT);
    expect(view.entries.map((entry) => [entry.place, entry.accountId])).toEqual([[2, id(2)]]);
  });

  it("дивизион недели — divisionOf по месту и размеру доски, у всего времени — null", async () => {
    const { service, week, all } = setup();
    const entries = Array.from({ length: 20 }, (_, index) => ({ accountId: id(index + 1), score: 1000 - index }));
    week.put("2026-11-02", "common", "hard", entries);
    const weekly = await service.boards(ACTOR, { difficulty: "hard", period: "week", board: "common", limit: 20 }, AT);
    expect(weekly.entries.map((entry) => entry.division)).toEqual(entries.map((_, index) => divisionOf(index + 1, 20)));
    expect(new Set(weekly.entries.map((entry) => entry.division)).size).toBeGreaterThan(1);

    for (const entry of entries) await all.submit("hard", entry.accountId, entry.score, ["common"]);
    const forever = await service.boards(ACTOR, { difficulty: "hard", period: "all", board: "common", limit: 20 }, AT);
    expect(forever.scoring).toBe("points");
    expect(forever.seasonKey).toBeNull();
    expect(forever.entries).toHaveLength(20);
    expect(forever.entries.every((entry) => entry.division === null)).toBe(true);
    expect(forever.entries[0]).toMatchObject({ place: 1, score: 1000, survivalSec: 600 });
  });

  it("предел limit режет строки, total остаётся размером доски", async () => {
    const { service, week } = setup();
    week.put("2026-11-02", "common", "hard", Array.from({ length: 5 }, (_, index) => ({ accountId: id(index + 1), score: 100 - index })));
    const view = await service.boards(ACTOR, { difficulty: "hard", period: "week", board: "common", limit: 2 }, AT);
    expect(view.entries).toHaveLength(2);
    expect(view.total).toBe(5);
  });

  it("нерейтинговая сложность: пустая доска без обращения к хранилищам", async () => {
    const { service, week } = setup();
    week.put("2026-11-02", "common", "easy", [{ accountId: id(1), score: 10 }]);
    const view = await service.boards(ACTOR, { difficulty: "easy", period: "week", board: "common", limit: 100 }, AT);
    expect(view).toMatchObject({ total: 0, entries: [] });
    expect(week.asked).toEqual([]);
  });

  it("board=full без players.board.restrict — 403, ничего не прочитано; с правом читается полная доска", async () => {
    const without = setup();
    without.week.put("2026-11-02", "full", "hard", [{ accountId: id(1), score: 900 }]);
    await expect(without.service.boards(ACTOR, { difficulty: "hard", period: "week", board: "full", limit: 100 }, AT)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(without.service.boards(ACTOR, { difficulty: "hard", period: "all", board: "full", limit: 100 }, AT)).rejects.toBeInstanceOf(ForbiddenError);
    expect(without.week.asked).toEqual([]);

    const holder = setup({ granted: ["players.view", "players.board.restrict"] });
    holder.week.put("2026-11-02", "full", "hard", [{ accountId: id(1), score: 900 }]);
    holder.week.put("2026-11-02", "common", "hard", [{ accountId: id(2), score: 800 }]);
    const view = await holder.service.boards(ACTOR, { difficulty: "hard", period: "week", board: "full", limit: 100 }, AT);
    expect(view.board).toBe("full");
    expect(view.entries.map((entry) => entry.accountId)).toEqual([id(1)]);

    await holder.all.submit("hard", id(3), 100, ["full"]);
    const forever = await holder.service.boards(ACTOR, { difficulty: "hard", period: "all", board: "full", limit: 100 }, AT);
    expect(forever.entries.map((entry) => entry.accountId)).toEqual([id(3)]);
  });

  it("без players.board.restrict общая доска читается как обычно", async () => {
    const { service, week } = setup();
    week.put("2026-11-02", "common", "hard", [{ accountId: id(2), score: 800 }]);
    const view = await service.boards(ACTOR, { difficulty: "hard", period: "week", board: "common", limit: 100 }, AT);
    expect(view.entries.map((entry) => entry.accountId)).toEqual([id(2)]);
  });
});

describe("SeasonsAdminService: архив и места игрока", () => {
  it("season: сезона нет — 404 «Сезон не найден»", async () => {
    const { service } = setup();
    await expect(service.season(ACTOR, "2026-10-26", { difficulty: "hard", board: "common", offset: 0, limit: 100 })).rejects.toBeInstanceOf(SeasonNotFoundError);
    await expect(service.season(ACTOR, "2026-10-26", { difficulty: "hard", board: "common", offset: 0, limit: 100 })).rejects.toMatchObject({ status: 404, message: "Сезон не найден" });
  });

  it("season: board=full без players.board.restrict — 403 до обращения к базе", async () => {
    const { service } = setup();
    await expect(service.season(ACTOR, "2026-10-26", { difficulty: "hard", board: "full", offset: 0, limit: 100 })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("playerSeasons просит у базы строки отдельной доски только у держателя права", async () => {
    const asked: boolean[] = [];
    const archive = {
      seasons: async () => ({ seasons: [], more: false }),
      season: async () => null,
      results: async () => ({ rows: [], total: 0 }),
      playerSeasons: async (_accountId: string, includeFull: boolean) => {
        asked.push(includeFull);
        return [];
      },
    } satisfies SeasonsAdminRepository;
    for (const granted of [["players.view"], ["players.view", "players.board.restrict"]] as Permission[][]) {
      const set = new Set<Permission>(granted);
      const service = new SeasonsAdminService(
        new SeasonSchedule(panelSettings()),
        new WeekStore() as unknown as SeasonBoardStore,
        new MemoryLeaderboardStore(),
        {} as SeasonsRepository,
        {} as never,
        archive,
        { can: async (_actor: AccountRef, permission: Permission) => set.has(permission) } as unknown as RolesService,
      );
      expect(await service.playerSeasons(ACTOR, id(1))).toEqual({ seasons: [] });
    }
    expect(asked).toEqual([false, true]);
  });
});

describe("рейтинг в панели по HTTP", () => {
  let app: NestFastifyApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start() {
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    const accounts = new MemoryAccountRepository();
    const roles = new MemoryRolesRepository();
    const stub = {
      boards: vi.fn(async () => ({ stub: "boards" })),
      seasons: vi.fn(async () => ({ stub: "seasons" })),
      season: vi.fn(async () => ({ stub: "season" })),
      playerSeasons: vi.fn(async () => ({ stub: "player" })),
    };
    @Module({
      controllers: [AdminSessionController, AdminRatingController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: new MemoryAdminSessionStore() },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: AppLinks, useValue: new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]) },
        { provide: SeasonsAdminService, useValue: stub },
        PanelLoginService,
        { provide: RateLimiter, useValue: { consume: async () => true } },
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
      return { cookie: `${ADMIN_SESSION_COOKIE}=${/rubezh_admin_session=([^;]+)/.exec(String(response.headers["set-cookie"]))?.[1] ?? ""}`, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE };
    };
    const withRole = async (platformUserId: string, role: "analyst" | "moderator") => {
      const account = await accounts.upsert({ platform: "telegram", platformUserId, displayName: role, username: null, photoUrl: null }, Date.now());
      await roles.grant(account.accountId, role, null);
      return await login(`${platformUserId}:${role}`);
    };
    return { stub, login, withRole };
  }

  const ACCOUNT = "3f2b8c1e-5d4a-4e6f-9a1b-2c3d4e5f6a7b";
  const get = (url: string, headers: Record<string, string>) => app!.inject({ method: "GET", url: `${URL_BASE}${url}`, headers });
  const message = (response: { json: <T>() => T }) => response.json<{ error: { message: string } }>().error.message;

  it("четыре ручки под players.view: аналитик без права получает 403, модератор — данные", async () => {
    const ctx = await start();
    const analyst = await ctx.withRole("dev-player-940", "analyst");
    const moderator = await ctx.withRole("dev-player-941", "moderator");
    const urls = ["/rating/boards?difficulty=hard", "/rating/seasons", "/rating/seasons/2026-11-02?difficulty=hard", `/players/${ACCOUNT}/seasons`];
    for (const url of urls) {
      expect((await get(url, analyst)).statusCode, url).toBe(403);
      expect((await get(url, moderator)).statusCode, url).toBe(200);
    }
    expect(ctx.stub.boards).toHaveBeenCalledTimes(1);
    expect(ctx.stub.seasons).toHaveBeenCalledTimes(1);
    expect(ctx.stub.season).toHaveBeenCalledTimes(1);
    expect(ctx.stub.playerSeasons).toHaveBeenCalledTimes(1);
  });

  it("без сессии панели — 401", async () => {
    await start();
    expect((await app!.inject({ method: "GET", url: `${URL_BASE}/rating/seasons` })).statusCode).toBe(401);
  });

  it("запрос доски: умолчания period=week, board=common, limit=100", async () => {
    const ctx = await start();
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);
    expect((await get("/rating/boards?difficulty=hard", owner)).statusCode).toBe(200);
    expect(ctx.stub.boards).toHaveBeenCalledWith(expect.anything(), { difficulty: "hard", period: "week", board: "common", limit: 100 });
  });

  it("разбор: сложность не из списка, период и доска не из списка, limit за пределом — 400 с текстом", async () => {
    const ctx = await start();
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);
    for (const url of ["/rating/boards?difficulty=nightmare", "/rating/boards", "/rating/boards?difficulty=hard&period=month", "/rating/boards?difficulty=hard&board=secret", "/rating/boards?difficulty=hard&limit=500", "/rating/boards?difficulty=hard&limit=0"]) {
      const response = await get(url, owner);
      expect(response.statusCode, url).toBe(400);
      expect(message(response)).toBe("Некорректная сложность, период или доска");
    }
    const season = await get("/rating/seasons/2026-11-02?difficulty=hard&limit=201", owner);
    expect(season.statusCode).toBe(400);
    expect(message(season)).toBe("Некорректная сложность, период или доска");
    expect(ctx.stub.boards).not.toHaveBeenCalled();
  });

  it("разбор: ключ сезона не понедельник или не дата — 400 «Некорректный сезон»", async () => {
    const ctx = await start();
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);
    for (const url of ["/rating/seasons/2026-11-03?difficulty=hard", "/rating/seasons/abc?difficulty=hard", "/rating/seasons?before=2026-11-04", "/rating/seasons?limit=53"]) {
      const response = await get(url, owner);
      expect(response.statusCode, url).toBe(400);
      expect(message(response)).toBe("Некорректный сезон");
    }
    expect(ctx.stub.season).not.toHaveBeenCalled();
    expect(ctx.stub.seasons).not.toHaveBeenCalled();
  });

  it("разбор: идентификатор аккаунта не uuid — 400", async () => {
    const ctx = await start();
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);
    const response = await get("/players/not-an-id/seasons", owner);
    expect(response.statusCode).toBe(400);
    expect(message(response)).toBe("Некорректный идентификатор аккаунта");
    expect(ctx.stub.playerSeasons).not.toHaveBeenCalled();
  });

  it("запрос архива и итогов сезона доходит до сервиса разобранным", async () => {
    const ctx = await start();
    const owner = await ctx.login(`dev-${OWNER_ID}:Владелец`);
    await get("/rating/seasons?before=2026-11-09&limit=2", owner);
    expect(ctx.stub.seasons).toHaveBeenCalledWith({ before: "2026-11-09", limit: 2 });
    await get("/rating/seasons/2026-11-02?difficulty=hard&offset=10", owner);
    expect(ctx.stub.season).toHaveBeenCalledWith(expect.anything(), "2026-11-02", { difficulty: "hard", board: "common", offset: 10, limit: 100 });
    await get(`/players/${ACCOUNT}/seasons`, owner);
    expect(ctx.stub.playerSeasons).toHaveBeenCalledWith(expect.anything(), ACCOUNT);
  });
});
