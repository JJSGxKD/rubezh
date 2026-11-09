import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { NotificationsService } from "../src/modules/notifications/notifications.service.js";
import { RestrictionsHooks } from "../src/modules/restrictions/restrictions-hooks.js";
import { RestrictionsService } from "../src/modules/restrictions/restrictions.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import {
  ASK_TIMEOUT_MS,
  BATCH,
  CLOSE_MS,
  GIVE_UP_AFTER_MS,
  RECHECK_EVERY_MS,
  TICK_MS,
  WATCH_MS,
  closesPartnerTasks,
  isFinalCheck,
  nextCheckAfter,
  shouldGiveUp,
  watchUntil,
} from "../src/modules/tasks/channel-watch-rules.js";
import type { ChannelWatchRepository, NewWatch, Penalty, WatchKey, WatchRow, WatchState } from "../src/modules/tasks/channel-watch.repository.js";
import { ChannelWatchService } from "../src/modules/tasks/channel-watch.service.js";
import { NO_ACHIEVEMENT_FIELDS, type TaskDef } from "../src/modules/tasks/task-rules.js";
import type { TasksRepository } from "../src/modules/tasks/tasks.repository.js";
import { ChannelMemberships, MembershipRejectedError, MembershipUnavailableError, type ChannelMembership } from "../src/platforms/ports/channel-membership.js";
import type { RevokeOutcome } from "../src/modules/wallet/wallet.repository.js";
import type { GrantInput, GrantResult, RevokeRequest, WalletService } from "../src/modules/wallet/wallet.service.js";
import type { WalletResource } from "../src/modules/wallet/wallet-types.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryNotificationsRepository } from "./helpers/memory-notifications.js";
import { MemoryRestrictionsRepository, restrictionsGate } from "./helpers/memory-restrictions.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Отписка от канала после награды (docs/35-stage4-plan.md Р115, tasks/T-0178):
 * сервер неделю перепроверяет подписку, списывает награду отписавшемуся (не ниже
 * нуля), при повторе в том же задании закрывает партнёрские задания на 30 суток.
 * Площадка, кошелёк, ограничения и лента — настоящие сервисы на памяти; время
 * инжектируется, поэтому неделя проходит за миллисекунды.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** понедельник, 05.10.2026, 12:00 по Москве */
const MON = new Date(Date.UTC(2026, 9, 5, 9));
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
const CHAT = "@rubezh_news";

function channelDef(taskId: string, patch: Partial<TaskDef> = {}): TaskDef {
  return {
    taskId,
    period: "daily",
    kind: "channel",
    params: { platform: "telegram", chat: CHAT, url: "https://t.me/rubezh_news" },
    filter: null,
    tier: null,
    target: 1,
    title: "Канал Рубежа",
    coins: 100,
    gems: 5,
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

/** Окна в памяти: те же условия, что у базы (записывают только `watching`), и замок пары, который не ждёт. */
class MemoryWatch implements ChannelWatchRepository {
  readonly rows: WatchRow[] = [];
  readonly dueLimits: number[] = [];
  /** сколько ближайших записей штрафа оборвать — как падение процесса между списанием и отметкой */
  breakMarkPenalized = 0;
  private readonly held = new Set<string>();

  async start(row: NewWatch): Promise<boolean> {
    if (this.rows.some((candidate) => same(candidate, row))) return false;
    this.rows.push({ ...row, checkedAt: null, state: "watching", eventNo: null, penalizedAt: null, revoked: null });
    return true;
  }

  async due(now: Date, limit: number): Promise<WatchRow[]> {
    this.dueLimits.push(limit);
    return this.rows
      .filter((row) => row.state === "watching" && row.nextCheckAt.getTime() <= now.getTime())
      .sort((a, b) => a.nextCheckAt.getTime() - b.nextCheckAt.getTime())
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async openOf(accountId: string, taskId: string): Promise<WatchRow[]> {
    return this.rows.filter((row) => row.accountId === accountId && row.taskId === taskId && row.state === "watching").map((row) => ({ ...row }));
  }

  async lastEventNo(accountId: string, taskId: string): Promise<number> {
    return Math.max(0, ...this.rows.filter((row) => row.accountId === accountId && row.taskId === taskId).map((row) => row.eventNo ?? 0));
  }

  async postpone(keys: readonly WatchKey[], nextCheckAt: Date, checkedAt: Date | null): Promise<void> {
    for (const row of this.open(keys)) {
      row.nextCheckAt = nextCheckAt;
      if (checkedAt !== null) row.checkedAt = checkedAt;
    }
  }

  async close(keys: readonly WatchKey[], state: Extract<WatchState, "kept" | "expired">, closedAt: Date): Promise<void> {
    for (const row of this.open(keys)) {
      row.state = state;
      if (state === "kept") row.checkedAt = closedAt;
    }
  }

  async markPenalized(items: readonly Penalty[], eventNo: number, penalizedAt: Date): Promise<void> {
    if (this.breakMarkPenalized > 0) {
      this.breakMarkPenalized -= 1;
      throw new Error("процесс оборвался");
    }
    for (const item of items) {
      for (const row of this.open([item.key])) Object.assign(row, { state: "penalized", eventNo, penalizedAt, revoked: item.revoked });
    }
  }

  async withPairLock<T>(accountId: string, taskId: string, work: () => Promise<T>): Promise<{ locked: true; value: T } | { locked: false }> {
    const key = `${accountId}|${taskId}`;
    if (this.held.has(key)) return { locked: false };
    this.held.add(key);
    try {
      return { locked: true, value: await work() };
    } finally {
      this.held.delete(key);
    }
  }

  private open(keys: readonly WatchKey[]): WatchRow[] {
    return this.rows.filter((row) => row.state === "watching" && keys.some((key) => same(row, key)));
  }
}

function same(a: WatchKey, b: WatchKey): boolean {
  return a.accountId === b.accountId && a.taskId === b.taskId && a.periodStart === b.periodStart;
}

/** Кошелёк с отзывом начисленного: то же правило, что у базы — не больше записи награды и не больше баланса. */
class FakeWallet {
  readonly entries = new Map<string, { accountId: string; resource: WalletResource; amount: number; reason: string }>();
  readonly revokes: RevokeRequest[] = [];
  private readonly balance = new Map<string, number>();
  /** аккаунты, у которых отзыв падает, — сбой одной пары не должен останавливать остальные */
  readonly broken = new Set<string>();

  async grant(input: GrantInput): Promise<GrantResult> {
    const known = this.entries.get(input.idempotencyKey);
    if (known !== undefined) return { credited: known.amount, balance: this.of(input.accountId, input.resource), duplicate: true };
    this.entries.set(input.idempotencyKey, { accountId: input.accountId, resource: input.resource, amount: input.amount, reason: input.reason });
    this.balance.set(key(input.accountId, input.resource), this.of(input.accountId, input.resource) + input.amount);
    return { credited: input.amount, balance: this.of(input.accountId, input.resource), duplicate: false };
  }

  /** Игрок потратил: баланс уменьшается, запись награды остаётся. */
  spend(accountId: string, resource: WalletResource, amount: number): void {
    this.balance.set(key(accountId, resource), Math.max(0, this.of(accountId, resource) - amount));
  }

  of(accountId: string, resource: WalletResource): number {
    return this.balance.get(key(accountId, resource)) ?? 0;
  }

  async revokeUpTo(input: RevokeRequest): Promise<RevokeOutcome> {
    this.revokes.push(input);
    if (this.broken.has(input.accountId)) throw new Error("кошелёк недоступен");
    const reason = input.reason ?? "refund_revoke";
    const grant = this.entries.get(input.grantKey);
    const granted = grant !== undefined && grant.accountId === input.accountId && grant.resource === input.resource ? grant.amount : 0;
    const done = this.entries.get(input.idempotencyKey);
    if (done !== undefined) {
      if (done.accountId !== input.accountId || done.resource !== input.resource || done.reason !== reason) throw new Error("ключ занят другой операцией");
      return { status: "duplicate", revoked: -done.amount, granted };
    }
    if (granted === 0) return { status: "nothing", granted: 0 };
    const take = Math.min(granted, this.of(input.accountId, input.resource));
    if (take === 0) return { status: "nothing", granted };
    this.entries.set(input.idempotencyKey, { accountId: input.accountId, resource: input.resource, amount: -take, reason });
    this.balance.set(key(input.accountId, input.resource), this.of(input.accountId, input.resource) - take);
    return { status: "revoked", revoked: take, granted, balance: this.of(input.accountId, input.resource) };
  }

  /** Сколько строк списания записано (без повторов по ключу). */
  get revokedEntries(): number {
    return [...this.entries.values()].filter((entry) => entry.amount < 0).length;
  }
}

const key = (accountId: string, resource: WalletResource) => `${accountId}|${resource}`;

/** Бот площадки: кто состоит, чем он отвечает вместо ответа и сколько вопросов идёт одновременно. */
class FakeMembership implements ChannelMembership {
  readonly platform = "telegram" as const;
  readonly members = new Set<string>();
  readonly asked: string[] = [];
  failure: Error | null = null;
  hang = false;
  maxInFlight = 0;
  private inFlight = 0;

  async isMember(chat: string, platformUserId: string): Promise<boolean> {
    this.asked.push(platformUserId);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.hang) return await new Promise<boolean>(() => undefined);
      await Promise.resolve();
      if (this.failure !== null) throw this.failure;
      return this.members.has(`${chat}|${platformUserId}`);
    } finally {
      this.inFlight -= 1;
    }
  }
}

function setup(defs: TaskDef[] = [channelDef("sub_daily"), channelDef("sub_other")]) {
  const accounts = new MemoryAccountRepository();
  const watch = new MemoryWatch();
  const wallet = new FakeWallet();
  const membership = new FakeMembership();
  const rolesRepository = new MemoryRolesRepository();
  const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);
  const restrictionRows = new MemoryRestrictionsRepository();
  const restrictions = new RestrictionsService(restrictionRows, accounts, new RolesService(config, rolesRepository, accounts), restrictionsGate(restrictionRows), new RestrictionsHooks());
  const feed = new MemoryNotificationsRepository();
  const catalog = { defs, reads: 0 };
  const tasks = {
    catalog: async () => {
      catalog.reads += 1;
      return catalog.defs.map((def) => ({ ...def }));
    },
  } as unknown as TasksRepository;
  const memberships = new ChannelMemberships([membership]);
  const service = new ChannelWatchService(watch, tasks, accounts, memberships, wallet as unknown as WalletService, restrictions, new NotificationsService(feed));
  return { accounts, watch, wallet, membership, restrictionRows, feed, catalog, service };
}

