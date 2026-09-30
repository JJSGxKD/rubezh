import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { AdminChangelogController } from "../src/modules/admin/admin-changelog.controller.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { ChangelogFanout } from "../src/modules/changelog/changelog-fanout.js";
import {
  FANOUT_BATCH,
  FANOUT_MAX_BATCHES,
  compareVersions,
  freshVersions,
  pageOf,
  parseVersion,
  releasePlatforms,
  type PublishedEntry,
} from "../src/modules/changelog/changelog-rules.js";
import { ChangelogController } from "../src/modules/changelog/changelog.controller.js";
import { CHANGELOG_REPOSITORY } from "../src/modules/changelog/changelog.repository.js";
import { ChangelogService } from "../src/modules/changelog/changelog.service.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { PLATFORM_IDS, type PlatformId } from "../src/platforms/ports/platform.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryChangelogRepository } from "./helpers/memory-changelog.js";
import { memoryNotifications, type MemoryNotificationsRepository } from "./helpers/memory-notifications.js";
import { MemoryPanelLoginStore } from "./helpers/memory-panel-login.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Журнал обновлений (docs/35-stage4-plan.md Р61, WP31): игрок видит строки
 * своей площадки по версиям, версия без строк для площадки не показывается,
 * публикация версии — одно уведомление каждому, повтор публикации его не
 * дублирует.
 */

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);

let sequence = 0;
function entry(version: string, patch: Partial<PublishedEntry> = {}): PublishedEntry {
  sequence++;
  return { entryId: `e-${String(sequence).padStart(3, "0")}`, version, platforms: [], kind: "added", text: `строка ${String(sequence)}`, publishedAt: new Date(T0), createdAt: new Date(T0 + sequence), ...patch };
}

