import "reflect-metadata";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import { ChannelMemberships, MembershipRejectedError, MembershipUnavailableError, type ChannelMembership } from "../src/platforms/ports/channel-membership.js";
import {
  TaskCheckUnavailableError,
  TaskNotDoneError,
  TaskNotFoundError,
  TaskNotJoinedError,
  TaskNotOpenedError,
  TaskShapeLockedError,
} from "../src/modules/tasks/tasks-errors.js";
import { NetworkTasksService } from "../src/modules/tasks/network-tasks.service.js";
import { RUN_KINDS, countsForTasks, rewardReason, taskDefSchema, type TaskDef } from "../src/modules/tasks/task-rules.js";
import { TasksController } from "../src/modules/tasks/tasks.controller.js";
import { ACHIEVEMENT_PERIOD_START, type TaskDelta, type TaskProgressRow, type TasksRepository } from "../src/modules/tasks/tasks.repository.js";
import { TasksService } from "../src/modules/tasks/tasks.service.js";
import type { GrantInput, GrantResult, WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Задания и достижения (docs/35-stage4-plan.md Р52, WP13): прогресс — от
 * записанного забега, а не от клиента; повтор события не двигает прогресс
 * дважды; ежедневные — по московским суткам, недельные — с понедельника,
 * достижения — навсегда; награда забирается однажды.
 */

const ME = "00000000-0000-4000-8000-00000000f001";
/** игрок в Telegram — так его видят `view` и `claim` */
const PLAYER: AccountRef = { accountId: ME, platform: "telegram", platformUserId: "555000111" };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** среда, 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));

function def(taskId: string, patch: Partial<TaskDef> = {}): TaskDef {
  return { taskId, period: "daily", kind: "runs", params: null, target: 3, title: null, coins: 100, gems: 0, shards: 0, passPoints: 0, sort: 0, active: true, ...patch };
}

const CATALOG: TaskDef[] = [
  def("daily_runs"),
  def("daily_kills", { kind: "kills", target: 1000, coins: 150, sort: 20 }),
  def("daily_survive", { kind: "survive_sec", target: 900, coins: 150, shards: 3, sort: 30 }),
  def("weekly_runs", { period: "weekly", target: 25, coins: 800, shards: 10 }),
  def("ach_survive_5", { period: "achievement", kind: "best_survival_sec", target: 300, coins: 0, gems: 5 }),
  def("ach_level_40", { period: "achievement", kind: "run_level", target: 40, coins: 0, gems: 10 }),
  def("old_task", { active: false }),
];

