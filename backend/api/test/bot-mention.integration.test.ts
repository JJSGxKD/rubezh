import { Logger } from "@nestjs/common";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { BotMentionBackoff } from "../src/modules/bot-mention/bot-mention-backoff.js";
import { BotMentionSweepService } from "../src/modules/bot-mention/bot-mention-sweep.service.js";
import { PrismaBotMentionRepository } from "../src/modules/bot-mention/bot-mention.repository.js";
import { BotMentionService } from "../src/modules/bot-mention/bot-mention.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { BotMentions, type BotMention, type MentionFinding, type MentionKind, type MentionOutcome } from "../src/platforms/ports/bot-mention.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Задания «юзернейм бота» на настоящих Postgres и Redis
 * (docs/17-testing-strategy.md §4.2; tasks/T-0162). Адреса —
 * TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL, без них пропуск.
 *
 * Память этого не покажет: серию и награду суток держит один `UPDATE` с
 * условием, выбор очереди — запрос с соединением и группировкой, а награда
 * при двадцати проверках разом — уникальный ключ кошелька. Таблица состояния
 * в этом файле своя — перед каждым тестом она очищается. Redis — своя база
 * (сдвиг 13).
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 13);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

const HOUR = 3_600_000;
/** среда, 21.10.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 9, 21, 9));

class FakePort implements BotMention {
  readonly platform = "telegram" as const;
  readonly configured = true;
  ratePerSec = 25;
  readonly calls: { id: string; kinds: MentionKind[] }[] = [];
  answer: (id: string, kinds: readonly MentionKind[]) => MentionOutcome | Promise<MentionOutcome> = (_id, kinds) => everyone("present", kinds);

  botUsername(): string {
    return "game_bot";
  }

  async check(platformUserId: string, kinds: readonly MentionKind[]): Promise<MentionOutcome> {
    this.calls.push({ id: platformUserId, kinds: [...kinds] });
    return await this.answer(platformUserId, kinds);
  }
}

function everyone(finding: MentionFinding, kinds: readonly MentionKind[]): MentionOutcome {
  const findings: Partial<Record<MentionKind, MentionFinding>> = {};
  for (const kind of kinds) findings[kind] = finding;
  return { status: "checked", findings };
}

describe.skipIf(!live)("задания «юзернейм бота» на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let accounts: PrismaAccountRepository;
  let repository: PrismaBotMentionRepository;
  let wallet: WalletService;
  let backoff: BotMentionBackoff;
  let port: FakePort;
  let service: BotMentionService;
  let sweep: BotMentionSweepService;

  const settings = panelSettings({
    [SETTINGS.botMentionEnabled.key]: true,
    [SETTINGS.botMentionNameCoins.key]: 100,
    [SETTINGS.botMentionNameShards.key]: 2,
    [SETTINGS.botMentionBioGems.key]: 3,
  });

  function newSweep(): BotMentionSweepService {
    const created = new BotMentionSweepService(repository, new BotMentions([port]), service, settings, redis, backoff);
    created.pause = async () => undefined;
    created.clock = () => NOON;
    return created;
  }

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    redis = createRedis(config);
    await redis.connect();
    accounts = new PrismaAccountRepository(prisma);
    repository = new PrismaBotMentionRepository(prisma);
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    backoff = new BotMentionBackoff(redis);
  });

  beforeEach(async () => {
    // Строки лога модуля в вывод тестов не попадают.
    for (const level of ["log", "warn"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    await redis.flushdb();
    await prisma.$executeRaw`DELETE FROM bot_mention_task`;
    port = new FakePort();
    service = new BotMentionService(repository, new BotMentions([port]), wallet, settings, backoff);
    sweep = newSweep();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  async function player(platform: "telegram" | "max" = "telegram"): Promise<AccountRef> {
    const platformUserId = String(600_000_000 + Math.floor(Math.random() * 390_000_000));
    const created = await accounts.upsert({ platform, platformUserId, displayName: "Задания", username: null, photoUrl: null }, Date.now());
    return { accountId: created.accountId, platform, platformUserId };
  }

  async function rowOf(accountId: string, kind: MentionKind) {
    const row = (await repository.rows(accountId)).find((candidate) => candidate.kind === kind);
    if (row === undefined) throw new Error(`нет строки ${kind} у ${accountId}`);
    return row;
  }

  it("серия: награда в сутки D — серия 1, D+1 — 2, D+3 — снова 1; лучшая серия 2, награждённых суток 3; граница месяца считается по календарю", async () => {
    const me = await player();
    await repository.ensure(me.accountId, "name", NOON);

    expect(await repository.rewardDay(me.accountId, "name", "2026-10-10", NOON)).toMatchObject({ streak: 1, bestStreak: 1, rewardedDays: 1, lastDay: "2026-10-10", checkedDay: "2026-10-10", lastResult: "present", checkedAt: NOON });
    expect(await repository.rewardDay(me.accountId, "name", "2026-10-11", NOON)).toMatchObject({ streak: 2, bestStreak: 2, rewardedDays: 2 });
    expect(await repository.rewardDay(me.accountId, "name", "2026-10-13", NOON)).toMatchObject({ streak: 1, bestStreak: 2, rewardedDays: 3, lastDay: "2026-10-13" });

    expect(await repository.rewardDay(me.accountId, "name", "2026-10-31", NOON)).toMatchObject({ streak: 1, rewardedDays: 4 });
    expect(await repository.rewardDay(me.accountId, "name", "2026-11-01", NOON)).toMatchObject({ streak: 2, bestStreak: 2, rewardedDays: 5 });
    expect(await repository.rewardDay(me.accountId, "name", "2026-11-02", NOON)).toMatchObject({ streak: 3, bestStreak: 3 });
  });

  it("сутки награждаются один раз: повтор тех же суток и задним числом — null, строка не меняется", async () => {
    const me = await player();
    await repository.ensure(me.accountId, "name", NOON);
    await repository.rewardDay(me.accountId, "name", "2026-10-10", NOON);
    await repository.rewardDay(me.accountId, "name", "2026-10-11", NOON);
    const before = await rowOf(me.accountId, "name");

    expect(await repository.rewardDay(me.accountId, "name", "2026-10-11", NOON)).toBeNull();
    expect(await repository.rewardDay(me.accountId, "name", "2026-10-10", NOON)).toBeNull();
    expect(await rowOf(me.accountId, "name")).toEqual(before);
    // у bio своя серия
    await repository.ensure(me.accountId, "bio", NOON);
    expect(await repository.rewardDay(me.accountId, "bio", "2026-10-11", NOON)).toMatchObject({ streak: 1, rewardedDays: 1 });
    expect(await repository.rewardDay(me.accountId, "name", "2026-10-12", NOON)).toMatchObject({ streak: 3 });
  });

  it("десять одновременных наград суток: строку вернул один, серия выросла на единицу", async () => {
    const me = await player();
    await repository.ensure(me.accountId, "name", NOON);
    await repository.rewardDay(me.accountId, "name", "2026-10-10", NOON);

    const results = await Promise.all(Array.from({ length: 10 }, () => repository.rewardDay(me.accountId, "name", "2026-10-11", NOON)));

    expect(results.filter((row) => row !== null)).toHaveLength(1);
    expect(await rowOf(me.accountId, "name")).toMatchObject({ streak: 2, bestStreak: 2, rewardedDays: 2 });
  });

  it("20 параллельных проверок одного аккаунта и вида: одна запись кошелька на ресурс, суток награждено одни, серия 1", async () => {
    const me = await player();
    const results = await Promise.all(Array.from({ length: 20 }, () => service.check(me, "name", NOON)));

    const entries = await prisma.$queryRaw<{ resource: string; count: number; amount: number }[]>`
      SELECT resource::text AS resource, count(*)::int AS count, sum(amount)::int AS amount
      FROM wallet_entry WHERE account_id = ${me.accountId}::uuid AND source = 'bot-mention:name'
      GROUP BY resource ORDER BY resource`;
    expect(entries).toEqual([
      { resource: "coins", count: 1, amount: 100 },
      { resource: "shard_common", count: 1, amount: 2 },
    ]);
    expect(await rowOf(me.accountId, "name")).toMatchObject({ rewardedDays: 1, streak: 1, bestStreak: 1, lastDay: "2026-10-21", lastResult: "present" });
    expect(results.filter((result) => result.outcome === "present")).toHaveLength(1);
    expect(results.every((result) => ["present", "done_today"].includes(result.outcome))).toBe(true);
    const balances = await wallet.balances(me.accountId);
    expect(balances.coins).toBe(100);
    expect(balances.shard_common).toBe(2);
  });

  it("убрал юзернейм: полученное остаётся, отметка «убрал» не затирает награждённые сутки", async () => {
    const me = await player();
    await service.check(me, "name", NOON);
    port.answer = (_id, kinds) => everyone("absent", kinds);
    const later = await service.check(me, "name", new Date(NOON.getTime() + 2 * HOUR));

    expect(later.outcome).toBe("done_today");
    expect(await rowOf(me.accountId, "name")).toMatchObject({ lastResult: "present", rewardedDays: 1 });
    // отметка проверки не идёт назад и не перекрывает награждённый день
    await repository.markChecked(me.accountId, "name", "2026-10-21", "absent", NOON);
    await repository.markChecked(me.accountId, "name", "2026-10-20", "hidden", NOON);
    expect(await rowOf(me.accountId, "name")).toMatchObject({ lastResult: "present", checkedDay: "2026-10-21" });
    expect((await wallet.balances(me.accountId)).coins).toBe(100);
  });

  it("граница суток: проход в 20:59 UTC и в 21:00 UTC (полночь по Москве) — разные игровые сутки, во втором аккаунт выбирается снова", async () => {
    const me = await player();
    await repository.ensure(me.accountId, "name", NOON);
    port.answer = (_id, kinds) => everyone("absent", kinds);

    sweep.clock = () => new Date(Date.UTC(2026, 9, 21, 20, 59, 0));
    await sweep.run();
    expect(port.calls).toHaveLength(1);
    expect(await rowOf(me.accountId, "name")).toMatchObject({ checkedDay: "2026-10-21", lastResult: "absent" });

    sweep.clock = () => new Date(Date.UTC(2026, 9, 21, 20, 59, 59));
    await sweep.run();
    expect(port.calls).toHaveLength(1);

    sweep.clock = () => new Date(Date.UTC(2026, 9, 21, 21, 0, 0));
    await sweep.run();
    expect(port.calls).toHaveLength(2);
    expect(await rowOf(me.accountId, "name")).toMatchObject({ checkedDay: "2026-10-22" });
  });

  it("проход платит и ведёт серию на живой базе: два игровых дня подряд — две записи кошелька, серия 2", async () => {
    const me = await player();
    await repository.ensure(me.accountId, "name", NOON);

    sweep.clock = () => NOON;
    await sweep.run();
    sweep.clock = () => new Date(NOON.getTime() + 24 * HOUR);
    await sweep.run();

    expect(await rowOf(me.accountId, "name")).toMatchObject({ streak: 2, bestStreak: 2, rewardedDays: 2, lastDay: "2026-10-22" });
    expect((await wallet.balances(me.accountId)).coins).toBe(200);
    const keys = await prisma.$queryRaw<{ idempotency_key: string }[]>`
      SELECT idempotency_key FROM wallet_entry WHERE account_id = ${me.accountId}::uuid AND resource = 'coins' ORDER BY idempotency_key`;
    expect(keys.map((row) => row.idempotency_key)).toEqual([`bot-mention:${me.accountId}:name:2026-10-21:coins`, `bot-mention:${me.accountId}:name:2026-10-22:coins`]);
  });

  it("две реплики разом: проход идёт у одной, вызовов порта — по одному на аккаунт", async () => {
    const mine = [await player(), await player(), await player()];
    for (const [index, account] of mine.entries()) await repository.ensure(account.accountId, "name", new Date(NOON.getTime() - (3 - index) * HOUR));
    port.answer = async (_id, kinds) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return everyone("present", kinds);
    };

    const results = await Promise.all([newSweep().run(), newSweep().run()]);

    expect(results.map((result) => result.status === "skipped" ? result.reason : result.status).sort()).toEqual(["done", "locked"]);
    expect(port.calls.map((call) => call.id).sort()).toEqual(mine.map((account) => account.platformUserId).sort());
    expect(await redis.exists("bot-mention:sweep:lock")).toBe(0);
    for (const account of mine) expect(await rowOf(account.accountId, "name")).toMatchObject({ rewardedDays: 1 });
  });

  describe("очередь проверки", () => {
    async function started(account: AccountRef, kind: MentionKind, hoursAgo: number): Promise<void> {
      await repository.ensure(account.accountId, kind, new Date(NOON.getTime() - hoursAgo * HOUR));
    }

    it("due не отдаёт без начатого задания, проверенных сегодня, заблокированных и чужие площадки; порядок — checked_day NULLS FIRST, потом кто раньше начал", async () => {
      const none = await player();
      const never = await player();
      const today = await player();
      const old = await player();
      const halfDone = await player();
      const banned = await player();
      const other = await player("max");
      const both = await player();
      await started(never, "name", 5);
      await started(today, "name", 4);
      await repository.markChecked(today.accountId, "name", "2026-10-21", "unavailable", NOON);
      await started(old, "name", 3);
      await repository.markChecked(old.accountId, "name", "2026-10-19", "absent", NOON);
      await started(halfDone, "name", 6);
      await repository.markChecked(halfDone.accountId, "name", "2026-10-21", "absent", NOON);
      await started(halfDone, "bio", 6);
      await started(banned, "name", 7);
      await prisma.account.update({ where: { accountId: banned.accountId }, data: { bannedAt: NOON } });
      await started(other, "name", 8);
      await started(both, "name", 9);
      await started(both, "bio", 9);

      const due = await repository.due("telegram", "2026-10-21", ["name", "bio"], 10);

      expect(due).toEqual([
        { accountId: both.accountId, platformUserId: both.platformUserId, kinds: ["name", "bio"] },
        { accountId: halfDone.accountId, platformUserId: halfDone.platformUserId, kinds: ["bio"] },
        { accountId: never.accountId, platformUserId: never.platformUserId, kinds: ["name"] },
        { accountId: old.accountId, platformUserId: old.platformUserId, kinds: ["name"] },
      ]);
      expect(due.map((entry) => entry.accountId)).not.toContain(none.accountId);
      expect((await repository.due("telegram", "2026-10-21", ["name", "bio"], 2)).map((entry) => entry.accountId)).toEqual([both.accountId, halfDone.accountId]);
      // в очередь идут только оплачиваемые виды
      expect((await repository.due("telegram", "2026-10-21", ["name"], 10)).map((entry) => entry.accountId)).toEqual([both.accountId, never.accountId, old.accountId]);
      expect(await repository.due("telegram", "2026-10-21", [], 10)).toEqual([]);
      // следующие сутки — снова все, кроме заблокированного и чужой площадки
      expect((await repository.due("telegram", "2026-10-22", ["name", "bio"], 10)).map((entry) => entry.accountId)).toHaveLength(5);
    });

    it("игрок, начавший задание вручную, попадает в очередь, а просмотр экрана никого не заводит", async () => {
      const viewer = await player();
      const starter = await player();
      await service.view(viewer, NOON);
      port.answer = () => ({ status: "retry", afterSec: 1 });
      await service.check(starter, "bio", NOON);

      const due = await repository.due("telegram", "2026-10-21", ["name", "bio"], 10);
      expect(due.map((entry) => entry.accountId)).toEqual([starter.accountId]);
    });
  });

  it("аккаунт удалён — строки состояния ушли каскадом", async () => {
    const me = await player();
    await repository.ensure(me.accountId, "name", NOON);
    await repository.ensure(me.accountId, "bio", NOON);
    expect(await repository.rows(me.accountId)).toHaveLength(2);

    await prisma.$executeRaw`DELETE FROM account WHERE account_id = ${me.accountId}::uuid`;

    const left = await prisma.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM bot_mention_task WHERE account_id = ${me.accountId}::uuid`;
    expect(left).toEqual([{ count: 0 }]);
  });

  it("база держит допустимые значения: вид только name и bio, результат — из четырёх, первичный ключ — аккаунт и вид", async () => {
    const me = await player();
    await repository.ensure(me.accountId, "name", NOON);
    await repository.ensure(me.accountId, "name", NOON);
    expect(await repository.rows(me.accountId)).toHaveLength(1);

    await expect(prisma.$executeRaw`INSERT INTO bot_mention_task (account_id, kind, started_at) VALUES (${me.accountId}::uuid, 'avatar', now())`).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE bot_mention_task SET last_result = 'removed' WHERE account_id = ${me.accountId}::uuid`).rejects.toThrow();
    for (const result of ["present", "absent", "hidden", "unavailable"]) {
      await prisma.$executeRaw`UPDATE bot_mention_task SET last_result = ${result} WHERE account_id = ${me.accountId}::uuid`;
    }
  });

  it("повторное ensure не сбрасывает начатое: startedAt и серия остаются", async () => {
    const me = await player();
    await repository.ensure(me.accountId, "name", NOON);
    await repository.rewardDay(me.accountId, "name", "2026-10-21", NOON);
    await repository.ensure(me.accountId, "name", new Date(NOON.getTime() + HOUR));
    expect(await rowOf(me.accountId, "name")).toMatchObject({ startedAt: NOON, streak: 1, rewardedDays: 1 });
  });

  it("пауза площадки в Redis: держится заданное время, не укорачивается, потолок — час", async () => {
    expect(await backoff.remainingMs()).toBe(0);
    await backoff.hold(30);
    const left = await backoff.remainingMs();
    expect(left).toBeGreaterThan(28_000);
    expect(left).toBeLessThanOrEqual(30_000);
    expect(await redis.pttl("bot-mention:pause")).toBeGreaterThan(28_000);

    await backoff.hold(5);
    expect(await backoff.remainingMs()).toBeGreaterThan(25_000);

    await redis.del("bot-mention:pause");
    await backoff.hold(999_999);
    const capped = await redis.pttl("bot-mention:pause");
    expect(capped).toBeGreaterThan(3_500_000);
    expect(capped).toBeLessThanOrEqual(3_600_000);
  });
});