type Ctx = ReturnType<typeof setup>;

let counter = 0;

async function person(ctx: Ctx, subscribed = true): Promise<AccountRef> {
  counter += 1;
  const platformUserId = String(600_000_000 + counter);
  const account = await ctx.accounts.upsert({ platform: "telegram", platformUserId, displayName: `Игрок ${platformUserId}`, username: null, photoUrl: null }, MON.getTime());
  if (subscribed) ctx.membership.members.add(`${CHAT}|${platformUserId}`);
  return { accountId: account.accountId, platform: account.platform, platformUserId };
}

function unsubscribe(ctx: Ctx, player: AccountRef): void {
  ctx.membership.members.delete(`${CHAT}|${player.platformUserId}`);
}

/** Забор награды так, как его делает `TasksService.claim`: награда кошельком ключом задания и срока, потом окно. */
async function claim(ctx: Ctx, player: AccountRef, def: TaskDef, periodStart: string, when: Date): Promise<boolean> {
  const resources = [
    ["coins", def.coins],
    ["gems", def.gems],
    ["shard_common", def.shards],
  ] as const;
  for (const [resource, amount] of resources) {
    if (amount <= 0) continue;
    await ctx.wallet.grant({ accountId: player.accountId, resource, amount, reason: "task_reward", source: `task:${def.taskId}`, idempotencyKey: `task:${player.accountId}:${def.taskId}:${periodStart}:${resource}`, at: when });
  }
  return await ctx.service.start(player, def, periodStart, when);
}

const unsubscribed = (ctx: Ctx) => ctx.feed.rows.filter((row) => row.kind === "task_unsubscribed");
const standing = (ctx: Ctx, accountId: string, when: Date) =>
  ctx.restrictionRows.rows.filter((row) => row.accountId === accountId && row.kind === "partner_tasks" && row.liftedAt === null && (row.endsAt === null || row.endsAt.getTime() > when.getTime()));
const windowsOf = (ctx: Ctx, accountId: string) => ctx.watch.rows.filter((row) => row.accountId === accountId);

