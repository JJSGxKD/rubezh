import "reflect-metadata";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { DomainError, ValidationError } from "../src/common/domain-error.js";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { LinkUnavailableError } from "../src/modules/external-identity/external-identity-errors.js";
import type { ExternalIdentityService } from "../src/modules/external-identity/external-identity.service.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import type { MediaService } from "../src/modules/media/media.service.js";
import type { AccountRestrictions } from "../src/modules/restrictions/account-restrictions.js";
import type { AccountRef, RolesService } from "../src/modules/roles/roles.service.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { NetworkTasksService } from "../src/modules/tasks/network-tasks.service.js";
import { NO_ACHIEVEMENT_FIELDS, visibleOn, type TaskDef, type TaskParticipation } from "../src/modules/tasks/task-rules.js";
import { TaskLinkRequiredError, TaskNotFoundError, TaskNotJoinedError } from "../src/modules/tasks/tasks-errors.js";
import { TasksController } from "../src/modules/tasks/tasks.controller.js";
import { ACHIEVEMENT_PERIOD_START, type TaskProgressRow, type TasksRepository } from "../src/modules/tasks/tasks.repository.js";
import { TasksService, viewOf } from "../src/modules/tasks/tasks.service.js";
import { ChannelMemberships, type ChannelMembership } from "../src/platforms/ports/channel-membership.js";
import { ExternalLinkStarters, type ExternalLinkStarter } from "../src/platforms/ports/external-link.js";
import type { PlatformId } from "../src/platforms/ports/platform.js";
import type { GrantInput, GrantResult, WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";

/**
 * Задания-каналы другой площадки (docs/35-stage4-plan.md Р188, tasks/T-0377):
 * канал MAX или VK виден игроку Telegram, только когда у площадки есть и
 * проверка подписки, и ссылка на бота; «Проверить» без связи просит открыть
 * бота, со связью спрашивает площадку по id игрока там. Задания своей
 * площадки работают как прежде.
 */

const ME = "00000000-0000-4000-8000-00000000f001";
const PLAYER: AccountRef = { accountId: ME, platform: "telegram", platformUserId: "555000111" };
const NOON = new Date(Date.UTC(2026, 10, 10, 9));

function channel(taskId: string, platform: "telegram" | "max" | "vk", patch: Partial<TaskDef> = {}): TaskDef {
  return {
    taskId,
    period: "achievement",
    kind: "channel",
    params: { platform, chat: platform === "telegram" ? "@rubezh_game" : "-100500", url: `https://${platform === "telegram" ? "t.me" : platform === "max" ? "max.ru" : "vk.com"}/rubezh` },
    filter: null,
    tier: null,
    target: 1,
    title: null,
    coins: 0,
    gems: 15,
    shards: 0,
    passPoints: 0,
    sort: 0,
    active: true,
    limit: null,
    image: null,
    ...NO_ACHIEVEMENT_FIELDS,
    ...patch,
  };
}

/** Каталог в памяти: только то, что нужно показу, переходу и забору партнёрской цели. */
class MiniTasks implements TasksRepository {
  readonly defs: TaskDef[] = [];
  readonly rows = new Map<string, TaskProgressRow>();
  readonly claimed = new Set<string>();

  async catalog(): Promise<TaskDef[]> {
    return this.defs.map((task) => ({ ...task }));
  }

  async progress(): Promise<TaskProgressRow[]> {
    return [...this.rows.values()].map((row) => ({ ...row, claimed: this.claimed.has(row.taskId) }));
  }

  async complete(_accountId: string, task: Pick<TaskDef, "taskId" | "target">): Promise<TaskProgressRow> {
    const row = { taskId: task.taskId, periodStart: ACHIEVEMENT_PERIOD_START, value: task.target, done: true, claimed: false };
    this.rows.set(task.taskId, row);
    return row;
  }

  async completedCount(): Promise<number> {
    return 0;
  }

  async markClaimed(_accountId: string, taskId: string): Promise<boolean> {
    if (this.claimed.has(taskId)) return false;
    this.claimed.add(taskId);
    return true;
  }

  async markOpened(): Promise<void> {}

  async participation(): Promise<Map<string, TaskParticipation>> {
    return new Map();
  }

  async completions(): Promise<Map<string, number>> {
    return new Map();
  }

  async applyRun(): Promise<boolean> {
    return false;
  }

  async applyState(): Promise<void> {}

  async insert(): Promise<boolean> {
    return false;
  }

  async update(): Promise<boolean> {
    return false;
  }

  async reorder(): Promise<never> {
    throw new Error("порядок в этих тестах не меняется");
  }
}

class FakeWallet {
  readonly grants: GrantInput[] = [];

  async grant(input: GrantInput): Promise<GrantResult> {
    this.grants.push(input);
    return { credited: input.amount, balance: 0, duplicate: false };
  }
}

/** Бот площадки: кого он видит в каких каналах. Спрашивали его теми id, что в `asked`. */
class FakeMembership implements ChannelMembership {
  readonly members = new Set<string>();
  readonly asked: [string, string][] = [];

  constructor(readonly platform: PlatformId) {}

  async isMember(chat: string, platformUserId: string): Promise<boolean> {
    this.asked.push([chat, platformUserId]);
    return this.members.has(`${chat}|${platformUserId}`);
  }
}

/** Связи игроков и выданные ссылки; настоящий сервис с хранилищами проверен в `external-identity*.test.ts`. */
class FakeExternal {
  readonly links = new Map<string, string>();
  readonly started: [string, PlatformId][] = [];
  failure: Error | null = null;

  async externalId(accountId: string, platform: PlatformId): Promise<string | null> {
    return this.links.get(`${accountId}|${platform}`) ?? null;
  }

  async startLink(account: AccountRef, platform: PlatformId): Promise<{ url: string }> {
    this.started.push([account.accountId, platform]);
    if (this.failure !== null) throw this.failure;
    return { url: `https://max.ru/rubezh_bot?start=Abcdefghij012345` };
  }
}

function starter(platform: PlatformId, configured = true): ExternalLinkStarter {
  return { platform, startUrl: (code) => (configured ? `https://${platform}.example/bot?start=${code}` : null) };
}

interface Options {
  starters?: readonly ExternalLinkStarter[];
  memberships?: readonly PlatformId[];
}

function setup(options: Options = {}) {
  const repository = new MiniTasks();
  const wallet = new FakeWallet();
  const external = new FakeExternal();
  const checks = new Map<PlatformId, FakeMembership>((options.memberships ?? ["telegram", "max", "vk"]).map((platform) => [platform, new FakeMembership(platform)]));
  const restrictions = { ensure: async () => undefined } as unknown as AccountRestrictions;
  const service = new TasksService(
    repository,
    wallet as unknown as WalletService,
    new RunsHooks(),
    {} as RolesService,
    new ChannelMemberships([...checks.values()]),
    {} as MediaService,
    restrictions,
    undefined,
    undefined,
    undefined,
    external as unknown as ExternalIdentityService,
    new ExternalLinkStarters(options.starters ?? [starter("max"), starter("vk")]),
  );
  return { repository, wallet, external, checks, service };
}

const byId = (tasks: { id: string }[], id: string) => tasks.find((task) => task.id === id);

async function failure(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("ожидали доменную ошибку, а вызов прошёл");
}

describe("видимость канала другой площадки", () => {
  it("канал MAX у игрока Telegram без стартера MAX не виден", async () => {
    const ctx = setup({ starters: [] });
    ctx.repository.defs.push(channel("join_max", "max"));
    expect(await ctx.service.view(PLAYER, NOON)).toEqual([]);
  });

  it("стартер есть, а проверки подписки у площадки нет — не виден", async () => {
    const ctx = setup({ memberships: ["telegram"] });
    ctx.repository.defs.push(channel("join_max", "max"));
    expect(await ctx.service.view(PLAYER, NOON)).toEqual([]);
  });

  it("площадка без настройки (стартер вернул null) — не виден", async () => {
    const ctx = setup({ starters: [starter("max", false), starter("vk")] });
    ctx.repository.defs.push(channel("join_max", "max"), channel("join_vk", "vk"));
    expect((await ctx.service.view(PLAYER, NOON)).map((task) => task.id)).toEqual(["join_vk"]);
  });

  it("со стартером и проверкой виден: link external, площадка канала и ссылка на канал", async () => {
    const ctx = setup();
    ctx.repository.defs.push(channel("join_max", "max"), channel("join_vk", "vk", { sort: 1 }));
    const tasks = await ctx.service.view(PLAYER, NOON);
    expect(byId(tasks, "join_max")).toMatchObject({ linkMode: "external", channelPlatform: "max", link: "https://max.ru/rubezh", category: "partner" });
    expect(byId(tasks, "join_vk")).toMatchObject({ linkMode: "external", channelPlatform: "vk" });
  });

  it("канал Telegram у игрока Telegram — link own, как раньше виден и без стартеров", async () => {
    const ctx = setup({ starters: [] });
    ctx.repository.defs.push(channel("join_tg", "telegram"));
    const tasks = await ctx.service.view(PLAYER, NOON);
    expect(byId(tasks, "join_tg")).toMatchObject({ linkMode: "own", channelPlatform: "telegram" });
  });

  it("задания не каналы поля не несут, и «бот» партнёра с площадкой MAX не открывается Telegram даже при стартере", async () => {
    const ctx = setup();
    ctx.repository.defs.push(
      channel("ach_bot_max", "max", { kind: "bot", params: { platform: "max", url: "https://max.ru/partner_bot" } }),
      channel("ach_site", "max", { kind: "link", params: { url: "https://example.com/p" } }),
    );
    const tasks = await ctx.service.view(PLAYER, NOON);
    expect(byId(tasks, "ach_bot_max")).toBeUndefined();
    expect(byId(tasks, "ach_site")).toMatchObject({ linkMode: null, channelPlatform: null });
  });

  it("игрок MAX видит канал MAX как свой, без стартеров", async () => {
    const ctx = setup({ starters: [] });
    ctx.repository.defs.push(channel("join_max", "max"));
    const onMax: AccountRef = { accountId: ME, platform: "max", platformUserId: "max-user-1" };
    expect(byId(await ctx.service.view(onMax, NOON), "join_max")).toMatchObject({ linkMode: "own" });
  });

  it("правило видимости: канал чужой площадки — только из множества подключённых", () => {
    const params = { platform: "max", chat: "-100500", url: "https://max.ru/rubezh" } as const;
    expect(visibleOn(params, "telegram", new Set())).toBe(false);
    expect(visibleOn(params, "telegram", new Set<PlatformId>(["vk"]))).toBe(false);
    expect(visibleOn(params, "telegram", new Set<PlatformId>(["max"]))).toBe(true);
    expect(visibleOn(params, "max", new Set())).toBe(true);
    // без третьего аргумента — как раньше
    expect(visibleOn(params, "telegram")).toBe(false);
    expect(visibleOn(null, "telegram", new Set())).toBe(true);
    // не канал: список площадок и одиночная площадка бота остаются прежними
    expect(visibleOn({ platforms: ["max"], url: "https://example.com" }, "telegram", new Set<PlatformId>(["max"]))).toBe(false);
    expect(visibleOn({ platform: "max", url: "https://example.com" }, "telegram", new Set<PlatformId>(["max"]))).toBe(false);
  });

  it("viewOf без площадки игрока поле не заполняет, с площадкой — own или external", () => {
    // порядок списка — по `sort`, а не по id: свой канал первым
    const defs = [channel("join_tg", "telegram"), channel("join_max", "max", { sort: 1 })];
    expect(viewOf(defs, []).map((task) => task.linkMode)).toEqual([null, null]);
    expect(viewOf(defs, [], new Map(), NOON, "telegram").map((task) => task.linkMode)).toEqual(["own", "external"]);
  });
});

describe("«Проверить»: подписка на канал другой площадки", () => {
  it("без связи — task_link_required, площадку не спрашивали", async () => {
    const ctx = setup();
    ctx.repository.defs.push(channel("join_max", "max"));
    const error = await failure(ctx.service.claim(PLAYER, "join_max", NOON));
    expect(error).toBeInstanceOf(TaskLinkRequiredError);
    expect(error).toMatchObject({ status: 409, code: "task_link_required", message: "Сначала открой бота и нажми «Начать» — так мы узнаем твой аккаунт" });
    expect(ctx.checks.get("max")?.asked).toEqual([]);
    expect(ctx.wallet.grants).toEqual([]);
  });

  it("со связью — площадку спрашивают id игрока там, а не Telegram; подписан — награда", async () => {
    const ctx = setup();
    ctx.repository.defs.push(channel("join_max", "max"));
    ctx.external.links.set(`${ME}|max`, "max-user-77");
    ctx.checks.get("max")?.members.add("-100500|max-user-77");
    const result = await ctx.service.claim(PLAYER, "join_max", NOON);
    expect(result.claimed).toBe(true);
    expect(result.credited.gems).toBe(15);
    expect(ctx.checks.get("max")?.asked).toEqual([["-100500", "max-user-77"]]);
    expect(ctx.checks.get("telegram")?.asked).toEqual([]);
  });

  it("связан, но не подписан — прежний task_not_joined, награды нет", async () => {
    const ctx = setup();
    ctx.repository.defs.push(channel("join_vk", "vk"));
    ctx.external.links.set(`${ME}|vk`, "vk-user-5");
    const error = await failure(ctx.service.claim(PLAYER, "join_vk", NOON));
    expect(error).toBeInstanceOf(TaskNotJoinedError);
    expect(error.code).toBe("task_not_joined");
    expect(ctx.checks.get("vk")?.asked).toEqual([["-100500", "vk-user-5"]]);
    expect(ctx.wallet.grants).toEqual([]);
  });

  it("связь с другой площадкой не годится: MAX связан, а задание на VK", async () => {
    const ctx = setup();
    ctx.repository.defs.push(channel("join_vk", "vk"));
    ctx.external.links.set(`${ME}|max`, "max-user-77");
    expect((await failure(ctx.service.claim(PLAYER, "join_vk", NOON))).code).toBe("task_link_required");
  });

  it("канал Telegram у игрока Telegram — по platformUserId, связи не нужны", async () => {
    const ctx = setup({ starters: [] });
    ctx.repository.defs.push(channel("join_tg", "telegram"));
    ctx.checks.get("telegram")?.members.add("@rubezh_game|555000111");
    const result = await ctx.service.claim(PLAYER, "join_tg", NOON);
    expect(result.claimed).toBe(true);
    expect(ctx.checks.get("telegram")?.asked).toEqual([["@rubezh_game", "555000111"]]);
  });

  it("площадка отключена: канал скрыт, забор по нему — как по несуществующему заданию", async () => {
    const ctx = setup({ starters: [] });
    ctx.repository.defs.push(channel("join_max", "max"));
    ctx.external.links.set(`${ME}|max`, "max-user-77");
    expect(await failure(ctx.service.claim(PLAYER, "join_max", NOON))).toBeInstanceOf(TaskNotFoundError);
  });
});

describe("ссылка на бота для задания", () => {
  it("канал другой площадки — ссылка от сервиса связи; площадка — из задания, аккаунт — игрок", async () => {
    const ctx = setup();
    ctx.repository.defs.push(channel("join_max", "max"));
    const { url } = await ctx.service.startExternalLink(PLAYER, "join_max", NOON);
    expect(url).toBe("https://max.ru/rubezh_bot?start=Abcdefghij012345");
    expect(ctx.external.started).toEqual([[ME, "max"]]);
  });

  it("канал своей площадки, не канал и неизвестное задание — 400 / 400 / 404", async () => {
    const ctx = setup();
    ctx.repository.defs.push(channel("join_tg", "telegram"), channel("ach_site", "max", { kind: "link", params: { url: "https://example.com/p" } }));
    const own = await failure(ctx.service.startExternalLink(PLAYER, "join_tg", NOON));
    expect(own).toBeInstanceOf(ValidationError);
    expect(own.status).toBe(400);
    expect((await failure(ctx.service.startExternalLink(PLAYER, "ach_site", NOON))).status).toBe(400);
    expect(await failure(ctx.service.startExternalLink(PLAYER, "nope", NOON))).toBeInstanceOf(TaskNotFoundError);
    expect(ctx.external.started).toEqual([]);
  });

  it("площадка не подключена — задание скрыто, ссылки на него нет", async () => {
    const ctx = setup({ starters: [] });
    ctx.repository.defs.push(channel("join_max", "max"));
    expect(await failure(ctx.service.startExternalLink(PLAYER, "join_max", NOON))).toBeInstanceOf(TaskNotFoundError);
  });

  it("сервис связи отказал — ошибка доходит как есть (503 link_unavailable)", async () => {
    const ctx = setup();
    ctx.repository.defs.push(channel("join_max", "max"));
    ctx.external.failure = new LinkUnavailableError();
    expect(await failure(ctx.service.startExternalLink(PLAYER, "join_max", NOON))).toMatchObject({ status: 503, code: "link_unavailable" });
  });
});

describe("по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("POST /tasks/:id/link: без токена 401, кривой id 400, своя площадка 400, нет задания 404, канал MAX — 200 со ссылкой; «Проверить» без связи — 409", async () => {
    const ctx = setup();
    ctx.repository.defs.push(channel("join_max", "max"), channel("join_tg", "telegram", { sort: 1 }));
    @Module({
      controllers: [TasksController],
      providers: [
        { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv) },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: TasksService, useValue: ctx.service },
        { provide: NetworkTasksService, useValue: { view: async () => [] } },
        RateLimiter,
        AuthGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const token = await signAccessToken({ accountId: ME, platform: "telegram", platformUserId: "555000111" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    const headers = { authorization: `Bearer ${token}` };

    expect((await app.inject({ method: "POST", url: "/api/v1/tasks/join_max/link" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/tasks/Bad%20Id/link", headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/tasks/join_tg/link", headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/tasks/nope/link", headers })).statusCode).toBe(404);

    const link = await app.inject({ method: "POST", url: "/api/v1/tasks/join_max/link", headers });
    expect(link.statusCode).toBe(200);
    expect(link.json<{ data: { url: string } }>().data.url).toBe("https://max.ru/rubezh_bot?start=Abcdefghij012345");

    const view = await app.inject({ method: "GET", url: "/api/v1/tasks", headers });
    expect(view.json<{ data: { tasks: { id: string; linkMode: string | null }[] } }>().data.tasks.map((task) => [task.id, task.linkMode])).toEqual([
      ["join_max", "external"],
      ["join_tg", "own"],
    ]);

    const unlinked = await app.inject({ method: "POST", url: "/api/v1/tasks/join_max/claim", headers });
    expect(unlinked.statusCode).toBe(409);
    expect(unlinked.json<{ error: { code: string } }>().error.code).toBe("task_link_required");

    ctx.external.failure = new LinkUnavailableError();
    const down = await app.inject({ method: "POST", url: "/api/v1/tasks/join_max/link", headers });
    expect(down.statusCode).toBe(503);
    expect(down.json<{ error: { code: string } }>().error.code).toBe("link_unavailable");
  });
});
