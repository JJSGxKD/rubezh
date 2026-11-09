import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { PrismaAccountSettingsRepository } from "../src/modules/account-settings/account-settings.repository.js";
import { AccountSettingsService } from "../src/modules/account-settings/account-settings.service.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaMessagingRepository } from "../src/modules/messaging/messaging.repository.js";
import { PrismaNotificationsRepository } from "../src/modules/notifications/notifications.repository.js";
import { NotificationsService } from "../src/modules/notifications/notifications.service.js";
import { PrismaRemindersRepository } from "../src/modules/reminders/reminders.repository.js";
import { RemindersReport } from "../src/modules/reminders/reminders.report.js";
import { TICK_LIMIT, type ReminderKind } from "../src/modules/reminders/reminder-rules.js";
import { RemindersScanner } from "../src/modules/reminders/reminders.scanner.js";
import { RemindersStore } from "../src/modules/reminders/reminders.store.js";
import { RedisSeasonBoardStore } from "../src/modules/seasons/season-board.store.js";
import { seasonOf, type Season } from "../src/modules/seasons/season-rules.js";
import { SeasonSchedule } from "../src/modules/seasons/seasons-schedule.js";
import type { ChatTarget } from "../src/platforms/ports/chat-target.js";
import { Messengers, type Messenger, type OutgoingMessage, type SendOutcome } from "../src/platforms/ports/messenger.js";
import { panelSettings } from "./helpers/settings.js";
import { redisDatabase } from "./helpers/redis-database.js";