/** Строки лога модуля заданий: уровень и поля — по имени события. */
function capture() {
  const lines: { level: "log" | "warn" | "error"; fields: Record<string, unknown> }[] = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
      try {
        lines.push({ level, fields: JSON.parse(String(message)) as Record<string, unknown> });
      } catch {
        // не JSON-строка модуля — не наша
      }
    });
  }
  return { lines, of: (event: string) => lines.filter((line) => line.fields.event === event) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("правила окна наблюдения", () => {
  it("константы решения Р115 и принятые claude-lead-1 19.10.2026", () => {
    expect(WATCH_MS).toBe(7 * DAY);
    expect(CLOSE_MS).toBe(30 * DAY);
    expect(RECHECK_EVERY_MS).toBe(6 * HOUR);
    expect(GIVE_UP_AFTER_MS).toBe(DAY);
    expect(TICK_MS).toBe(5 * 60_000);
    expect(BATCH).toBe(200);
    expect(ASK_TIMEOUT_MS).toBe(5_000);
  });

  it("окно — семь суток с момента забора", () => {
    expect(watchUntil(MON)).toEqual(at(MON, 7 * DAY));
  });

  it("следующая проверка — через шесть часов, но не позже конца окна и не раньше сейчас", () => {
    const until = watchUntil(MON);
    expect(nextCheckAfter(MON, until)).toEqual(at(MON, 6 * HOUR));
    expect(nextCheckAfter(at(MON, 6 * DAY + 22 * HOUR), until)).toEqual(until);
    expect(nextCheckAfter(at(MON, 7 * DAY - 1), until).getTime()).toBeLessThanOrEqual(until.getTime());
    for (let hours = 0; hours < 7 * 24; hours += 5) expect(nextCheckAfter(at(MON, hours * HOUR), until).getTime()).toBeLessThanOrEqual(until.getTime());
    // окно кончилось, а проверка ещё нужна: не в прошлое
    expect(nextCheckAfter(at(MON, 8 * DAY), until)).toEqual(at(MON, 8 * DAY));
  });

  it("последняя проверка — на исходе окна и позже", () => {
    const until = watchUntil(MON);
    expect(isFinalCheck(at(until, -1), until)).toBe(false);
    expect(isFinalCheck(until, until)).toBe(true);
    expect(isFinalCheck(at(until, HOUR), until)).toBe(true);
  });

  it("отказ от окна — через сутки после его конца", () => {
    const until = watchUntil(MON);
    expect(shouldGiveUp(at(until, DAY - 1), until)).toBe(false);
    expect(shouldGiveUp(at(until, DAY), until)).toBe(true);
  });

  it("задания закрываются со второго события отписки", () => {
    expect(closesPartnerTasks(1)).toBe(false);
    expect(closesPartnerTasks(2)).toBe(true);
    expect(closesPartnerTasks(3)).toBe(true);
  });
});

describe("заведение окна", () => {
  it("награда за подписку заводит окно: забор + 7 суток, первая проверка через 6 часов", async () => {
    const ctx = setup();
    const log = capture();
    const player = await person(ctx);

    expect(await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON)).toBe(true);

    expect(ctx.watch.rows).toEqual([
      {
        accountId: player.accountId,
        taskId: "sub_daily",
        periodStart: "2026-10-05",
        startedAt: MON,
        watchUntil: at(MON, 7 * DAY),
        nextCheckAt: at(MON, 6 * HOUR),
        checkedAt: null,
        state: "watching",
        eventNo: null,
        penalizedAt: null,
        revoked: null,
      },
    ]);
    expect(log.of("channel_watch_started")).toHaveLength(1);
    expect(log.of("channel_watch_started")[0]?.fields).toMatchObject({ module: "tasks", accountId: player.accountId, taskId: "sub_daily", periodStart: "2026-10-05" });
  });

  it("повторный забор той же награды окно не удваивает", async () => {
    const ctx = setup();
    const player = await person(ctx);
    const def = channelDef("sub_daily");

    expect(await claim(ctx, player, def, "2026-10-05", MON)).toBe(true);
    expect(await claim(ctx, player, def, "2026-10-05", at(MON, HOUR))).toBe(false);

    expect(ctx.watch.rows).toHaveLength(1);
    expect(ctx.watch.rows[0]?.startedAt).toEqual(MON);
  });

  it("ежедневная подписка, забранная в разные дни, — по окну на каждую награду", async () => {
    const ctx = setup();
    const player = await person(ctx);
    const def = channelDef("sub_daily");

    await claim(ctx, player, def, "2026-10-05", MON);
    await claim(ctx, player, def, "2026-10-06", at(MON, DAY));

    expect(ctx.watch.rows.map((row) => [row.periodStart, row.watchUntil])).toEqual([
      ["2026-10-05", at(MON, 7 * DAY)],
      ["2026-10-06", at(MON, 8 * DAY)],
    ]);
  });

  it("цель «ссылка» и «бот» окна не заводит: проверить нечем", async () => {
    const ctx = setup();
    const player = await person(ctx);
    const params = { url: "https://example.com/partner" };

    expect(await ctx.service.start(player, channelDef("link_task", { kind: "link", params }), "2026-10-05", MON)).toBe(false);
    expect(await ctx.service.start(player, channelDef("bot_task", { kind: "bot", params }), "2026-10-05", MON)).toBe(false);

    expect(ctx.watch.rows).toEqual([]);
  });

  it("цель забега окна не заводит", async () => {
    const ctx = setup();
    const player = await person(ctx);

    expect(await ctx.service.start(player, channelDef("daily_runs", { kind: "runs", params: null, target: 3 }), "2026-10-05", MON)).toBe(false);

    expect(ctx.watch.rows).toEqual([]);
  });

  it("площадка без проверки подписки (MAX, VK) окна не заводит: штрафа нет", async () => {
    const ctx = setup();
    const player = await person(ctx);
    const max = channelDef("sub_max", { params: { platform: "max", chat: "rubezh", url: "https://max.ru/rubezh" } });

    expect(await ctx.service.start(player, max, "2026-10-05", MON)).toBe(false);

    expect(ctx.watch.rows).toEqual([]);
  });

  it("задание без канала окна не заводит", async () => {
    const ctx = setup();
    const player = await person(ctx);
    const noChat = channelDef("sub_broken", { params: { platform: "telegram", url: "https://t.me/rubezh_news" } });

    expect(await ctx.service.start(player, noChat, "2026-10-05", MON)).toBe(false);

    expect(ctx.watch.rows).toEqual([]);
  });
});