describe("правила журнала", () => {
  it("игрок Telegram не видит строку только для VK, а версия без строк площадки не показывается", () => {
    const entries = [entry("0.6.0", { platforms: ["vk"], text: "только VK" }), entry("0.6.0", { text: "всем" }), entry("0.7.0", { platforms: ["vk"] })];
    const telegram = pageOf(entries, "telegram", { cursor: null, limit: 10, seenAt: new Date(0) });
    expect(telegram.versions.map((version) => version.version)).toEqual(["0.6.0"]);
    expect(telegram.versions[0]?.entries.map((line) => line.text)).toEqual(["всем"]);
    const vk = pageOf(entries, "vk", { cursor: null, limit: 10, seenAt: new Date(0) });
    expect(vk.versions.map((version) => version.version)).toEqual(["0.7.0", "0.6.0"]);
    expect(pageOf([], "max", { cursor: null, limit: 10, seenAt: new Date(0) })).toEqual({ versions: [], nextCursor: null, latestAt: null });
  });

  it("версии — по числам, а не строкой: 0.10.0 новее 0.9.0; внутри — новое, изменено, исправлено", () => {
    const entries = [entry("0.9.0"), entry("0.10.0", { kind: "fixed", text: "исправили" }), entry("0.10.0", { kind: "added", text: "добавили" }), entry("0.10.0", { kind: "changed", text: "поменяли" }), entry("1.0.0")];
    const page = pageOf(entries, "telegram", { cursor: null, limit: 10, seenAt: new Date(0) });
    expect(page.versions.map((version) => version.version)).toEqual(["1.0.0", "0.10.0", "0.9.0"]);
    expect(page.versions[1]?.entries.map((line) => line.kind)).toEqual(["added", "changed", "fixed"]);
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("курсор — версия: страницы не теряют и не повторяют версий, вышедшая посреди листания их не сдвигает", () => {
    const entries = ["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0"].map((version) => entry(version));
    const first = pageOf(entries, "telegram", { cursor: null, limit: 2, seenAt: new Date(0) });
    expect(first.versions.map((version) => version.version)).toEqual(["0.5.0", "0.4.0"]);
    expect(first.nextCursor).toBe("0.4.0");

    const later = [...entries, entry("0.6.0", { publishedAt: new Date(T0 + DAY) })];
    const second = pageOf(later, "telegram", { cursor: first.nextCursor, limit: 2, seenAt: new Date(0) });
    expect(second.versions.map((version) => version.version)).toEqual(["0.3.0", "0.2.0"]);
    const third = pageOf(later, "telegram", { cursor: second.nextCursor, limit: 2, seenAt: new Date(0) });
    expect(third.versions.map((version) => version.version)).toEqual(["0.1.0"]);
    expect(third.nextCursor).toBeNull();
  });

  it("новое — то, что опубликовано после того, как игрок открывал журнал; знак — числом таких версий", () => {
    const seenAt = new Date(T0 + DAY);
    const entries = [
      entry("0.5.0", { publishedAt: new Date(T0) }),
      entry("0.6.0", { publishedAt: new Date(T0 + 2 * DAY) }),
      // В старую версию дописали строку позже — версия снова новая.
      entry("0.4.0", { publishedAt: new Date(T0 - DAY) }),
      entry("0.4.0", { publishedAt: new Date(T0 + 3 * DAY) }),
      entry("0.3.0", { platforms: ["vk"], publishedAt: new Date(T0 + 4 * DAY) }),
    ];
    const page = pageOf(entries, "telegram", { cursor: null, limit: 10, seenAt });
    expect(page.versions.map((version) => [version.version, version.fresh])).toEqual([
      ["0.6.0", true],
      ["0.5.0", false],
      ["0.4.0", true],
    ]);
    expect(page.versions[2]?.publishedAt).toBe(new Date(T0 - DAY).toISOString());
    expect(page.latestAt).toBe(new Date(T0 + 3 * DAY).toISOString());
    expect(freshVersions(entries, "telegram", seenAt)).toBe(2);
    expect(freshVersions(entries, "telegram", new Date(T0 + 3 * DAY))).toBe(0);
    expect(freshVersions(entries, "vk", new Date(T0 + 3 * DAY))).toBe(1);
  });

  it("раздача — площадкам строк версии; строка без площадок — всем", () => {
    expect(releasePlatforms([{ platforms: ["vk"] }, { platforms: ["telegram", "vk"] }], PLATFORM_IDS)).toEqual(["telegram", "vk"]);
    expect(releasePlatforms([{ platforms: ["vk"] }, { platforms: [] }], PLATFORM_IDS)).toEqual([...PLATFORM_IDS]);
  });

  it("версия — X.Y.Z без предрелиза и ведущих нулей", () => {
    expect(parseVersion("0.10.2")).toEqual({ major: 0, minor: 10, patch: 2 });
    for (const bad of ["0.06.0", "1.2", "1.2.3-rc.1", "v1.2.3", "1.2.3 ", "12345.0.0", ""]) expect(parseVersion(bad), bad).toBeNull();
  });
});

const OWNER_ID = "777000111";
const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);

interface Setup {
  accounts: MemoryAccountRepository;
  roles: MemoryRolesRepository;
  repository: MemoryChangelogRepository;
  notifications: MemoryNotificationsRepository;
  fanout: ChangelogFanout;
  service: ChangelogService;
  locks: Map<string, string>;
}

function setup(): Setup {
  const accounts = new MemoryAccountRepository();
  const roles = new MemoryRolesRepository();
  const repository = new MemoryChangelogRepository();
  const { service: notificationsService, repository: notifications } = memoryNotifications();
  const locks = new Map<string, string>();
  const redis = {
    set: async (key: string, value: string) => (locks.has(key) ? null : (locks.set(key, value), "OK")),
    eval: async (_script: string, _keys: number, key: string) => (locks.delete(key) ? 1 : 0),
  } as unknown as Redis;
  const fanout = new ChangelogFanout(config(), repository, accounts, notificationsService, redis);
  const service = new ChangelogService(repository, accounts, new RolesService(config(), roles, accounts), fanout);
  return { accounts, roles, repository, notifications, fanout, service, locks };
}

async function player(s: Setup, platform: PlatformId, id: string, createdAt = T0 - 30 * DAY): Promise<AccountRef> {
  const account = await s.accounts.upsert({ platform, platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, createdAt);
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

async function withRole(s: Setup, id: string, role: "game_designer" | "admin" | "moderator"): Promise<AccountRef> {
  const actor = await player(s, "telegram", id);
  await s.roles.grant(actor.accountId, role, null);
  return actor;
}

describe("журнал в сервисе", () => {
  let s: Setup;
  let owner: AccountRef;

  beforeEach(async () => {
    s = setup();
    owner = await player(s, "telegram", OWNER_ID);
  });

  it("черновик игрок не видит; после публикации видит сразу — кеш реплики сброшен", async () => {
    const me = await player(s, "telegram", "1");
    await s.service.save(owner, { version: "0.6.0", kind: "added", platforms: [], text: "Журнал обновлений" }, new Date(T0));
    expect((await s.service.page(me, null, 5, new Date(T0))).versions).toEqual([]);

    const result = await s.service.publish(owner, "0.6.0", new Date(T0 + 1_000));
    expect(result.published).toBe(1);
    expect(result.release).toMatchObject({ version: "0.6.0", platforms: [...PLATFORM_IDS], doneAt: null });
    const page = await s.service.page(me, null, 5, new Date(T0 + 2_000));
    expect(page.versions.map((version) => [version.version, version.fresh])).toEqual([["0.6.0", true]]);
  });

  it("повтор публикации без новых черновиков раздачу не трогает; версия без черновиков и раздачи — ошибка", async () => {
    await s.service.save(owner, { version: "0.6.0", kind: "added", platforms: ["telegram"], text: "Новое" }, new Date(T0));
    await s.service.publish(owner, "0.6.0", new Date(T0));
    await s.repository.advanceRelease("0.6.0", new Date(T0), null, new Date(T0 + 1));

    const again = await s.service.publish(owner, "0.6.0", new Date(T0 + DAY));
    expect(again.published).toBe(0);
    expect(again.release?.doneAt).toEqual(new Date(T0 + 1));
    await expect(s.service.publish(owner, "0.7.0")).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("новая строка в опубликованной версии начинает раздачу заново — и с новыми площадками", async () => {
    await s.service.save(owner, { version: "0.6.0", kind: "added", platforms: ["telegram"], text: "Для Telegram" }, new Date(T0));
    await s.service.publish(owner, "0.6.0", new Date(T0));
    await s.service.save(owner, { version: "0.6.0", kind: "fixed", platforms: ["vk"], text: "Для VK" }, new Date(T0 + DAY));
    const result = await s.service.publish(owner, "0.6.0", new Date(T0 + DAY));
    expect(result.published).toBe(1);
    expect(result.release).toMatchObject({ platforms: ["telegram", "vk"], publishedAt: new Date(T0 + DAY), cursor: null, doneAt: null });
  });

  it("у опубликованной строки меняются только текст и вид", async () => {
    const line = await s.service.save(owner, { version: "0.6.0", kind: "added", platforms: ["telegram"], text: "Было" });
    await s.service.publish(owner, "0.6.0");
    const edited = await s.service.save(owner, { entryId: line.entryId, version: "0.6.0", kind: "changed", platforms: ["telegram"], text: "Стало" });
    expect(edited).toMatchObject({ kind: "changed", text: "Стало" });
    await expect(s.service.save(owner, { entryId: line.entryId, version: "0.6.1", kind: "changed", platforms: ["telegram"], text: "Стало" })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(s.service.save(owner, { entryId: line.entryId, version: "0.6.0", kind: "changed", platforms: ["telegram", "vk"], text: "Стало" })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(s.service.save(owner, { entryId: randomUUID(), version: "0.6.0", kind: "added", platforms: [], text: "Нет такой" })).rejects.toMatchObject({ code: "changelog_entry_not_found" });
  });

  it("права: геймдизайнер пишет, но не публикует; модератор не видит журнал вовсе; всё — в аудит", async () => {
    const designer = await withRole(s, "501", "game_designer");
    const moderator = await withRole(s, "502", "moderator");
    const line = await s.service.save(designer, { version: "0.6.0", kind: "added", platforms: [], text: "Строка" });
    await expect(s.service.publish(designer, "0.6.0")).rejects.toMatchObject({ code: "forbidden" });
    await expect(s.service.list(moderator)).rejects.toMatchObject({ code: "forbidden" });
    await expect(s.service.save(moderator, { version: "0.6.0", kind: "added", platforms: [], text: "x" })).rejects.toMatchObject({ code: "forbidden" });

    const admin = await withRole(s, "503", "admin");
    await s.service.publish(admin, "0.6.0");
    await s.service.save(admin, { entryId: line.entryId, version: "0.6.0", kind: "fixed", platforms: [], text: "Правка" });
    expect(await s.service.remove(admin, line.entryId)).toEqual({ removed: true });
    expect(await s.service.remove(admin, line.entryId)).toEqual({ removed: false });
    const audit = await s.roles.recentAudit(10);
    expect(audit.map((row) => row.action).sort()).toEqual(["changelog.create", "changelog.publish", "changelog.remove", "changelog.update"]);
  });

  it("знак: новичку история игры — не новость; открыл журнал — ноль; вышла версия — снова один", async () => {
    await s.service.save(owner, { version: "0.5.0", kind: "added", platforms: [], text: "Старое" });
    await s.service.publish(owner, "0.5.0", new Date(T0));
    const veteran = await player(s, "telegram", "10", T0 - DAY);
    const newcomer = await player(s, "telegram", "11", T0 + DAY);
    expect(await s.service.badge(veteran, new Date(T0 + 2 * DAY))).toBe(1);
    expect(await s.service.badge(newcomer, new Date(T0 + 2 * DAY))).toBe(0);

    const page = await s.service.page(veteran, null, 5, new Date(T0 + 2 * DAY));
    await s.service.markSeen(veteran.accountId, new Date(page.latestAt ?? 0), new Date(T0 + 2 * DAY));
    expect(await s.service.badge(veteran, new Date(T0 + 2 * DAY))).toBe(0);

    await s.service.save(owner, { version: "0.6.0", kind: "added", platforms: ["vk"], text: "Только VK" });
    await s.service.publish(owner, "0.6.0", new Date(T0 + 3 * DAY));
    expect(await s.service.badge(veteran, new Date(T0 + 3 * DAY))).toBe(0);
    await s.service.save(owner, { version: "0.6.0", kind: "added", platforms: [], text: "Всем" });
    await s.service.publish(owner, "0.6.0", new Date(T0 + 4 * DAY));
    expect(await s.service.badge(veteran, new Date(T0 + 4 * DAY))).toBe(1);
  });

  it("отметка «открывал» не уходит в будущее и не откатывается старой вкладкой", async () => {
    const me = await player(s, "telegram", "12");
    await s.service.markSeen(me.accountId, new Date(T0 + 10 * DAY), new Date(T0));
    expect(s.repository.seen.get(me.accountId)).toEqual(new Date(T0));
    await s.service.markSeen(me.accountId, new Date(T0 - DAY), new Date(T0 + DAY));
    expect(s.repository.seen.get(me.accountId)).toEqual(new Date(T0));
  });

  it("опубликованное читается из базы раз в полминуты, а не на каждый знак", async () => {
    const me = await player(s, "telegram", "13");
    await s.service.badge(me, new Date(T0));
    await s.service.badge(me, new Date(T0 + 10_000));
    await s.service.badge(me, new Date(T0 + 20_000));
    expect(s.repository.publishedReads).toBe(1);
    await s.service.badge(me, new Date(T0 + 40_000));
    expect(s.repository.publishedReads).toBe(2);
  });
});

describe("раздача уведомления о версии", () => {
  let s: Setup;
  let owner: AccountRef;

  beforeEach(async () => {
    s = setup();
    owner = await player(s, "telegram", OWNER_ID);
  });

  it("каждому игроку площадок версии — одно уведомление; чужая площадка и заблокированный — мимо", async () => {
    const telegram = await player(s, "telegram", "1");
    const vk = await player(s, "vk", "2");
    const banned = await player(s, "telegram", "3");
    s.accounts.ban(banned.accountId, "читер");
    await s.service.save(owner, { version: "0.6.0", kind: "added", platforms: ["telegram"], text: "Новое" });
    await s.service.publish(owner, "0.6.0", new Date(T0));

    expect(await s.fanout.tick(new Date(T0))).toBe(2);
    expect(s.notifications.of(telegram.accountId)).toEqual([{ kind: "app_update", payload: { version: "0.6.0" } }]);
    expect(s.notifications.of(vk.accountId)).toEqual([]);
    expect(s.notifications.of(banned.accountId)).toEqual([]);
    expect((await s.repository.releases())[0]?.doneAt).toEqual(new Date(T0));
    expect(await s.fanout.tick(new Date(T0 + 1))).toBe(0);
  });

  it("повтор публикации с новой строкой раздаёт заново — без второго уведомления тем, кто его получил", async () => {
    const telegram = await player(s, "telegram", "1");
    const vk = await player(s, "vk", "2");
    await s.service.save(owner, { version: "0.6.0", kind: "added", platforms: ["telegram"], text: "Новое" });
    await s.service.publish(owner, "0.6.0", new Date(T0));
    await s.fanout.tick(new Date(T0));

    await s.service.save(owner, { version: "0.6.0", kind: "fixed", platforms: ["vk"], text: "Поправили" });
    await s.service.publish(owner, "0.6.0", new Date(T0 + DAY));
    expect(await s.fanout.tick(new Date(T0 + DAY))).toBe(1);
    expect(s.notifications.of(telegram.accountId)).toHaveLength(1);
    expect(s.notifications.of(vk.accountId)).toHaveLength(1);
  });

  it("пачками: за проход — не больше потолка, следующий продолжает с курсора", async () => {
    const ids = Array.from({ length: FANOUT_BATCH * FANOUT_MAX_BATCHES + 7 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    const pages: (string | null)[] = [];
    const accounts = {
      recipientsPage: async (page: { after: string | null; limit: number }) => {
        pages.push(page.after);
        const start = page.after === null ? 0 : ids.indexOf(page.after) + 1;
        return ids.slice(start, start + page.limit);
      },
    };
    let written = 0;
    const notifications = { deliverMany: async (input: { accountIds: readonly string[] }) => ((written += input.accountIds.length), input.accountIds.length) };
    const redis = { set: async () => "OK", eval: async () => 1 } as unknown as Redis;
    const fanout = new ChangelogFanout(config(), s.repository, accounts as never, notifications as never, redis);
    await s.repository.startRelease("0.6.0", ["telegram"], new Date(T0));

    expect(await fanout.tick(new Date(T0))).toBe(FANOUT_BATCH * FANOUT_MAX_BATCHES);
    expect((await s.repository.releases())[0]).toMatchObject({ cursor: ids[FANOUT_BATCH * FANOUT_MAX_BATCHES - 1], doneAt: null });
    expect(await fanout.tick(new Date(T0 + 60_000))).toBe(7);
    expect((await s.repository.releases())[0]?.doneAt).toEqual(new Date(T0 + 60_000));
    expect(written).toBe(ids.length);
    expect(new Set(pages).size).toBe(pages.length);
  });

  it("публикация посреди прохода: старый проход курсор нового поколения не переписывает", async () => {
    await player(s, "telegram", "1");
    await s.service.save(owner, { version: "0.6.0", kind: "added", platforms: ["telegram"], text: "Новое" });
    await s.service.publish(owner, "0.6.0", new Date(T0));
    const original = s.repository.advanceRelease.bind(s.repository);
    s.repository.advanceRelease = async (...args) => {
      await s.repository.startRelease("0.6.0", ["telegram", "vk"], new Date(T0 + 5));
      return await original(...args);
    };

    await s.fanout.tick(new Date(T0));
    expect((await s.repository.releases())[0]).toMatchObject({ publishedAt: new Date(T0 + 5), cursor: null, doneAt: null });
  });

  it("лок у другой реплики — проход не идёт; сбой базы — не бросает", async () => {
    await s.repository.startRelease("0.6.0", ["telegram"], new Date(T0));
    s.locks.set("changelog:fanout:lock", "чужой");
    expect(await s.fanout.tick(new Date(T0))).toBeNull();
    s.locks.clear();
    s.repository.pendingReleases = async () => Promise.reject(new Error("база недоступна"));
    expect(await s.fanout.tick(new Date(T0))).toBeNull();
    expect(s.locks.size).toBe(0);
  });
});

describe("журнал по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(s: Setup, store = new MemoryAdminSessionStore()): Promise<NestFastifyApplication> {
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    @Module({
      controllers: [ChangelogController, AdminSessionController, AdminChangelogController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ACCOUNT_REPOSITORY, useValue: s.accounts },
        { provide: ROLES_REPOSITORY, useValue: s.roles },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: CHANGELOG_REPOSITORY, useValue: s.repository },
        { provide: AppLinks, useValue: new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]) },
        { provide: ChangelogFanout, useValue: s.fanout },
        ChangelogService,
        PanelLoginService,
        RateLimiter,
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
    return app;
  }

  it("игрок: без токена — 401, мусорный курсор — 400, журнал своей площадки и отметка «открывал»", async () => {
    const s = setup();
    const owner = await player(s, "telegram", OWNER_ID);
    const me = await player(s, "telegram", "1");
    await s.service.save(owner, { version: "0.6.0", kind: "added", platforms: ["telegram"], text: "Для Telegram" });
    await s.service.save(owner, { version: "0.6.0", kind: "added", platforms: ["vk"], text: "Для VK" });
    await s.service.publish(owner, "0.6.0");
    const server = await start(s);

    expect((await server.inject({ method: "GET", url: "/api/v1/changelog" })).statusCode).toBe(401);
    const token = await signAccessToken({ accountId: me.accountId, platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    const headers = { authorization: `Bearer ${token}` };
    expect((await server.inject({ method: "GET", url: "/api/v1/changelog?cursor=0.6.0'--", headers })).statusCode).toBe(400);

    const page = await server.inject({ method: "GET", url: "/api/v1/changelog", headers });
    expect(page.statusCode).toBe(200);
    const body = page.json() as { data: { versions: { version: string; fresh: boolean; entries: { text: string }[] }[]; latestAt: string } };
    expect(body.data.versions.map((version) => [version.version, version.fresh, version.entries.map((line) => line.text)])).toEqual([["0.6.0", true, ["Для Telegram"]]]);

    const seen = await server.inject({ method: "POST", url: "/api/v1/changelog/seen", headers, payload: { upTo: body.data.latestAt } });
    expect(seen.statusCode).toBe(200);
    expect(seen.json()).toEqual({ data: { badge: 0 } });
    expect((await server.inject({ method: "POST", url: "/api/v1/changelog/seen", headers, payload: { upTo: "вчера" } })).statusCode).toBe(400);
  });

  it("панель: владелец пишет и публикует, модератору закрыто, мусор — 400, без заголовка панели — 403", async () => {
    const s = setup();
    const store = new MemoryAdminSessionStore();
    const server = await start(s, store);
    const login = await server.inject({ method: "POST", url: "/api/v1/admin/session/dev", payload: { devUser: `dev-${OWNER_ID}:Владелец` } });
    const cookieLine = String(login.headers["set-cookie"]);
    const cookie = `${ADMIN_SESSION_COOKIE}=${/rubezh_admin_session=([^;]+)/.exec(cookieLine)?.[1] ?? ""}`;
    const headers = { cookie, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE };

    expect((await server.inject({ method: "POST", url: "/api/v1/admin/changelog", headers: { cookie }, payload: {} })).statusCode).toBe(403);
    expect((await server.inject({ method: "POST", url: "/api/v1/admin/changelog", headers, payload: { version: "0.6", kind: "added", text: "x" } })).statusCode).toBe(400);
    expect((await server.inject({ method: "POST", url: "/api/v1/admin/changelog", headers, payload: { version: "0.6.0", kind: "added", text: "   " } })).statusCode).toBe(400);

    const created = await server.inject({ method: "POST", url: "/api/v1/admin/changelog", headers, payload: { version: "0.6.0", kind: "added", platforms: ["telegram", "telegram"], text: "  Журнал обновлений  " } });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({ version: "0.6.0", platforms: ["telegram"], text: "Журнал обновлений", publishedAt: null });

    const published = await server.inject({ method: "POST", url: "/api/v1/admin/changelog/publish", headers, payload: { version: "0.6.0" } });
    expect(published.json().data).toMatchObject({ published: 1, release: { version: "0.6.0", platforms: ["telegram"] } });
    const list = await server.inject({ method: "GET", url: "/api/v1/admin/changelog", headers });
    expect(list.json().data.entries).toHaveLength(1);
    expect(list.json().data.releases).toHaveLength(1);
    expect((await server.inject({ method: "POST", url: "/api/v1/admin/changelog/не-id/remove", headers })).statusCode).toBe(400);

    const moderator = await s.accounts.upsert({ platform: "telegram", platformUserId: "600001", displayName: "Мод", username: null, photoUrl: null }, Date.now());
    await s.roles.grant(moderator.accountId, "moderator", null);
    await store.put(hashSessionToken("mod"), { accountId: moderator.accountId, platform: "telegram", platformUserId: "600001", issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    expect((await server.inject({ method: "GET", url: "/api/v1/admin/changelog", headers: { cookie: `${ADMIN_SESSION_COOKIE}=mod` } })).statusCode).toBe(403);
  });
});