/**
 * Напоминания на живых Postgres и Redis (docs/17-testing-strategy.md §4.2;
 * tasks/T-0128). Адреса — TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL, без них
 * пропуск.
 *
 * Память этого не покажет: курсор по `account_id` проходит тысячи строк, лок
 * держит один Redis на две реплики, а ключ события не даёт второй строке лечь
 * в ленту при любом повторе прохода.
 *
 * Каждый тест живёт на своей неделе далёкого будущего: база общая для всех
 * прогонов и файлов, а запросы планировщика идут по всей таблице награды дня.
 * Redis — база со сдвигом 14: сосед по ней (`shop-choice`) не делает `flushdb`,
 * а на сдвиге 13 её делают достижения и упоминания бота и посреди теста
 * стирали окно потолка. Сами не `flushdb`: ключи напоминаний несут дату своей
 * недели, а лок и окна потолка убираются поимённо.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 14);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

const DAY = 86_400_000;
const FIRST_MONDAY = Date.UTC(2026, 10, 2);
const LOCK_KEY = "reminders:scan:lock";

class FakeMessenger implements Messenger {
  readonly platform = "telegram" as const;
  readonly configured = true;
  readonly ratePerSec = 25;
  readonly posts: { target: ChatTarget; text: string }[] = [];

  async send(_to: string, _message: OutgoingMessage): Promise<SendOutcome> {
    return { status: "sent" };
  }

  async sendToChat(target: ChatTarget, text: string): Promise<SendOutcome> {
    this.posts.push({ target, text });
    return { status: "sent" };
  }
}

describe.skipIf(!live)("напоминания на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let accounts: PrismaAccountRepository;
  let messaging: PrismaMessagingRepository;
  let feed: NotificationsService;
  let repository: PrismaRemindersRepository;
  let store: RemindersStore;
  let board: RedisSeasonBoardStore;
  let accountSettings: AccountSettingsService;
  const created: string[] = [];
  const handedOut = new Set<string>();

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    redis = createRedis(config);
    await redis.connect();
    accounts = new PrismaAccountRepository(prisma);
    messaging = new PrismaMessagingRepository(prisma);
    feed = new NotificationsService(new PrismaNotificationsRepository(prisma));
    repository = new PrismaRemindersRepository(prisma);
    store = new RemindersStore(redis);
    board = new RedisSeasonBoardStore(redis);
    accountSettings = new AccountSettingsService(new PrismaAccountSettingsRepository(prisma));
  });

  afterAll(async () => {
    await redis.del(LOCK_KEY);
    for (let start = 0; start < created.length; start += 500) {
      await prisma.account.deleteMany({ where: { accountId: { in: created.slice(start, start + 500) } } });
    }
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  /** Неделя далёкого будущего, на которой нет ни наград дня, ни забегов, ни таблицы, ни другого теста. */
  async function freeWeek(): Promise<Season> {
    for (;;) {
      const season = seasonOf(new Date(FIRST_MONDAY + (1_000 + Math.floor(Math.random() * 1_400)) * 7 * DAY));
      if (handedOut.has(season.key)) continue;
      const from = new Date(season.startsAt.getTime() - 20 * DAY);
      const taken =
        (await prisma.dailyReward.count({ where: { lastClaimDay: { gte: from, lt: season.endsAt } } })) +
        (await prisma.run.count({ where: { finishedAt: { gte: season.startsAt, lt: season.endsAt } } })) +
        (await redis.exists(`seasons:${season.key}:hard`));
      if (taken > 0) continue;
      handedOut.add(season.key);
      return season;
    }
  }

  /** Момент недели по Москве: `weekday` 0 — понедельник. */
  const msk = (season: Season, weekday: number, hour: number, minute = 0): Date => new Date(season.startsAt.getTime() + weekday * DAY + (hour - 3) * 3_600_000 + minute * 60_000);
  const dayOf = (season: Season, weekday: number): string => new Date(season.startsAt.getTime() + weekday * DAY).toISOString().slice(0, 10);

  async function player(options: { canMessage?: boolean | null; banned?: boolean; platform?: "telegram" | "vk"; prologueDone?: boolean } = {}): Promise<string> {
    const { canMessage = true, banned = false, platform = "telegram", prologueDone = true } = options;
    const account = await accounts.upsert({ platform, platformUserId: String(500_000_000 + Math.floor(Math.random() * 400_000_000)), displayName: "Напомни", username: null, photoUrl: null }, Date.now());
    created.push(account.accountId);
    if (canMessage !== null) await messaging.set(account.accountId, { canMessage, reason: canMessage ? "entered" : "blocked", changedAt: new Date() });
    // Награда дня закрыта до пролога (Р151): без признака игрок в напоминания не попадает.
    if (prologueDone) await prisma.account.update({ where: { accountId: account.accountId }, data: { prologueDoneAt: new Date() } });
    if (banned) await prisma.account.update({ where: { accountId: account.accountId }, data: { bannedAt: new Date(), banReason: "тест" } });
    return account.accountId;
  }

  async function claimedOn(accountId: string, day: string): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO daily_reward (account_id, claimed_days, last_claim_day, updated_at)
      VALUES (${accountId}::uuid, 3, ${day}::date, now())
      ON CONFLICT (account_id) DO UPDATE SET last_claim_day = EXCLUDED.last_claim_day`;
  }

  async function ranked(accountId: string, at: Date, patch: { ranked?: boolean; difficulty?: "easy" | "normal" | "hard" } = {}): Promise<void> {
    await prisma.run.create({
      data: {
        runId: randomUUID(),
        accountId,
        status: "finished",
        difficulty: patch.difficulty ?? "hard",
        startingWeaponId: "knife",
        contentHash: "abc",
        finishedAt: at,
        outcome: "died",
        survivalSec: 200,
        level: 5,
        enemiesKilled: 100,
        ranked: patch.ranked ?? true,
        verdict: "ok",
        verdictReasons: [],
      },
    });
  }

  function world(season: Season, panel: Record<string, string | number | boolean> = {}) {
    const settings = panelSettings({ "reminders.enabled": true, "seasons.start-date": Number(season.key.replaceAll("-", "")), ...panel });
    const messenger = new FakeMessenger();
    const messengers = new Messengers([messenger]);
    const report = new RemindersReport(settings, { chats: () => ({ general: null }) } as never, store, repository, messengers);
    const scanner = (): RemindersScanner => new RemindersScanner(config, settings, repository, store, new SeasonSchedule(settings), board, feed, accountSettings, messengers, { runIfDue: async () => "not_due" as const });
    return { settings, messenger, messengers, report, scanner };
  }

  const rowsOf = async (accountIds: readonly string[], kind?: ReminderKind) =>
    await prisma.notification.findMany({ where: { accountId: { in: [...accountIds] }, ...(kind === undefined ? {} : { kind }) }, orderBy: { createdAt: "asc" } });

  it("награда дня: 1 200 игроков за три тика — каждый ровно один раз, повторный проход ничего не создаёт", async () => {
    const season = await freeWeek();
    const w = world(season);
    const wednesday = dayOf(season, 2);
    const tuesday = dayOf(season, 1);
    const ids: string[] = [];
    for (let start = 0; start < 1_200; start += 100) {
      ids.push(...(await Promise.all(Array.from({ length: 100 }, () => player()))));
    }
    await prisma.$executeRaw`
      INSERT INTO daily_reward (account_id, claimed_days, last_claim_day, updated_at)
      SELECT unnest(${ids}::uuid[]), 3, ${tuesday}::date, now()`;

    const counts: number[] = [];
    for (let tick = 0; tick < 3; tick++) {
      const summary = await w.scanner().tick(msk(season, 2, 12, tick * 10));
      expect(summary.status).toBe("done");
      counts.push(summary.created.daily_reward_ready);
    }
    expect(TICK_LIMIT).toBe(500);
    expect(counts).toEqual([500, 500, 200]);
    const rows = await rowsOf(ids, "daily_reward_ready");
    expect(rows).toHaveLength(1_200);
    expect(new Set(rows.map((row) => row.accountId)).size).toBe(1_200);
    expect(new Set(rows.map((row) => row.dedupeKey))).toEqual(new Set([`daily_reward_ready:${wednesday}`]));

    // Курсор «готово» сброшен — второй проход идёт по тем же игрокам, а строк не добавляет.
    await redis.del(`reminders:cur:daily:${wednesday}`);
    let again = 0;
    for (let tick = 0; tick < 3; tick++) again += (await w.scanner().tick(msk(season, 2, 13, tick * 10))).created.daily_reward_ready;
    expect(again).toBe(0);
    expect(await rowsOf(ids, "daily_reward_ready")).toHaveLength(1_200);
  }, 120_000);

  it("не выбираются: нельзя писать, не прошёл пролог, заблокирован, давно не заходил, уже забрал сегодня, платформа без бота, занято окно потолка, отписался", async () => {
    const season = await freeWeek();
    const w = world(season, { "reminders.lapse-days": 14 });
    const tuesday = dayOf(season, 1);
    const wednesday = dayOf(season, 2);
    const longAgo = new Date(Date.parse(`${wednesday}T00:00:00Z`) - 15 * DAY).toISOString().slice(0, 10);
    const edge = new Date(Date.parse(`${wednesday}T00:00:00Z`) - 14 * DAY).toISOString().slice(0, 10);

    const eligible = await player();
    const atEdge = await player();
    const strangers = await player({ canMessage: null });
    const blockedBot = await player({ canMessage: false });
    const banned = await player({ banned: true });
    const lapsed = await player();
    const claimedToday = await player();
    const noBot = await player({ platform: "vk" });
    const busy = await player();
    const optedOut = await player();
    const noPrologue = await player({ prologueDone: false });
    for (const id of [eligible, strangers, blockedBot, banned, noBot, busy, optedOut, noPrologue]) await claimedOn(id, tuesday);
    await claimedOn(atEdge, edge);
    await claimedOn(lapsed, longAgo);
    await claimedOn(claimedToday, wednesday);
    await redis.set(`bot-notify:${busy}:reminder`, randomUUID(), "EX", 600);
    await accountSettings.merge({ accountId: optedOut, platform: "telegram", platformUserId: "1" }, { version: 1, values: { "bot.reminders": { value: false, ageMs: 0 } } });

    const all = [eligible, atEdge, strangers, blockedBot, banned, lapsed, claimedToday, noBot, busy, optedOut, noPrologue];
    await w.scanner().tick(msk(season, 2, 12));
    const rows = await rowsOf(all);
    expect(rows.map((row) => row.accountId).sort()).toEqual([eligible, atEdge].sort());
    await redis.del(`bot-notify:${busy}:reminder`);
  });

  it("два планировщика одновременно: работу делает один, лок снят", async () => {
    const season = await freeWeek();
    const w = world(season);
    const ids = await Promise.all(Array.from({ length: 30 }, () => player()));
    await prisma.$executeRaw`
      INSERT INTO daily_reward (account_id, claimed_days, last_claim_day, updated_at)
      SELECT unnest(${ids}::uuid[]), 3, ${dayOf(season, 1)}::date, now()`;
    const [left, right] = await Promise.all([w.scanner().tick(msk(season, 2, 12)), w.scanner().tick(msk(season, 2, 12))]);
    expect([left.status, right.status].sort()).toEqual(["done", "locked"]);
    expect(await rowsOf(ids)).toHaveLength(30);
    expect(await redis.exists(LOCK_KEY)).toBe(0);
  });

  it("тик в тихий час снимок таблицы не обновляет: обгон за ночь виден утром", async () => {
    const season = await freeWeek();
    const w = world(season);
    const [a, b, c] = await Promise.all([player(), player(), player()]);
    await board.submit(season, "hard", a, 300);
    await board.submit(season, "hard", b, 200);
    await w.scanner().tick(msk(season, 2, 12));
    const snapshotKey = `reminders:snap:${season.key}:hard`;
    const before = await redis.get(snapshotKey);
    expect(before).not.toBeNull();

    // Ночью B обошёл A: тик в тихие часы ничего не трогает.
    await board.submit(season, "hard", b, 350);
    await board.submit(season, "hard", c, 100);
    expect((await w.scanner().tick(msk(season, 2, 23, 30))).status).toBe("quiet");
    expect(await redis.get(snapshotKey)).toBe(before);
    expect(await rowsOf([a, b, c])).toEqual([]);

    // Утром первый же тик видит обгон.
    const morning = await w.scanner().tick(msk(season, 3, 10, 5));
    expect(morning.created.season_overtaken).toBe(1);
    expect((await rowsOf([a], "season_overtaken")).map((row) => row.payload)).toEqual([{ difficulty: "hard", place: 2 }]);
  });

  it("обгон: A на 3-м месте, B прошёл его — A получает «обогнали» с новым местом, B нет; второй обгон в те же сутки строки не добавляет", async () => {
    const season = await freeWeek();
    const w = world(season);
    const [top1, top2, a, b] = await Promise.all([player(), player(), player(), player()]);
    await board.submit(season, "hard", top1, 500);
    await board.submit(season, "hard", top2, 400);
    await board.submit(season, "hard", a, 300);
    await board.submit(season, "hard", b, 250);

    // Первый тик сезона обгонов не даёт: снимка ещё нет.
    expect((await w.scanner().tick(msk(season, 2, 12))).created.season_overtaken).toBe(0);
    expect(await rowsOf([top1, top2, a, b])).toEqual([]);

    await board.submit(season, "hard", b, 320);
    const summary = await w.scanner().tick(msk(season, 2, 12, 10));
    expect(summary.created.season_overtaken).toBe(1);
    const mine = await rowsOf([a], "season_overtaken");
    expect(mine.map((row) => [row.payload, row.dedupeKey])).toEqual([[{ difficulty: "hard", place: 4 }, `season_overtaken:${season.key}:${dayOf(season, 2)}`]]);
    expect(await rowsOf([b, top1, top2])).toEqual([]);

    // Ещё один прошёл A в те же сутки: ключ сезона и суток не пускает вторую строку.
    const c = await player();
    await board.submit(season, "hard", c, 310);
    const third = await w.scanner().tick(msk(season, 2, 12, 20));
    expect(third.created.season_overtaken).toBe(0);
    expect(await rowsOf([a], "season_overtaken")).toHaveLength(1);
  });

  it("сезон закрывается: только в игровой день перед закрытием и только игрокам с рейтинговым забегом недели", async () => {
    const season = await freeWeek();
    const w = world(season);
    const withRun = await player();
    const withoutRun = await player();
    const notRanked = await player();
    const wrongDifficulty = await player();
    const blocked = await player({ canMessage: false });
    await ranked(withRun, msk(season, 1, 12));
    await ranked(notRanked, msk(season, 1, 12), { ranked: false });
    await ranked(wrongDifficulty, msk(season, 1, 12), { difficulty: "easy" });
    await ranked(blocked, msk(season, 1, 12));
    const all = [withRun, withoutRun, notRanked, wrongDifficulty, blocked];

    // Суббота — ещё не день перед закрытием.
    expect((await w.scanner().tick(msk(season, 5, 12))).created.season_closing).toBe(0);
    // Воскресенье по Москве — день перед закрытием: сезон кончается в 03:00 понедельника.
    const sunday = await w.scanner().tick(msk(season, 6, 12));
    expect(sunday.created.season_closing).toBe(1);
    const rows = await rowsOf(all, "season_closing");
    expect(rows.map((row) => [row.accountId, row.dedupeKey, row.payload])).toEqual([[withRun, `season_closing:${season.key}`, { endsAt: season.endsAt.toISOString() }]]);
    // Повтор в тот же день — ничего нового.
    expect((await w.scanner().tick(msk(season, 6, 12, 10))).created.season_closing).toBe(0);
    expect(await rowsOf(all, "season_closing")).toHaveLength(1);
  });

  it("игрок, которому нельзя писать, не получает ни одной строки ленты за сутки", async () => {
    const season = await freeWeek();
    const w = world(season);
    const strangers = await Promise.all([player({ canMessage: null }), player({ canMessage: false }), player({ canMessage: null })]);
    for (const id of strangers) {
      await claimedOn(id, dayOf(season, 1));
      await ranked(id, msk(season, 1, 12));
    }
    await board.submit(season, "hard", strangers[0] ?? "", 100);
    await w.scanner().tick(msk(season, 2, 12));
    await w.scanner().tick(msk(season, 2, 12, 10));
    await w.scanner().tick(msk(season, 6, 12));
    expect(await rowsOf(strangers)).toEqual([]);
  });

  it("отчёт за вчера: цифры из ленты, блокировки после отправки, один раз за сутки", async () => {
    const season = await freeWeek();
    const w = world(season, { "notify.chat.reminders": "-1001234567890:57" });
    const yesterdayNoon = msk(season, 2, 12);
    const [sentA, sentB, blockedAfter, notDelivered, outOfDay] = await Promise.all([player(), player(), player(), player(), player()]);
    const row = async (accountId: string, kind: ReminderKind, outcome: "sent" | "blocked" | "failed" | null, at: Date, botAt: Date | null = at) => {
      await prisma.notification.create({
        data: { notificationId: randomUUID(), accountId, kind, payload: kind === "season_overtaken" ? { difficulty: "hard", place: 2 } : {}, dedupeKey: `${kind}:${randomUUID()}`, createdAt: at, botOutcome: outcome, botAt: outcome === null ? null : botAt },
      });
    };
    await row(sentA, "daily_reward_ready", "sent", yesterdayNoon);
    await row(sentB, "season_overtaken", "sent", new Date(yesterdayNoon.getTime() + 60_000));
    await row(blockedAfter, "season_closing", "sent", yesterdayNoon);
    await row(notDelivered, "daily_reward_ready", "failed", yesterdayNoon);
    await row(outOfDay, "daily_reward_ready", "sent", msk(season, 1, 12));
    // Игрок заблокировал бота после напоминания — отметка новее отправки.
    await messaging.set(blockedAfter, { canMessage: false, reason: "blocked", changedAt: new Date(yesterdayNoon.getTime() + 3_600_000) });

    const summary = await repository.daySummary({ from: msk(season, 2, 0), to: msk(season, 3, 0) });
    expect(summary).toEqual({ sent: { season_overtaken: 1, season_closing: 1, daily_reward_ready: 1 }, undelivered: 1, blockedAfter: 1 });

    expect(await w.report.runIfDue(msk(season, 3, 0, 15))).toBe("sent");
    expect(await w.report.runIfDue(msk(season, 3, 9))).toBe("already");
    expect(w.messenger.posts).toHaveLength(1);
    expect(w.messenger.posts[0]?.target).toEqual({ chatId: "-1001234567890", threadId: 57 });
    expect(w.messenger.posts[0]?.text).toMatch(/^🔔 Напоминания за \d{1,2} [а-я]+\n/);
    await redis.del(`reminders:report:${dayOf(season, 2)}`);
  });
});