describe("проверка: игрок состоит в канале", () => {
  it("каждые шесть часов окно откладывается; раньше срока площадку не спрашивают", async () => {
    const ctx = setup();
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON);

    await ctx.service.tick(at(MON, 6 * HOUR - 1));
    expect(ctx.membership.asked).toEqual([]);

    await ctx.service.tick(at(MON, 6 * HOUR));
    expect(ctx.watch.rows[0]).toMatchObject({ state: "watching", nextCheckAt: at(MON, 12 * HOUR), checkedAt: at(MON, 6 * HOUR) });

    await ctx.service.tick(at(MON, 12 * HOUR));
    expect(ctx.watch.rows[0]).toMatchObject({ state: "watching", nextCheckAt: at(MON, 18 * HOUR), checkedAt: at(MON, 12 * HOUR) });
    expect(ctx.membership.asked).toHaveLength(2);
  });

  it("проверка на исходе окна закрывает его как `kept`: баланс не менялся, уведомления и ограничения нет", async () => {
    const ctx = setup();
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON);

    for (let hours = 6; hours <= 7 * 24; hours += 6) await ctx.service.tick(at(MON, hours * HOUR));

    expect(ctx.watch.rows[0]).toMatchObject({ state: "kept", checkedAt: at(MON, 7 * DAY) });
    expect(ctx.wallet.of(player.accountId, "coins")).toBe(100);
    expect(ctx.wallet.of(player.accountId, "gems")).toBe(5);
    expect(ctx.wallet.revokes).toEqual([]);
    expect(unsubscribed(ctx)).toEqual([]);
    expect(ctx.restrictionRows.rows).toEqual([]);
  });

  it("проход запоздал — окно всё равно закрывается `kept` при первой же проверке после конца", async () => {
    const ctx = setup();
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON);

    await ctx.service.tick(at(MON, 7 * DAY + 3 * HOUR));

    expect(ctx.watch.rows[0]?.state).toBe("kept");
  });

  it("закрытое окно больше не проверяется", async () => {
    const ctx = setup();
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON);
    await ctx.service.tick(at(MON, 7 * DAY));
    const asked = ctx.membership.asked.length;

    unsubscribe(ctx, player);
    await ctx.service.tick(at(MON, 8 * DAY));

    expect(ctx.membership.asked).toHaveLength(asked);
    expect(ctx.wallet.revokes).toEqual([]);
  });
});

describe("первая отписка", () => {
  it("на третий день награда списана целиком, окно `penalized`, одно уведомление, задания не закрыты", async () => {
    const ctx = setup();
    const log = capture();
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON);
    unsubscribe(ctx, player);
    const now = at(MON, 2 * DAY + 6 * HOUR);

    await ctx.service.tick(now);

    expect(ctx.wallet.of(player.accountId, "coins")).toBe(0);
    expect(ctx.wallet.of(player.accountId, "gems")).toBe(0);
    expect(ctx.watch.rows[0]).toMatchObject({ state: "penalized", eventNo: 1, penalizedAt: now, revoked: { coins: 100, gems: 5, shards: 0 } });
    const [note, ...rest] = unsubscribed(ctx);
    expect(rest).toEqual([]);
    expect(note).toMatchObject({
      accountId: player.accountId,
      kind: "task_unsubscribed",
      payload: { title: "Канал Рубежа", coins: 100, gems: 5, shards: 0, closedUntil: null },
      dedupeKey: `task_unsubscribed:${player.accountId}:sub_daily:1`,
    });
    expect(ctx.restrictionRows.rows).toEqual([]);
    expect(log.of("channel_unsubscribed")[0]?.fields).toMatchObject({ module: "tasks", accountId: player.accountId, taskId: "sub_daily", eventNo: 1, coins: 100, gems: 5, shards: 0, closed: false });
  });

  it("списание идёт ключами: награда задания и срока, свой ключ отзыва, причина `task_revoke`, источник — задание", async () => {
    const ctx = setup([channelDef("sub_daily", { shards: 3 })]);
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_daily", { shards: 3 }), "2026-10-05", MON);
    unsubscribe(ctx, player);
    const now = at(MON, DAY);

    await ctx.service.tick(at(MON, DAY));

    const by = (resource: WalletResource) => ctx.wallet.revokes.find((request) => request.resource === resource);
    for (const resource of ["coins", "gems", "shard_common"] as const) {
      expect(by(resource)).toEqual({
        accountId: player.accountId,
        resource,
        grantKey: `task:${player.accountId}:sub_daily:2026-10-05:${resource}`,
        idempotencyKey: `taskrevoke:${player.accountId}:sub_daily:2026-10-05:${resource}`,
        reason: "task_revoke",
        source: "task:sub_daily",
        at: now,
      });
    }
    expect(ctx.watch.rows[0]?.revoked).toEqual({ coins: 100, gems: 5, shards: 3 });
  });

  it("штраф начисляет сам проход по расписанию: запроса игрока не нужно", async () => {
    const ctx = setup();
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON);
    unsubscribe(ctx, player);

    const result = await ctx.service.tick(at(MON, DAY));

    expect(result).toMatchObject({ pairs: 1, penalized: 1, failed: 0 });
  });
});

describe("не ниже нуля", () => {
  it("на счёте 40 монет из 100 списано 40, баланс 0, не минус; самоцветы — отдельно", async () => {
    const ctx = setup();
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON);
    ctx.wallet.spend(player.accountId, "coins", 60);
    unsubscribe(ctx, player);

    await ctx.service.tick(at(MON, DAY));

    expect(ctx.wallet.of(player.accountId, "coins")).toBe(0);
    expect(ctx.wallet.of(player.accountId, "gems")).toBe(0);
    expect(ctx.watch.rows[0]?.revoked).toEqual({ coins: 40, gems: 5, shards: 0 });
    expect(unsubscribed(ctx)[0]?.payload).toMatchObject({ coins: 40, gems: 5, shards: 0 });
  });

  it("монеты потрачены целиком, а самоцветы целы: списаны только самоцветы", async () => {
    const ctx = setup();
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON);
    ctx.wallet.spend(player.accountId, "coins", 100);
    unsubscribe(ctx, player);

    await ctx.service.tick(at(MON, DAY));

    expect(ctx.wallet.of(player.accountId, "coins")).toBe(0);
    expect(ctx.wallet.of(player.accountId, "gems")).toBe(0);
    expect(ctx.watch.rows[0]?.revoked).toEqual({ coins: 0, gems: 5, shards: 0 });
  });

  it("баланс 0: списано 0, уведомление всё равно приходит («награда уже потрачена»), штраф засчитан", async () => {
    const ctx = setup();
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON);
    ctx.wallet.spend(player.accountId, "coins", 100);
    ctx.wallet.spend(player.accountId, "gems", 5);
    unsubscribe(ctx, player);

    await ctx.service.tick(at(MON, DAY));

    expect(ctx.wallet.of(player.accountId, "coins")).toBe(0);
    expect(ctx.wallet.of(player.accountId, "gems")).toBe(0);
    expect(ctx.wallet.revokedEntries).toBe(0);
    expect(ctx.watch.rows[0]).toMatchObject({ state: "penalized", eventNo: 1, revoked: { coins: 0, gems: 0, shards: 0 } });
    expect(unsubscribed(ctx)).toHaveLength(1);
    expect(unsubscribed(ctx)[0]?.payload).toMatchObject({ coins: 0, gems: 0, shards: 0 });
  });

  it("потраченное не возвращается, а лишнего сверх награды не забирается: на счёте 500 списано ровно 100", async () => {
    const ctx = setup();
    const player = await person(ctx);
    await ctx.wallet.grant({ accountId: player.accountId, resource: "coins", amount: 400, reason: "run_reward", idempotencyKey: "other-income" });
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON);
    unsubscribe(ctx, player);

    await ctx.service.tick(at(MON, DAY));

    expect(ctx.wallet.of(player.accountId, "coins")).toBe(400);
  });
});

