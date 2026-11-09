import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Global, Module, type Type } from "@nestjs/common";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APP_MODULES } from "../src/app.module.js";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createHttpApp } from "../src/http-app.js";
import { createPrisma } from "../src/infra/database.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import type { FeedEvent } from "../src/modules/feed/feed-events.js";
import { FeedModule } from "../src/modules/feed/feed.module.js";
import { LiveFeedRepository } from "../src/modules/feed/feed.repository.js";
import { FeedService } from "../src/modules/feed/feed.service.js";
import { AccountRestrictions } from "../src/modules/restrictions/account-restrictions.js";
import { PrismaRestrictionsRepository } from "../src/modules/restrictions/restrictions.repository.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import { SeasonSchedule } from "../src/modules/seasons/seasons-schedule.js";
import { SeasonsModule } from "../src/modules/seasons/seasons.module.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Лента на настоящих Postgres и Redis (docs/17-testing-strategy.md §4.2;
 * tasks/T-0174; адреса — TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL, без них
 * пропуск). Подмена не покажет, что `ZADD NX` не дублирует событие, а Lua
 * лидера недели держится под гонкой и что скрытый вид ограничения в базе
 * действительно убирает игрока из ответа.
 *
 * Своя база Redis (сдвиг 15): сдвиги 1–14 уже заняты соседними файлами, а
 * `flushdb` в `beforeEach` сносил бы их ключи прямо посреди прогона.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 15);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

const HOUR = 3_600_000;
const DAY = 86_400_000;
// «Сейчас» теста — настоящие часы, а не дата: сервис ставит отметку записи по
// `Date.now()` и отбрасывает события старше суток. С датой в коде тест
// краснел через сутки после неё — на любой ветке, без единой правки ленты.
const NOW = new Date();

function recorded(accountId: string, patch: Partial<RecordedRun> = {}): RecordedRun {
  return {
    runId: randomUUID(),
    accountId,
    difficulty: "hard",
    outcome: "died",
    survivalSec: 700,
    level: 10,
    enemiesKilled: 300,
    startingWeaponId: "knife",
    weapons: [],
    boosts: [],
    xpCollected: null,
    counters: null,
    deathCause: null,
    cheats: false,
    continues: 0,
    ranked: true,
    verdict: "ok",
    reasons: [],
    finishedAt: NOW,
    ...patch,
  };
}