/** Начало срока, как его считает база: Москва — UTC+3 без летнего времени, неделя — с понедельника. */
function periodStart(period: TaskDef["period"], at: Date): string {
  if (period === "achievement") return ACHIEVEMENT_PERIOD_START;
  const moscow = new Date(at.getTime() + 3 * HOUR);
  const day = new Date(Date.UTC(moscow.getUTCFullYear(), moscow.getUTCMonth(), moscow.getUTCDate()));
  if (period === "weekly") day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

class MemoryTasks implements TasksRepository {
  readonly defs: TaskDef[] = CATALOG.map((task) => ({ ...task }));
  readonly rows = new Map<string, TaskProgressRow & { accountId: string; target: number }>();
  readonly runs = new Set<string>();
  catalogReads = 0;

  async catalog(): Promise<TaskDef[]> {
    this.catalogReads++;
    return this.defs.map((task) => ({ ...task }));
  }

  async progress(accountId: string, at: Date): Promise<TaskProgressRow[]> {
    const result: TaskProgressRow[] = [];
    for (const task of this.defs.filter((candidate) => candidate.active)) {
      const row = this.rows.get(`${accountId}|${task.taskId}|${periodStart(task.period, at)}`);
      if (row !== undefined) result.push({ taskId: row.taskId, periodStart: row.periodStart, value: row.value, done: row.done, claimed: row.claimed });
    }
    return result;
  }

  async applyRun(input: { runId: string; accountId: string; at: Date; deltas: readonly TaskDelta[] }): Promise<boolean> {
    if (this.runs.has(input.runId)) return false;
    this.runs.add(input.runId);
    for (const delta of input.deltas.filter((candidate) => candidate.amount > 0)) {
      const start = periodStart(delta.period, input.at);
      const key = `${input.accountId}|${delta.taskId}|${start}`;
      const row = this.rows.get(key) ?? { accountId: input.accountId, taskId: delta.taskId, periodStart: start, value: 0, target: delta.target, done: false, claimed: false };
      const merged = delta.op === "sum" ? row.value + delta.amount : Math.max(row.value, delta.amount);
      row.value = Math.min(delta.target, merged);
      row.target = delta.target;
      row.done = row.done || row.value >= delta.target;
      this.rows.set(key, row);
    }
    return true;
  }

  async insert(task: TaskDef): Promise<boolean> {
    if (this.defs.some((candidate) => candidate.taskId === task.taskId)) return false;
    this.defs.push({ ...task });
    return true;
  }

  async update(task: TaskDef): Promise<boolean> {
    const index = this.defs.findIndex((candidate) => candidate.taskId === task.taskId);
    if (index < 0) return false;
    const before = this.defs[index];
    if (before !== undefined) this.defs[index] = { ...task, period: before.period, kind: before.kind };
    return true;
  }

  async complete(accountId: string, task: Pick<TaskDef, "taskId" | "period" | "target">, at: Date): Promise<TaskProgressRow> {
    const start = periodStart(task.period, at);
    const key = `${accountId}|${task.taskId}|${start}`;
    const row = this.rows.get(key) ?? { accountId, taskId: task.taskId, periodStart: start, value: 0, target: task.target, done: false, claimed: false };
    row.value = Math.max(row.value, task.target);
    row.done = true;
    this.rows.set(key, row);
    return { taskId: row.taskId, periodStart: row.periodStart, value: row.value, done: row.done, claimed: row.claimed };
  }

  async markClaimed(accountId: string, taskId: string, start: string): Promise<boolean> {
    const row = this.rows.get(`${accountId}|${taskId}|${start}`);
    if (row === undefined || !row.done || row.claimed) return false;
    row.claimed = true;
    return true;
  }
}

class FakeWallet {
  readonly grants: GrantInput[] = [];
  readonly keys = new Set<string>();

  async grant(input: GrantInput): Promise<GrantResult> {
    const duplicate = this.keys.has(input.idempotencyKey);
    if (!duplicate) {
      this.keys.add(input.idempotencyKey);
      this.grants.push(input);
    }
    return { credited: duplicate ? 0 : input.amount, balance: 0, duplicate };
  }
}

/** Бот площадки: кто в каком канале состоит, или чем он отвечает вместо ответа. */
class FakeMembership implements ChannelMembership {
  readonly platform = "telegram" as const;
  readonly members = new Set<string>();
  readonly asked: [string, string][] = [];
  failure: Error | null = null;

  async isMember(chat: string, platformUserId: string): Promise<boolean> {
    this.asked.push([chat, platformUserId]);
    if (this.failure !== null) throw this.failure;
    return this.members.has(`${chat}|${platformUserId}`);
  }
}

function run(patch: Partial<RecordedRun> = {}): RecordedRun {
  return {
    runId: `run-${String(Math.random()).slice(2)}`,
    accountId: ME,
    difficulty: "easy",
    outcome: "died",
    survivalSec: 360,
    level: 22,
    enemiesKilled: 400,
    startingWeaponId: "spark",
    deathCause: null,
    cheats: false,
    continues: 0,
    ranked: true,
    verdict: "ok",
    reasons: [],
    finishedAt: NOON,
    ...patch,
  };
}

const OWNER_ID = "777000222";

function setup() {
  const repository = new MemoryTasks();
  const wallet = new FakeWallet();
  const hooks = new RunsHooks();
  const accounts = new MemoryAccountRepository();
  const roles = new MemoryRolesRepository();
  const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
  const membership = new FakeMembership();
  const memberships = new ChannelMemberships([membership]);
  const service = new TasksService(repository, wallet as unknown as WalletService, hooks, new RolesService(config, roles, accounts), memberships);
  service.onModuleInit();
  return { repository, wallet, hooks, service, accounts, roles, membership };
}

async function person(ctx: ReturnType<typeof setup>, id: string, role?: "game_designer" | "moderator"): Promise<AccountRef> {
  const account = await ctx.accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, Date.now());
  if (role !== undefined) await ctx.roles.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

const byId = (tasks: { id: string }[], id: string) => tasks.find((task) => task.id === id);

describe("правила заданий", () => {
  it("засчитывается тот же забег, что приносит награду: с читами, отклонённый и короткий — нет", () => {
    expect(countsForTasks(run())).toBe(true);
    expect(countsForTasks(run({ verdict: "suspicious" }))).toBe(true);
    expect(countsForTasks(run({ cheats: true }))).toBe(false);
    expect(countsForTasks(run({ verdict: "rejected" }))).toBe(false);
    expect(countsForTasks(run({ survivalSec: 29 }))).toBe(false);
  });

  it("вид цели знает, как забег двигает прогресс: копит за срок или помнит лучший", () => {
    const sample = run({ survivalSec: 125.9, enemiesKilled: 77, level: 12 });
    expect(RUN_KINDS.runs.measure()).toBe(1);
    expect(RUN_KINDS.kills.measure(sample)).toBe(77);
    expect(RUN_KINDS.survive_sec.measure(sample)).toBe(125);
    expect(RUN_KINDS.best_survival_sec).toMatchObject({ op: "max" });
    expect(RUN_KINDS.run_level.measure(sample)).toBe(12);
  });

  it("ежедневные и недельные платят как задания, достижения — своей причиной", () => {
    expect(rewardReason("daily")).toBe("task_reward");
    expect(rewardReason("weekly")).toBe("task_reward");
    expect(rewardReason("achievement")).toBe("achievement_reward");
  });

  it("строку каталога без награды, с неизвестным видом или кривым id схема не пропустит", () => {
    expect(taskDefSchema.safeParse(def("daily_runs")).success).toBe(true);
    expect(taskDefSchema.safeParse(def("daily_runs", { coins: 0 })).success).toBe(false);
    expect(taskDefSchema.safeParse({ ...def("daily_runs"), kind: "elites" }).success).toBe(false);
    expect(taskDefSchema.safeParse(def("Daily Runs")).success).toBe(false);
    expect(taskDefSchema.safeParse(def("daily_runs", { target: 0 })).success).toBe(false);
    expect(taskDefSchema.safeParse({ ...def("daily_runs"), extra: 1 }).success).toBe(false);
  });
});

const CHANNEL = { platform: "telegram", chat: "@rubezh_game", url: "https://t.me/rubezh_game" } as const;

function channelTask(patch: Partial<TaskDef> = {}): TaskDef {
  return def("ach_channel", { period: "achievement", kind: "channel", params: { ...CHANNEL }, target: 1, coins: 0, gems: 15, sort: 90, ...patch });
}

describe("цель «канал»: схема", () => {
  it("канал — только у цели «канал» и только достижением с целью 1", () => {
    expect(taskDefSchema.safeParse(channelTask()).success).toBe(true);
    expect(taskDefSchema.safeParse(channelTask({ params: null })).success).toBe(false);
    expect(taskDefSchema.safeParse(def("daily_runs", { params: { ...CHANNEL } })).success).toBe(false);
    // ежедневная подписка — одна и та же награда за ту же подписку каждый день
    expect(taskDefSchema.safeParse(channelTask({ period: "daily" })).success).toBe(false);
    expect(taskDefSchema.safeParse(channelTask({ target: 2 })).success).toBe(false);
  });

  it("строка панели без поля параметров — цель забега, а канал без них не пройдёт", () => {
    const bare = (task: TaskDef) => Object.fromEntries(Object.entries(task).filter(([key]) => key !== "params"));
    expect(taskDefSchema.parse(bare(def("daily_runs")))).toMatchObject({ params: null });
    expect(taskDefSchema.safeParse(bare(channelTask())).success).toBe(false);
  });

  it("ссылка — только https, площадка — известная, лишнего в параметрах нет", () => {
    const params = (patch: Record<string, unknown>) => ({ ...channelTask(), params: { ...CHANNEL, ...patch } });
    expect(taskDefSchema.safeParse(params({ url: "http://t.me/rubezh_game" })).success).toBe(false);
    expect(taskDefSchema.safeParse(params({ url: "javascript:alert(1)" })).success).toBe(false);
    expect(taskDefSchema.safeParse(params({ platform: "icq" })).success).toBe(false);
    // у веб-версии каналов нет
    expect(taskDefSchema.safeParse(params({ platform: "web" })).success).toBe(false);
    expect(taskDefSchema.safeParse(params({ chat: "" })).success).toBe(false);
    expect(taskDefSchema.safeParse(params({ extra: 1 })).success).toBe(false);
  });
});

describe("партнёрские цели: ссылка и бот", () => {
  const LINK = { url: "https://example.com/partner" } as const;
  const linkTask = (patch: Partial<TaskDef> = {}) =>
    def("ach_partner_site", { period: "achievement", kind: "link", params: { ...LINK }, target: 1, coins: 50, gems: 0, sort: 95, ...patch });

  function withPartners() {
    const ctx = setup();
    ctx.repository.defs.push(linkTask(), linkTask({ taskId: "ach_partner_bot", kind: "bot", params: { platform: "telegram", url: "https://t.me/partner_bot?start=rubezh" } }));
    return ctx;
  }

  it("схема: ссылка — только https; площадка у ссылки и бота необязательна, канал — только у подписки", () => {
    expect(taskDefSchema.safeParse(linkTask()).success).toBe(true);
    expect(taskDefSchema.safeParse(linkTask({ kind: "bot", params: { platform: "vk", url: "https://vk.com/partner" } })).success).toBe(true);
    expect(taskDefSchema.safeParse(linkTask({ params: null })).success).toBe(false);
    expect(taskDefSchema.safeParse(linkTask({ params: { url: "https://example.com", chat: "@x_game" } })).success).toBe(false);
    expect(taskDefSchema.safeParse(linkTask({ period: "weekly" })).success).toBe(false);
    // подписке на канал без площадки и канала спросить бота не о чем
    expect(taskDefSchema.safeParse(channelTask({ params: { url: "https://t.me/rubezh_game" } })).success).toBe(false);
  });

  it("партнёрские цели — своей категорией; цель без площадки видна на любой, с площадкой — только там", async () => {
    const ctx = withPartners();
    const tasks = await ctx.service.view(PLAYER, NOON);
    expect(byId(tasks, "ach_partner_site")).toMatchObject({ category: "partner", period: "achievement", link: LINK.url });
    expect(byId(tasks, "daily_runs")).toMatchObject({ category: "daily" });
    const vk: AccountRef = { accountId: ME, platform: "vk", platformUserId: "555000111" };
    const onVk = await ctx.service.view(vk, NOON);
    expect(byId(onVk, "ach_partner_site")).toBeDefined();
    expect(byId(onVk, "ach_partner_bot")).toBeUndefined();
  });

  it("ссылка — на нескольких площадках списком: видна там, где есть в списке; у канала — одна площадка", async () => {
    const ctx = setup();
    ctx.repository.defs.push(linkTask({ params: { platforms: ["telegram", "max"], url: LINK.url } }));
    const on = (platform: AccountRef["platform"]): AccountRef => ({ accountId: ME, platform, platformUserId: "555000111" });
    expect(byId(await ctx.service.view(on("telegram"), NOON), "ach_partner_site")).toBeDefined();
    expect(byId(await ctx.service.view(on("max"), NOON), "ach_partner_site")).toBeDefined();
    expect(byId(await ctx.service.view(on("vk"), NOON), "ach_partner_site")).toBeUndefined();

    expect(taskDefSchema.safeParse(linkTask({ params: { platforms: ["web"], url: LINK.url } })).success).toBe(true);
    // пустой список, повтор, незнакомая площадка и оба поля сразу — битые данные
    expect(taskDefSchema.safeParse(linkTask({ params: { platforms: [], url: LINK.url } })).success).toBe(false);
    expect(taskDefSchema.safeParse(linkTask({ params: { platforms: ["vk", "vk"], url: LINK.url } })).success).toBe(false);
    expect(taskDefSchema.safeParse({ ...linkTask(), params: { platforms: ["icq"], url: LINK.url } }).success).toBe(false);
    expect(taskDefSchema.safeParse(linkTask({ params: { platform: "vk", platforms: ["vk"], url: LINK.url } })).success).toBe(false);
    expect(taskDefSchema.safeParse(channelTask({ params: { ...CHANNEL, platforms: ["telegram"] } })).success).toBe(false);
  });

  it("без перехода не забрать; переход выполняет цель, повтор ничего не меняет, награда — однажды", async () => {
    const ctx = withPartners();
    await expect(ctx.service.claim(PLAYER, "ach_partner_bot", NOON)).rejects.toBeInstanceOf(TaskNotOpenedError);

    const opened = await ctx.service.open(PLAYER, "ach_partner_bot", NOON);
    expect(opened.url).toBe("https://t.me/partner_bot?start=rubezh");
    expect(byId(opened.tasks, "ach_partner_bot")).toMatchObject({ done: true, claimed: false, value: 1 });
    await ctx.service.open(PLAYER, "ach_partner_bot", new Date(NOON.getTime() + HOUR));

    expect(await ctx.service.claim(PLAYER, "ach_partner_bot", NOON)).toMatchObject({ claimed: true, credited: { coins: 50 } });
    expect(await ctx.service.claim(PLAYER, "ach_partner_bot", NOON)).toMatchObject({ claimed: false });
    expect(ctx.wallet.grants).toEqual([expect.objectContaining({ reason: "achievement_reward", idempotencyKey: `task:${ME}:ach_partner_bot:${ACHIEVEMENT_PERIOD_START}:coins` })]);
    // бот площадки здесь не нужен — спрашивать некого
    expect(ctx.membership.asked).toHaveLength(0);
  });

  it("переход к подписке на канал сам её не выполняет — её проверит забор; у цели забега ссылки нет", async () => {
    const ctx = setup();
    ctx.repository.defs.push(channelTask());
    expect(await ctx.service.open(PLAYER, "ach_channel", NOON)).toMatchObject({ url: CHANNEL.url });
    expect(byId(await ctx.service.view(PLAYER, NOON), "ach_channel")).toMatchObject({ done: false });
    await expect(ctx.service.open(PLAYER, "daily_runs", NOON)).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});

describe("цель «канал»: проверка площадкой", () => {
  function withChannel() {
    const ctx = setup();
    ctx.repository.defs.push(channelTask());
    return ctx;
  }
  const join = (ctx: ReturnType<typeof setup>, account: AccountRef = PLAYER) => ctx.membership.members.add(`${CHANNEL.chat}|${account.platformUserId}`);

  it("игрок видит канал своей площадки со ссылкой; у целей забега ссылки нет", async () => {
    const ctx = withChannel();
    const tasks = await ctx.service.view(PLAYER, NOON);
    expect(byId(tasks, "ach_channel")).toMatchObject({ kind: "channel", link: CHANNEL.url, value: 0, done: false, reward: { gems: 15 } });
    expect(byId(tasks, "daily_runs")).toMatchObject({ link: null });
  });

  it("канал другой площадки не показывается и не забирается", async () => {
    const ctx = withChannel();
    const vk: AccountRef = { accountId: ME, platform: "vk", platformUserId: "555000111" };
    expect(byId(await ctx.service.view(vk, NOON), "ach_channel")).toBeUndefined();
    await expect(ctx.service.claim(vk, "ach_channel", NOON)).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(ctx.membership.asked).toHaveLength(0);
  });

  it("не подписан — отказ с просьбой подписаться, награды нет", async () => {
    const ctx = withChannel();
    await expect(ctx.service.claim(PLAYER, "ach_channel", NOON)).rejects.toBeInstanceOf(TaskNotJoinedError);
    expect(ctx.membership.asked).toEqual([[CHANNEL.chat, PLAYER.platformUserId]]);
    expect(ctx.wallet.grants).toHaveLength(0);
    expect(byId(await ctx.service.view(PLAYER, NOON), "ach_channel")).toMatchObject({ done: false });
  });

  it("подписан — выполнено и забрано одним нажатием, причиной достижения; повтор площадку не спрашивает", async () => {
    const ctx = withChannel();
    join(ctx);
    const result = await ctx.service.claim(PLAYER, "ach_channel", NOON);
    expect(result).toMatchObject({ claimed: true, credited: { gems: 15 } });
    expect(byId(result.tasks, "ach_channel")).toMatchObject({ value: 1, done: true, claimed: true });
    expect(ctx.wallet.grants).toEqual([
      expect.objectContaining({ resource: "gems", amount: 15, reason: "achievement_reward", idempotencyKey: `task:${ME}:ach_channel:${ACHIEVEMENT_PERIOD_START}:gems` }),
    ]);

    // отписка после награды её не отнимает, а повтор не платит
    ctx.membership.members.clear();
    expect(await ctx.service.claim(PLAYER, "ach_channel", new Date(NOON.getTime() + DAY))).toMatchObject({ claimed: false });
    expect(ctx.membership.asked).toHaveLength(1);
    expect(ctx.wallet.grants).toHaveLength(1);
  });

  it("два нажатия разом начисляют однажды", async () => {
    const ctx = withChannel();
    join(ctx);
    const results = await Promise.all([ctx.service.claim(PLAYER, "ach_channel", NOON), ctx.service.claim(PLAYER, "ach_channel", NOON)]);
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(ctx.wallet.grants).toHaveLength(1);
  });

  it("площадка не ответила или задание настроено криво — «позже», а не «не подписан»", async () => {
    const ctx = withChannel();
    join(ctx);
    ctx.membership.failure = new MembershipUnavailableError("timeout");
    await expect(ctx.service.claim(PLAYER, "ach_channel", NOON)).rejects.toBeInstanceOf(TaskCheckUnavailableError);
    ctx.membership.failure = new MembershipRejectedError("Bad Request: chat not found");
    await expect(ctx.service.claim(PLAYER, "ach_channel", NOON)).rejects.toBeInstanceOf(TaskCheckUnavailableError);
    expect(ctx.wallet.grants).toHaveLength(0);

    ctx.membership.failure = null;
    expect(await ctx.service.claim(PLAYER, "ach_channel", NOON)).toMatchObject({ claimed: true });
  });

  it("площадке без проверки подписки — «позже»: канал есть, спросить некого", async () => {
    const ctx = setup();
    ctx.repository.defs.push(channelTask({ params: { ...CHANNEL, platform: "max" } }));
    const max: AccountRef = { accountId: ME, platform: "max", platformUserId: "555000111" };
    expect(byId(await ctx.service.view(max, NOON), "ach_channel")).toMatchObject({ link: CHANNEL.url });
    await expect(ctx.service.claim(max, "ach_channel", NOON)).rejects.toBeInstanceOf(TaskCheckUnavailableError);
  });

  it("забег цель «канал» не двигает, и знак меню её не считает, пока не нажата", async () => {
    const ctx = withChannel();
    join(ctx);
    for (let index = 0; index < 3; index++) await ctx.hooks.emit(run());
    expect(byId(await ctx.service.view(PLAYER, NOON), "ach_channel")).toMatchObject({ value: 0, done: false });
    // три ежедневные и рекорд в пять минут — без канала
    expect(await ctx.service.badge(ME, NOON)).toBe(4);
  });
});

describe("прогресс от забегов", () => {
  it("записанный забег двигает цели: копит забеги и убийства, помнит лучший, не уходит за цель", async () => {
    const { hooks, service } = setup();
    await hooks.emit(run({ enemiesKilled: 700, survivalSec: 320, level: 22 }));
    await hooks.emit(run({ enemiesKilled: 700, survivalSec: 200, level: 18 }));

    const tasks = await service.view(PLAYER, NOON);
    expect(byId(tasks, "daily_runs")).toMatchObject({ value: 2, done: false });
    expect(byId(tasks, "daily_kills")).toMatchObject({ value: 1000, target: 1000, done: true });
    expect(byId(tasks, "daily_survive")).toMatchObject({ value: 520, done: false });
    expect(byId(tasks, "ach_survive_5")).toMatchObject({ value: 300, done: true });
    expect(byId(tasks, "ach_level_40")).toMatchObject({ value: 22, done: false });
    expect(byId(tasks, "old_task")).toBeUndefined();
  });

  it("повтор события того же забега прогресс не удваивает", async () => {
    const { hooks, service } = setup();
    const same = run();
    await hooks.emit(same);
    await hooks.emit(same);
    await service.onRun(same);
    expect(byId(await service.view(PLAYER, NOON), "daily_runs")).toMatchObject({ value: 1 });
  });

  it("забег с читами и короткий цели не двигают", async () => {
    const { hooks, service, repository } = setup();
    await hooks.emit(run({ cheats: true }));
    await hooks.emit(run({ survivalSec: 10 }));
    expect(repository.runs.size).toBe(0);
    expect(byId(await service.view(PLAYER, NOON), "daily_runs")).toMatchObject({ value: 0 });
  });

  it("ежедневные — по московским суткам, недельные — с понедельника, достижения — навсегда", async () => {
    const { hooks, service } = setup();
    const sundayLate = new Date(Date.UTC(2026, 9, 4, 20, 59));
    const mondayEarly = new Date(Date.UTC(2026, 9, 4, 21, 1));
    await hooks.emit(run({ finishedAt: sundayLate, survivalSec: 400 }));
    expect(byId(await service.view(PLAYER, sundayLate), "weekly_runs")).toMatchObject({ value: 1 });

    const monday = await service.view(PLAYER, mondayEarly);
    expect(byId(monday, "daily_runs")).toMatchObject({ value: 0 });
    expect(byId(monday, "weekly_runs")).toMatchObject({ value: 0 });
    expect(byId(monday, "ach_survive_5")).toMatchObject({ value: 300, done: true });
  });
});

describe("забор награды", () => {
  async function completeDaily(ctx: ReturnType<typeof setup>): Promise<void> {
    for (let index = 0; index < 3; index++) await ctx.hooks.emit(run());
  }

  it("выполненное — забирается однажды: монеты и осколки ключом задания и срока", async () => {
    const ctx = setup();
    await completeDaily(ctx);
    await ctx.hooks.emit(run({ survivalSec: 900 }));
    const result = await ctx.service.claim(PLAYER, "daily_survive", NOON);

    expect(result).toMatchObject({ claimed: true, credited: { coins: 150, gems: 0, shards: 3 } });
    expect(byId(result.tasks, "daily_survive")).toMatchObject({ done: true, claimed: true });
    expect(ctx.wallet.grants.map((grant) => [grant.resource, grant.amount, grant.reason, grant.idempotencyKey])).toEqual([
      ["coins", 150, "task_reward", `task:${ME}:daily_survive:2026-09-30:coins`],
      ["shard_common", 3, "task_reward", `task:${ME}:daily_survive:2026-09-30:shard_common`],
    ]);

    const again = await ctx.service.claim(PLAYER, "daily_survive", NOON);
    expect(again).toMatchObject({ claimed: false, credited: { coins: 0, gems: 0, shards: 0 } });
    expect(ctx.wallet.grants).toHaveLength(2);
  });

  it("достижение платит самоцветами своей причиной", async () => {
    const ctx = setup();
    await ctx.hooks.emit(run({ survivalSec: 301 }));
    await ctx.service.claim(PLAYER, "ach_survive_5", NOON);
    expect(ctx.wallet.grants).toEqual([expect.objectContaining({ resource: "gems", amount: 5, reason: "achievement_reward" })]);
  });

  it("два забора разом начисляют однажды", async () => {
    const ctx = setup();
    await completeDaily(ctx);
    const results = await Promise.all([ctx.service.claim(PLAYER, "daily_runs", NOON), ctx.service.claim(PLAYER, "daily_runs", NOON)]);
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(ctx.wallet.grants).toHaveLength(1);
  });

  it("невыполненное не забирается, выключенное и чужое — как несуществующее", async () => {
    const ctx = setup();
    await ctx.hooks.emit(run());
    await expect(ctx.service.claim(PLAYER, "daily_runs", NOON)).rejects.toBeInstanceOf(TaskNotDoneError);
    await expect(ctx.service.claim(PLAYER, "old_task", NOON)).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(ctx.service.claim(PLAYER, "nope", NOON)).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(ctx.wallet.grants).toHaveLength(0);
  });

  it("вчерашнее выполненное сегодня не забрать: срок кончился", async () => {
    const ctx = setup();
    await completeDaily(ctx);
    await expect(ctx.service.claim(PLAYER, "daily_runs", new Date(NOON.getTime() + DAY))).rejects.toBeInstanceOf(TaskNotDoneError);
  });

  it("знак меню — сколько наград можно забрать сейчас", async () => {
    const ctx = setup();
    expect(await ctx.service.badge(ME, NOON)).toBe(0);
    await completeDaily(ctx);
    await ctx.hooks.emit(run({ level: 40 }));
    // три ежедневные, рекорд в пять минут и сороковой уровень
    expect(await ctx.service.badge(ME, NOON)).toBe(5);
    await ctx.service.claim(PLAYER, "daily_runs", NOON);
    expect(await ctx.service.badge(ME, NOON)).toBe(4);
  });

  it("каталог держится в памяти: сотня забегов не читает его сотню раз", async () => {
    const ctx = setup();
    for (let index = 0; index < 100; index++) await ctx.hooks.emit(run());
    expect(ctx.repository.catalogReads).toBe(1);
    ctx.service.forgetCatalog();
    await ctx.service.view(PLAYER, NOON);
    expect(ctx.repository.catalogReads).toBe(2);
  });
});

describe("каталог из панели", () => {
  it("геймдизайнер заводит задание и правит награду — игрок видит сразу, каждое изменение в аудите", async () => {
    const ctx = setup();
    const designer = await person(ctx, "501", "game_designer");
    const fresh = def("daily_boss", { kind: "run_level", target: 30, coins: 200, sort: 50, title: "Дойди до босса" });
    await ctx.service.view(PLAYER, NOON);
    await ctx.service.save(designer, fresh);
    expect(byId(await ctx.service.view(PLAYER, NOON), "daily_boss")).toMatchObject({ title: "Дойди до босса", target: 30, reward: { coins: 200 } });

    await ctx.service.save(designer, { ...fresh, coins: 250, active: false });
    expect(byId(await ctx.service.view(PLAYER, NOON), "daily_boss")).toBeUndefined();
    expect((await ctx.service.catalog(designer)).tasks.find((task) => task.taskId === "daily_boss")).toMatchObject({ coins: 250, active: false });

    const audit = (await ctx.roles.recentAudit(10)).filter((entry) => entry.target === "daily_boss").map((entry) => entry.action);
    expect(audit.sort()).toEqual(["tasks.create", "tasks.update"]);
  });

  it("срок и вид после создания не меняются: прогресс игроков записан по ним", async () => {
    const ctx = setup();
    const designer = await person(ctx, "502", "game_designer");
    await expect(ctx.service.save(designer, def("daily_runs", { period: "weekly" }))).rejects.toBeInstanceOf(TaskShapeLockedError);
    await expect(ctx.service.save(designer, def("daily_runs", { kind: "kills" }))).rejects.toBeInstanceOf(TaskShapeLockedError);
  });

  it("без права — отказ, и каталог не отдаётся", async () => {
    const ctx = setup();
    const moderator = await person(ctx, "503", "moderator");
    await expect(ctx.service.save(moderator, def("daily_x"))).rejects.toThrow();
    await expect(ctx.service.catalog(moderator)).rejects.toThrow();
    expect(ctx.repository.defs.some((task) => task.taskId === "daily_x")).toBe(false);
  });

  it("форма знает виды целей и сроки", async () => {
    const ctx = setup();
    const owner = await person(ctx, OWNER_ID);
    const view = await ctx.service.catalog(owner);
    expect(view.kinds).toEqual(["runs", "kills", "survive_sec", "best_survival_sec", "run_level", "channel", "link", "bot"]);
    expect(view.periods).toEqual(["daily", "weekly", "achievement"]);
    expect(view.tasks).toHaveLength(CATALOG.length);
  });
});

describe("задания по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("без токена — 401; кривой id — 400; нет задания — 404; не выполнено и не подписан — 409 с кодом; выполненное — 200", async () => {
    const ctx = setup();
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
    const token = await signAccessToken({ accountId: ME, platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    const headers = { authorization: `Bearer ${token}` };

    expect((await app.inject({ method: "GET", url: "/api/v1/tasks" })).statusCode).toBe(401);
    const view = await app.inject({ method: "GET", url: "/api/v1/tasks", headers });
    expect(view.statusCode).toBe(200);
    expect(view.json<{ data: { tasks: unknown[]; networks: unknown[] } }>().data).toMatchObject({ tasks: expect.any(Array), networks: [] });
    expect(view.json<{ data: { tasks: unknown[] } }>().data.tasks).toHaveLength(6);

    expect((await app.inject({ method: "POST", url: "/api/v1/tasks/DROP%20TABLE/claim", headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/tasks/nope/claim", headers })).statusCode).toBe(404);
    const notDone = await app.inject({ method: "POST", url: "/api/v1/tasks/daily_runs/claim", headers });
    expect(notDone.statusCode).toBe(409);
    expect(notDone.json<{ error: { code: string } }>().error.code).toBe("task_not_done");

    for (let index = 0; index < 3; index++) await ctx.hooks.emit(run({ finishedAt: new Date() }));
    const claim = await app.inject({ method: "POST", url: "/api/v1/tasks/daily_runs/claim", headers });
    expect(claim.statusCode).toBe(200);
    expect(claim.json<{ data: { claimed: boolean } }>().data.claimed).toBe(true);

    ctx.repository.defs.push(channelTask());
    ctx.service.forgetCatalog();
    const notJoined = await app.inject({ method: "POST", url: "/api/v1/tasks/ach_channel/claim", headers });
    expect(notJoined.statusCode).toBe(409);
    expect(notJoined.json<{ error: { code: string } }>().error.code).toBe("task_not_joined");
    ctx.membership.failure = new MembershipUnavailableError("timeout");
    const later = await app.inject({ method: "POST", url: "/api/v1/tasks/ach_channel/claim", headers });
    expect(later.statusCode).toBe(503);
    expect(later.json<{ error: { code: string } }>().error.code).toBe("task_check_unavailable");

    ctx.repository.defs.push(def("ach_partner_site", { period: "achievement", kind: "link", params: { url: "https://example.com/p" }, target: 1 }));
    ctx.service.forgetCatalog();
    const notOpened = await app.inject({ method: "POST", url: "/api/v1/tasks/ach_partner_site/claim", headers });
    expect(notOpened.json<{ error: { code: string } }>().error.code).toBe("task_not_opened");
    const open = await app.inject({ method: "POST", url: "/api/v1/tasks/ach_partner_site/open", headers });
    expect(open.statusCode).toBe(200);
    expect(open.json<{ data: { url: string } }>().data.url).toBe("https://example.com/p");
    expect((await app.inject({ method: "POST", url: "/api/v1/tasks/Bad%20Id/open", headers })).statusCode).toBe(400);
  });
});