describe("одно событие на пару «игрок + задание»", () => {
  it("награды двух дней списаны разом, у обоих окон `event_no: 1`, закрытия нет, уведомление одно", async () => {
    const ctx = setup();
    const player = await person(ctx);
    const def = channelDef("sub_daily");
    await claim(ctx, player, def, "2026-10-05", MON);
    await claim(ctx, player, def, "2026-10-06", at(MON, DAY));
    unsubscribe(ctx, player);
    const wednesday = at(MON, 2 * DAY);

    await ctx.service.tick(wednesday);

    expect(ctx.wallet.of(player.accountId, "coins")).toBe(0);
    expect(ctx.wallet.of(player.accountId, "gems")).toBe(0);
    expect(windowsOf(ctx, player.accountId).map((row) => [row.periodStart, row.state, row.eventNo, row.revoked])).toEqual([
      ["2026-10-05", "penalized", 1, { coins: 100, gems: 5, shards: 0 }],
      ["2026-10-06", "penalized", 1, { coins: 100, gems: 5, shards: 0 }],
    ]);
    expect(ctx.restrictionRows.rows).toEqual([]);
    expect(unsubscribed(ctx)).toHaveLength(1);
    expect(unsubscribed(ctx)[0]?.payload).toMatchObject({ coins: 200, gems: 10, shards: 0, closedUntil: null });
  });

  it("событие охватывает и окна, срок которых ещё не пришёл", async () => {
    const ctx = setup();
    const player = await person(ctx);
    const def = channelDef("sub_daily");
    await claim(ctx, player, def, "2026-10-05", MON);
    // во вторник в 17:00 понедельничное окно проверено («состоит») и отложено до 23:00
    await ctx.service.tick(at(MON, DAY + 5 * HOUR));
    await claim(ctx, player, def, "2026-10-06", at(MON, DAY));
    unsubscribe(ctx, player);
    // во вторник в 19:00 подошло только вторничное окно (его срок — 18:00); понедельничное ждёт до 23:00
    const now = at(MON, DAY + 7 * HOUR);
    const open = windowsOf(ctx, player.accountId);
    expect(open.map((row) => row.state)).toEqual(["watching", "watching"]);
    expect(open.filter((row) => row.nextCheckAt.getTime() <= now.getTime()).map((row) => row.periodStart)).toEqual(["2026-10-06"]);

    await ctx.service.tick(now);

    expect(windowsOf(ctx, player.accountId).map((row) => [row.state, row.eventNo])).toEqual([
      ["penalized", 1],
      ["penalized", 1],
    ]);
    expect(ctx.wallet.of(player.accountId, "coins")).toBe(0);
    expect(unsubscribed(ctx)).toHaveLength(1);
  });
});

describe("повторная отписка в том же задании", () => {
  /** Первая отписка в среду, новая подписка, награда в пятницу, снова отписка в субботу. */
  async function twice(ctx: Ctx, player: AccountRef): Promise<Date> {
    const def = channelDef("sub_daily");
    await claim(ctx, player, def, "2026-10-05", MON);
    unsubscribe(ctx, player);
    await ctx.service.tick(at(MON, 2 * DAY));
    ctx.membership.members.add(`${CHAT}|${player.platformUserId}`);
    await claim(ctx, player, def, "2026-10-09", at(MON, 4 * DAY));
    unsubscribe(ctx, player);
    const saturday = at(MON, 5 * DAY);
    await ctx.service.tick(saturday);
    return saturday;
  }

  it("`event_no: 2`, ограничение `partner_tasks` на 30 суток с причиной `task_unsubscribe`, срок — в уведомлении", async () => {
    const ctx = setup();
    const player = await person(ctx);

    const saturday = await twice(ctx, player);

    expect(windowsOf(ctx, player.accountId).map((row) => [row.periodStart, row.state, row.eventNo])).toEqual([
      ["2026-10-05", "penalized", 1],
      ["2026-10-09", "penalized", 2],
    ]);
    const [restriction, ...rest] = ctx.restrictionRows.rows;
    expect(rest).toEqual([]);
    expect(restriction).toMatchObject({ accountId: player.accountId, kind: "partner_tasks", reason: "task_unsubscribe", startsAt: saturday, endsAt: at(saturday, 30 * DAY), imposedBy: null, notify: true });
    const notes = unsubscribed(ctx);
    expect(notes.map((note) => note.dedupeKey)).toEqual([`task_unsubscribed:${player.accountId}:sub_daily:1`, `task_unsubscribed:${player.accountId}:sub_daily:2`]);
    expect(notes[0]?.payload).toMatchObject({ closedUntil: null });
    expect(notes[1]?.payload).toMatchObject({ coins: 100, gems: 5, closedUntil: at(saturday, 30 * DAY).toISOString() });
  });

  it("у игрока уже бессрочное `partner_tasks` — ограничение не заменено, `closedUntil: null`", async () => {
    const ctx = setup();
    const player = await person(ctx);
    await ctx.restrictionRows.impose([{ accountId: player.accountId, kind: "partner_tasks", startsAt: MON, endsAt: null, reason: "promo_abuse", comment: "решение модератора", notify: true, imposedBy: null }], MON);

    await twice(ctx, player);

    expect(ctx.restrictionRows.rows).toHaveLength(1);
    expect(ctx.restrictionRows.rows[0]).toMatchObject({ endsAt: null, reason: "promo_abuse" });
    expect(unsubscribed(ctx)[1]?.payload).toMatchObject({ closedUntil: null });
  });

  it("повтор после того, как закрытие кончилось, закрывает снова: считается номер события, а не срок", async () => {
    const ctx = setup();
    const player = await person(ctx);
    const def = channelDef("sub_daily");
    await twice(ctx, player);
    // через 40 суток — снова подписался, награда, отписка: третье событие, ограничение накладывается заново
    const later = at(MON, 40 * DAY);
    ctx.membership.members.add(`${CHAT}|${player.platformUserId}`);
    await claim(ctx, player, def, "2026-11-14", later);
    unsubscribe(ctx, player);
    await ctx.service.tick(at(later, DAY));

    expect(windowsOf(ctx, player.accountId).at(-1)).toMatchObject({ eventNo: 3, state: "penalized" });
    expect(standing(ctx, player.accountId, at(later, DAY))).toHaveLength(1);
  });

  it("другое задание — не повтор: нарушение по заданию A после нарушения по заданию B — `event_no: 1`, закрытия нет", async () => {
    const ctx = setup();
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_other"), "2026-10-05", MON);
    unsubscribe(ctx, player);
    await ctx.service.tick(at(MON, DAY));
    ctx.membership.members.add(`${CHAT}|${player.platformUserId}`);
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-07", at(MON, 2 * DAY));
    unsubscribe(ctx, player);

    await ctx.service.tick(at(MON, 3 * DAY));

    expect(windowsOf(ctx, player.accountId).map((row) => [row.taskId, row.eventNo])).toEqual([
      ["sub_other", 1],
      ["sub_daily", 1],
    ]);
    expect(ctx.restrictionRows.rows).toEqual([]);
  });
});