describe.skipIf(!live)("лента событий на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let accounts: PrismaAccountRepository;
  let repository: LiveFeedRepository;
  let restrictions: AccountRestrictions;
  let hooks: RunsHooks;
  let service: FeedService;

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    redis = createRedis(config);
    await redis.connect();
    accounts = new PrismaAccountRepository(prisma);
    repository = new LiveFeedRepository(redis, prisma);
    restrictions = new AccountRestrictions(new PrismaRestrictionsRepository(prisma), redis, config);
  });

  beforeEach(async () => {
    await redis.flushdb();
    const settings = panelSettings({ [SETTINGS.seasonsStartDate.key]: 20_260_105 });
    hooks = new RunsHooks();
    service = new FeedService(repository, new SeasonSchedule(settings), hooks, restrictions, settings);
    service.onModuleInit();
  });

  afterEach(async () => {
    await prisma.accountRestriction.deleteMany({ where: { reason: "feed-test" } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  async function account(name = "Игрок"): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(700_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: name, username: null, photoUrl: null },
      Date.now(),
    );
    return created.accountId;
  }

  const event = (accountId: string, patch: Partial<FeedEvent> = {}): FeedEvent => ({ id: `${randomUUID()}:long_run`, kind: "long_run", accountId, atMs: NOW.getTime() - HOUR, seconds: 700, ...patch });

  it("одно и то же событие дважды — одна запись в feed:events", async () => {
    const id = await account();
    const item = event(id, { id: "run-x:long_run" });

    await repository.add([item], NOW.getTime());
    await repository.add([{ ...item }], NOW.getTime());

    expect(await redis.zcard("feed:events")).toBe(1);
    expect((await repository.recent(NOW.getTime() - DAY, 500)).events).toEqual([item]);
  });

  it("у ключа есть срок жизни: лента не копится вечно", async () => {
    await repository.add([event(await account())], NOW.getTime());

    const ttl = await redis.ttl("feed:events");

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(172_800);
  });

  it("события старше суток убираются при следующей записи", async () => {
    const id = await account();
    await repository.add([event(id, { id: "old:long_run", atMs: NOW.getTime() - DAY - HOUR })], NOW.getTime() - DAY);
    expect(await redis.zcard("feed:events")).toBe(1);

    await repository.add([event(id, { id: "new:long_run" })], NOW.getTime());

    const left = (await repository.recent(0, 500)).events;
    expect(left.map((item) => item.id)).toEqual(["new:long_run"]);
  });

  it("битая запись в наборе пропускается и считается, остальные читаются", async () => {
    const id = await account();
    await repository.add([event(id, { id: "good:long_run" })], NOW.getTime());
    await redis.zadd("feed:events", NOW.getTime() - 1_000, "это не JSON");
    await redis.zadd("feed:events", NOW.getTime() - 2_000, JSON.stringify({ id: 1 }));

    const read = await repository.recent(NOW.getTime() - DAY, 500);

    expect(read.events.map((item) => item.id)).toEqual(["good:long_run"]);
    expect(read.skipped).toBe(2);
  });

  it("recent не отдаёт больше потолка", async () => {
    const id = await account();
    await repository.add(Array.from({ length: 12 }, (_, index) => event(id, { id: `r${String(index)}:long_run`, atMs: NOW.getTime() - index * 1_000 })), NOW.getTime());

    expect((await repository.recent(0, 5)).events).toHaveLength(5);
  });

  it("bumpWeekTop: 50 параллельных вызовов — итог максимум, -1 получает ровно один, возврат больше нуля — только у обошедших", async () => {
    const values = Array.from({ length: 50 }, (_, index) => (index + 1) * 10);
    const shuffled = [...values].sort(() => Math.random() - 0.5);

    const results = await Promise.all(shuffled.map(async (value) => ({ value, result: await repository.bumpWeekTop("2026-11-02", "hard", value) })));

    expect(Number(await redis.get("feed:week-top:2026-11-02:hard"))).toBe(500);
    expect(results.filter((item) => item.result === -1)).toHaveLength(1);
    const beaten = results.filter((item) => item.result > 0);
    expect(beaten.length).toBeLessThanOrEqual(49);
    // Обошедший всегда длиннее прежнего значения, а прежнее — одно из присланных.
    for (const item of beaten) {
      expect(item.value).toBeGreaterThan(item.result);
      expect(values).toContain(item.result);
    }
    expect(results.every((item) => item.result >= -1)).toBe(true);
    expect(await redis.ttl("feed:week-top:2026-11-02:hard")).toBeGreaterThan(0);
  });

  it("bumpWeekTop: равное время рекордом не считается, сложности и недели не смешиваются", async () => {
    expect(await repository.bumpWeekTop("2026-11-02", "hard", 400)).toBe(-1);
    expect(await repository.bumpWeekTop("2026-11-02", "hard", 400)).toBe(0);
    expect(await repository.bumpWeekTop("2026-11-02", "hard", 450)).toBe(400);
    expect(await repository.bumpWeekTop("2026-11-09", "hard", 100)).toBe(-1);
    expect(await repository.bumpWeekTop("2026-11-02", "normal", 100)).toBe(-1);
  });

  it("namesOf: имя из базы, заблокированный и неизвестный аккаунт не попадают в ответ", async () => {
    const alice = await account("Алиса");
    const banned = await account("Бан");
    await prisma.account.update({ where: { accountId: banned }, data: { bannedAt: new Date() } });

    const names = await repository.namesOf([alice, banned, randomUUID()]);

    expect([...names.entries()]).toEqual([[alice, "Алиса"]]);
    expect((await repository.namesOf([])).size).toBe(0);
  });

  it("забег от записи до ответа: событие видно с именем, переименование видно после сброса кэша", async () => {
    const id = await account("Алиса");

    await hooks.emit(recorded(id, { survivalSec: 800 }));
    const first = await service.view(NOW);

    expect(first.events.map((item) => [item.kind, item.name, item.seconds])).toEqual([["long_run", "Алиса", 800]]);

    await prisma.account.update({ where: { accountId: id }, data: { displayName: "Алисия" } });
    service.dropCache();

    expect((await service.view(NOW)).events[0]?.name).toBe("Алисия");
  });

  it("рекорд недели через запись: второй забег длиннее первого — событие week_record", async () => {
    const id = await account();

    await hooks.emit(recorded(id, { survivalSec: 300 }));
    await hooks.emit(recorded(id, { survivalSec: 350 }));

    expect((await service.view(NOW)).events.map((item) => item.kind)).toEqual(["week_record"]);
  });

  it("скрытый вид separate_board: события не видны, ограничение снято и кэш сброшен — видны", async () => {
    const hidden = await account("Скрытый");
    const open = await account("Открытый");
    await hooks.emit(recorded(hidden, { survivalSec: 800 }));
    await hooks.emit(recorded(open, { survivalSec: 800 }));
    const restriction = await prisma.accountRestriction.create({
      data: { accountId: hidden, kind: "separate_board", startsAt: new Date(NOW.getTime() - HOUR), endsAt: null, reason: "feed-test", notify: false },
    });

    expect((await service.view(NOW)).events.map((item) => item.name)).toEqual(["Открытый"]);

    await prisma.accountRestriction.update({ where: { restrictionId: restriction.restrictionId }, data: { liftedAt: NOW, liftComment: "feed-test" } });
    service.dropCache();

    expect((await service.view(NOW)).events.map((item) => item.name).sort()).toEqual(["Открытый", "Скрытый"]);
  });

  it("закрытый рейтинг и блокировка all тоже убирают игрока из ленты", async () => {
    const closed = await account("Закрытый");
    const blocked = await account("Блок");
    await hooks.emit(recorded(closed, { survivalSec: 800 }));
    await hooks.emit(recorded(blocked, { survivalSec: 800 }));
    for (const [accountId, kind] of [[closed, "leaderboard"], [blocked, "all"]] as const) {
      await prisma.accountRestriction.create({ data: { accountId, kind, startsAt: new Date(NOW.getTime() - HOUR), endsAt: null, reason: "feed-test", notify: kind === "all" } });
    }

    expect((await service.view(NOW)).events).toEqual([]);
  });

  it("заблокированный аккаунт (bannedAt) в ленте не виден, хотя события записаны", async () => {
    const id = await account("Бан");
    await hooks.emit(recorded(id, { survivalSec: 800 }));
    await prisma.account.update({ where: { accountId: id }, data: { bannedAt: new Date() } });

    expect((await service.view(NOW)).events).toEqual([]);
  });

  it("ключ feed:events потерян — пустая лента без ошибки", async () => {
    await hooks.emit(recorded(await account(), { survivalSec: 800 }));
    await redis.del("feed:events");
    service.dropCache();

    expect(await service.view(NOW)).toEqual({ events: [], refreshSec: 300 });
  });
});

describe.skipIf(!live)("сборка приложения", () => {
  it("FeedService получает SeasonSchedule от настоящего SeasonsModule", async () => {
    const bootConfig = loadAppConfig({
      NODE_ENV: "test",
      ...AUTH_ENV,
      DATABASE_URL,
      REDIS_URL,
      TELEGRAM_API_ROOT: "http://127.0.0.1:9",
      TELEGRAM_BOT_UPDATES: "off",
    } as NodeJS.ProcessEnv);

    @Global()
    @Module({ providers: [{ provide: APP_CONFIG, useValue: bootConfig }], exports: [APP_CONFIG] })
    class TestConfigModule {}

    @Module({ imports: [TestConfigModule, ...APP_MODULES] })
    class BootModule {}

    const app = await createHttpApp(BootModule as Type<unknown>, { logger: false });
    try {
      await app.init();
      const feed = app.select(FeedModule).get(FeedService, { strict: false });
      const schedule = app.select(SeasonsModule).get(SeasonSchedule, { strict: false });
      expect((feed as unknown as { schedule: unknown }).schedule).toBe(schedule);
    } finally {
      await app.close();
    }
  });
});