describe("нет ответа площадки — нет штрафа", () => {
  async function unsure(failure: Error | "hang"): Promise<{ ctx: Ctx; player: AccountRef; log: ReturnType<typeof capture> }> {
    const ctx = setup();
    const log = capture();
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON);
    unsubscribe(ctx, player);
    if (failure === "hang") ctx.membership.hang = true;
    else ctx.membership.failure = failure;
    return { ctx, player, log };
  }

  function untouched(ctx: Ctx, player: AccountRef): void {
    expect(ctx.wallet.of(player.accountId, "coins")).toBe(100);
    expect(ctx.wallet.of(player.accountId, "gems")).toBe(5);
    expect(ctx.wallet.revokes).toEqual([]);
    expect(unsubscribed(ctx)).toEqual([]);
    expect(ctx.restrictionRows.rows).toEqual([]);
  }

  it("площадка недоступна: окно откладывается, баланс и ограничения не тронуты, ответ не засчитан", async () => {
    const { ctx, player, log } = await unsure(new MembershipUnavailableError("Telegram не ответил"));
    const now = at(MON, DAY);

    const result = await ctx.service.tick(now);

    expect(ctx.watch.rows[0]).toMatchObject({ state: "watching", nextCheckAt: nextCheckAfter(now, watchUntil(MON)), checkedAt: null });
    expect(ctx.watch.rows[0]?.nextCheckAt.getTime()).toBeGreaterThan(now.getTime());
    expect(result).toMatchObject({ penalized: 0, postponed: 1 });
    untouched(ctx, player);
    expect(log.of("channel_watch_unavailable")).toHaveLength(1);
  });

  it("таймаут вопроса площадке (5 секунд) — то же, что недоступна", async () => {
    vi.useFakeTimers();
    const { ctx, player, log } = await unsure("hang");
    const now = at(MON, DAY);

    const pending = ctx.service.tick(now);
    await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS);
    await pending;

    expect(ctx.watch.rows[0]).toMatchObject({ state: "watching", checkedAt: null });
    expect(ctx.watch.rows[0]?.nextCheckAt.getTime()).toBeGreaterThan(now.getTime());
    untouched(ctx, player);
    expect(log.of("channel_watch_unavailable")).toHaveLength(1);
  });

  it("площадка не может проверить (бота нет в канале, нет права видеть участников): окно откладывается, в лог — error `channel_watch_misconfigured`", async () => {
    const { ctx, player, log } = await unsure(new MembershipRejectedError("бот не администратор"));

    await ctx.service.tick(at(MON, DAY));

    expect(ctx.watch.rows[0]).toMatchObject({ state: "watching", checkedAt: null });
    untouched(ctx, player);
    const [line, ...rest] = log.of("channel_watch_misconfigured");
    expect(rest).toEqual([]);
    expect(line?.level).toBe("error");
    expect(line?.fields).toMatchObject({ taskId: "sub_daily", chat: CHAT });
  });

  it("окно, которому больше суток после конца, закрывается как `expired` — без штрафа", async () => {
    const { ctx, player, log } = await unsure(new MembershipUnavailableError("Telegram не ответил"));
    const until = watchUntil(MON);

    await ctx.service.tick(at(until, DAY - 1));
    expect(ctx.watch.rows[0]?.state).toBe("watching");

    await ctx.service.tick(at(until, DAY));
    expect(ctx.watch.rows[0]?.state).toBe("expired");
    untouched(ctx, player);
    expect(log.of("channel_watch_expired")).toHaveLength(1);
  });

  it("то же при ошибке настройки задания: через сутки после конца окно закрыто", async () => {
    const { ctx, player } = await unsure(new MembershipRejectedError("канала нет"));

    await ctx.service.tick(at(watchUntil(MON), DAY + HOUR));

    expect(ctx.watch.rows[0]?.state).toBe("expired");
    untouched(ctx, player);
  });

  it("неизвестная ошибка порта не считается отпиской: окно ждёт следующей проверки", async () => {
    const { ctx, player } = await unsure(new TypeError("сломанный ответ"));

    const result = await ctx.service.tick(at(MON, DAY));

    expect(ctx.watch.rows[0]?.state).toBe("watching");
    expect(result.failed).toBe(1);
    untouched(ctx, player);
  });
});

describe("идемпотентность и гонки", () => {
  it("проход оборвался после списания, до отметки штрафа: повтор доделывает событие, а не удваивает", async () => {
    const ctx = setup();
    const log = capture();
    const player = await person(ctx);
    const def = channelDef("sub_daily");
    // первое нарушение уже было: оборванное событие — второе, с закрытием заданий
    await claim(ctx, player, def, "2026-10-05", MON);
    unsubscribe(ctx, player);
    await ctx.service.tick(at(MON, DAY));
    ctx.membership.members.add(`${CHAT}|${player.platformUserId}`);
    await claim(ctx, player, def, "2026-10-09", at(MON, 4 * DAY));
    unsubscribe(ctx, player);
    ctx.watch.breakMarkPenalized = 1;

    const first = await ctx.service.tick(at(MON, 5 * DAY));
    expect(first.failed).toBe(1);
    expect(log.of("channel_watch_failed")).toHaveLength(1);
    expect(ctx.watch.rows.at(-1)).toMatchObject({ state: "watching", eventNo: null });

    const second = await ctx.service.tick(at(MON, 5 * DAY + 5 * 60_000));

    expect(second.failed).toBe(0);
    expect(ctx.watch.rows.at(-1)).toMatchObject({ state: "penalized", eventNo: 2, revoked: { coins: 100, gems: 5, shards: 0 } });
    // списано один раз: по записи на ресурс у каждой из двух наград
    expect(ctx.wallet.revokedEntries).toBe(4);
    expect(ctx.wallet.of(player.accountId, "coins")).toBe(0);
    expect(unsubscribed(ctx).map((note) => note.dedupeKey)).toEqual([`task_unsubscribed:${player.accountId}:sub_daily:1`, `task_unsubscribed:${player.accountId}:sub_daily:2`]);
    expect(standing(ctx, player.accountId, at(MON, 6 * DAY))).toHaveLength(1);
  });

  it("два одновременных прохода по одной паре: списание, уведомление и ограничение — по одному", async () => {
    const ctx = setup();
    const player = await person(ctx);
    const def = channelDef("sub_daily");
    await claim(ctx, player, def, "2026-10-05", MON);
    unsubscribe(ctx, player);
    await ctx.service.tick(at(MON, DAY));
    ctx.membership.members.add(`${CHAT}|${player.platformUserId}`);
    await claim(ctx, player, def, "2026-10-09", at(MON, 4 * DAY));
    unsubscribe(ctx, player);
    const now = at(MON, 5 * DAY);

    await Promise.all([ctx.service.tick(now), ctx.service.tick(now)]);

    expect(ctx.wallet.revokedEntries).toBe(4);
    expect(unsubscribed(ctx)).toHaveLength(2);
    expect(ctx.restrictionRows.rows).toHaveLength(1);
    expect(windowsOf(ctx, player.accountId).map((row) => row.eventNo)).toEqual([1, 2]);
  });

  it("повторный проход по уже оштрафованной паре ничего не списывает", async () => {
    const ctx = setup();
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON);
    unsubscribe(ctx, player);
    await ctx.service.tick(at(MON, DAY));
    const revokes = ctx.wallet.revokes.length;

    await ctx.service.tick(at(MON, 2 * DAY));

    expect(ctx.wallet.revokes).toHaveLength(revokes);
    expect(unsubscribed(ctx)).toHaveLength(1);
  });
});

describe("разное", () => {
  it("аккаунта нет — окно закрыто как `expired`, в лог `channel_watch_orphaned`", async () => {
    const ctx = setup();
    const log = capture();
    const ghost = "00000000-0000-4000-8000-0000000000aa";
    await ctx.watch.start({ accountId: ghost, taskId: "sub_daily", periodStart: "2026-10-05", startedAt: MON, watchUntil: watchUntil(MON), nextCheckAt: at(MON, 6 * HOUR) });

    await ctx.service.tick(at(MON, DAY));

    expect(ctx.watch.rows[0]?.state).toBe("expired");
    expect(ctx.membership.asked).toEqual([]);
    expect(log.of("channel_watch_orphaned")).toHaveLength(1);
  });

  it("у задания пропал канал или самого задания нет в каталоге — окна закрыты как `expired`, площадку не спрашивали", async () => {
    const ctx = setup([channelDef("sub_daily", { params: { platform: "telegram", url: "https://t.me/rubezh_news" } })]);
    const log = capture();
    const player = await person(ctx);
    await ctx.watch.start({ accountId: player.accountId, taskId: "sub_daily", periodStart: "2026-10-05", startedAt: MON, watchUntil: watchUntil(MON), nextCheckAt: at(MON, 6 * HOUR) });
    await ctx.watch.start({ accountId: player.accountId, taskId: "deleted_task", periodStart: "2026-10-05", startedAt: MON, watchUntil: watchUntil(MON), nextCheckAt: at(MON, 6 * HOUR) });

    await ctx.service.tick(at(MON, DAY));

    expect(windowsOf(ctx, player.accountId).map((row) => row.state)).toEqual(["expired", "expired"]);
    expect(ctx.membership.asked).toEqual([]);
    expect(log.of("channel_watch_orphaned")).toHaveLength(2);
  });

  it("выключенное в панели задание проверяется по-прежнему: награда уже выдана", async () => {
    const ctx = setup([channelDef("sub_daily", { active: false })]);
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON);
    unsubscribe(ctx, player);

    await ctx.service.tick(at(MON, DAY));

    expect(ctx.watch.rows[0]?.state).toBe("penalized");
  });

  it("сбой на одной паре пишется в лог и не мешает обработать следующую", async () => {
    const ctx = setup();
    const log = capture();
    const broken = await person(ctx);
    const fine = await person(ctx);
    await claim(ctx, broken, channelDef("sub_daily"), "2026-10-05", MON);
    await claim(ctx, fine, channelDef("sub_daily"), "2026-10-05", at(MON, 1));
    unsubscribe(ctx, broken);
    unsubscribe(ctx, fine);
    ctx.wallet.broken.add(broken.accountId);

    const result = await ctx.service.tick(at(MON, DAY));

    expect(result).toMatchObject({ pairs: 2, penalized: 1, failed: 1 });
    expect(windowsOf(ctx, broken.accountId)[0]?.state).toBe("watching");
    expect(windowsOf(ctx, fine.accountId)[0]?.state).toBe("penalized");
    expect(ctx.wallet.of(fine.accountId, "coins")).toBe(0);
    const [line] = log.of("channel_watch_failed");
    expect(line?.level).toBe("error");
    expect(line?.fields).toMatchObject({ accountId: broken.accountId, taskId: "sub_daily", reason: "кошелёк недоступен" });
  });

  it("за проход берётся не больше BATCH окон; остальные — на следующем", async () => {
    const ctx = setup();
    for (let index = 0; index < BATCH + 50; index += 1) {
      const player = await person(ctx);
      await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", at(MON, index));
    }
    const now = at(MON, DAY);

    const first = await ctx.service.tick(now);

    expect(ctx.watch.dueLimits).toEqual([BATCH]);
    expect(first.windows).toBe(BATCH);
    expect(ctx.membership.asked).toHaveLength(BATCH);

    const second = await ctx.service.tick(now);
    expect(second.windows).toBe(50);
    expect(ctx.membership.asked).toHaveLength(BATCH + 50);
  });

  it("площадку спрашивают по одному вопросу за раз", async () => {
    const ctx = setup();
    for (let index = 0; index < 8; index += 1) {
      const player = await person(ctx);
      await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", at(MON, index));
    }

    await ctx.service.tick(at(MON, DAY));

    expect(ctx.membership.asked).toHaveLength(8);
    expect(ctx.membership.maxInFlight).toBe(1);
  });

  it("одна пара — один вопрос площадке, сколько бы окон у неё ни было; каталог читается один раз за проход", async () => {
    const ctx = setup();
    const player = await person(ctx);
    const other = await person(ctx);
    const def = channelDef("sub_daily");
    await claim(ctx, player, def, "2026-10-05", MON);
    await claim(ctx, player, def, "2026-10-06", at(MON, 1));
    await claim(ctx, other, def, "2026-10-05", at(MON, 2));

    await ctx.service.tick(at(MON, DAY));

    expect(ctx.membership.asked).toHaveLength(2);
    expect(ctx.catalog.reads).toBe(1);
  });

  it("нечего проверять — ничего не спрашивают и не пишут", async () => {
    const ctx = setup();

    const result = await ctx.service.tick(at(MON, DAY));

    expect(result).toMatchObject({ windows: 0, pairs: 0, penalized: 0, failed: 0 });
    expect(ctx.membership.asked).toEqual([]);
  });
});

describe("границы события отписки", () => {
  it("окно, заведённое после начала прохода, ответа площадки не слышало: его очередь — следующий проход, и это уже второе событие", async () => {
    const ctx = setup();
    const player = await person(ctx);
    const def = channelDef("sub_daily");
    await claim(ctx, player, def, "2026-10-05", MON);
    // награда за вторник забрана уже после того, как проход начался
    const now = at(MON, DAY + 7 * HOUR);
    await claim(ctx, player, def, "2026-10-06", at(now, HOUR));
    unsubscribe(ctx, player);

    await ctx.service.tick(now);
    expect(windowsOf(ctx, player.accountId).map((row) => [row.periodStart, row.state, row.eventNo])).toEqual([
      ["2026-10-05", "penalized", 1],
      ["2026-10-06", "watching", null],
    ]);
    expect(ctx.restrictionRows.rows).toEqual([]);

    await ctx.service.tick(at(now, 8 * HOUR));
    expect(windowsOf(ctx, player.accountId).map((row) => row.eventNo)).toEqual([1, 2]);
    expect(standing(ctx, player.accountId, at(now, 8 * HOUR))).toHaveLength(1);
  });

  it("пару уже ведёт другой проход: она пропускается без записи и подбирается следующим", async () => {
    const ctx = setup();
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON);
    unsubscribe(ctx, player);
    const now = at(MON, DAY);

    const held = await ctx.watch.withPairLock(player.accountId, "sub_daily", async () => await ctx.service.tick(now));

    expect(held).toMatchObject({ locked: true, value: { penalized: 0, busy: 1, failed: 0 } });
    expect(ctx.watch.rows[0]?.state).toBe("watching");
    expect(ctx.wallet.revokes).toEqual([]);
    expect(unsubscribed(ctx)).toEqual([]);

    expect(await ctx.service.tick(at(now, TICK_MS))).toMatchObject({ penalized: 1, busy: 0 });
    expect(ctx.watch.rows[0]?.state).toBe("penalized");
  });

  it("правка награды задания после забора не оставляет начисленное: отзывается то, что записано в кошельке", async () => {
    const ctx = setup();
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON);
    ctx.catalog.defs = [channelDef("sub_daily", { coins: 0, gems: 0 })];
    unsubscribe(ctx, player);

    await ctx.service.tick(at(MON, DAY));

    expect(ctx.wallet.of(player.accountId, "coins")).toBe(0);
    expect(ctx.wallet.of(player.accountId, "gems")).toBe(0);
    expect(ctx.watch.rows[0]?.revoked).toEqual({ coins: 100, gems: 5, shards: 0 });
  });

  it("задание без названия: в уведомлении `title: null`, текст по виду цели собирает клиент", async () => {
    const ctx = setup([channelDef("sub_daily", { title: null })]);
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON);
    unsubscribe(ctx, player);

    await ctx.service.tick(at(MON, DAY));

    expect(unsubscribed(ctx)[0]?.payload).toMatchObject({ title: null, coins: 100, gems: 5 });
  });

  it("уведомление не по схеме штраф не подвешивает: списание и отметка стоят, в лог — `channel_watch_notice_rejected`", async () => {
    const ctx = setup([channelDef("sub_daily", { title: "я".repeat(130) })]);
    const log = capture();
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON);
    unsubscribe(ctx, player);

    const result = await ctx.service.tick(at(MON, DAY));

    expect(result).toMatchObject({ penalized: 1, failed: 0 });
    expect(ctx.watch.rows[0]?.state).toBe("penalized");
    expect(ctx.wallet.of(player.accountId, "coins")).toBe(0);
    expect(unsubscribed(ctx)).toEqual([]);
    expect(log.of("channel_watch_notice_rejected")).toHaveLength(1);
  });

  it("сбой ленты — не штраф: проход падает на паре, повтор доделывает событие и уведомление одно", async () => {
    const ctx = setup();
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON);
    unsubscribe(ctx, player);
    const insert = vi.spyOn(ctx.feed, "insert").mockRejectedValueOnce(new Error("лента недоступна"));

    const first = await ctx.service.tick(at(MON, DAY));
    expect(first.failed).toBe(1);
    expect(ctx.watch.rows[0]?.state).toBe("watching");

    const second = await ctx.service.tick(at(MON, DAY + TICK_MS));
    expect(second).toMatchObject({ penalized: 1, failed: 0 });
    expect(insert).toHaveBeenCalledTimes(2);
    expect(unsubscribed(ctx)).toHaveLength(1);
    expect(ctx.wallet.revokedEntries).toBe(2);
  });
});

describe("площадка пропала или ответила поздно", () => {
  it("у площадки задания больше нет проверки: это не «не состоит» — окно ждёт и сдаётся по сроку, площадку не спрашивали", async () => {
    const ctx = setup();
    const log = capture();
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON);
    ctx.catalog.defs = [channelDef("sub_daily", { params: { platform: "max", chat: "rubezh", url: "https://max.ru/rubezh" } })];
    unsubscribe(ctx, player);

    const first = await ctx.service.tick(at(MON, DAY));
    expect(first).toMatchObject({ penalized: 0, postponed: 1 });
    expect(ctx.membership.asked).toEqual([]);
    expect(log.of("channel_watch_unavailable")).toHaveLength(1);

    await ctx.service.tick(at(watchUntil(MON), DAY));
    expect(ctx.watch.rows[0]?.state).toBe("expired");
    expect(ctx.wallet.revokes).toEqual([]);
  });

  it("сбой, пришедший после таймаута, второй строкой в лог не идёт и окно не штрафует", async () => {
    vi.useFakeTimers();
    const ctx = setup();
    const log = capture();
    const player = await person(ctx);
    await claim(ctx, player, channelDef("sub_daily"), "2026-10-05", MON);
    let fail: () => void = () => undefined;
    vi.spyOn(ctx.membership, "isMember").mockImplementation(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          fail = () => reject(new TypeError("поздний сбой"));
        }),
    );

    const pending = ctx.service.tick(at(MON, DAY));
    await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS);
    await pending;
    fail();
    await vi.advanceTimersByTimeAsync(0);

    expect(log.of("channel_watch_unavailable")).toHaveLength(1);
    expect(log.of("channel_watch_failed")).toEqual([]);
    expect(ctx.watch.rows[0]?.state).toBe("watching");
    expect(ctx.wallet.revokes).toEqual([]);
  });
});
