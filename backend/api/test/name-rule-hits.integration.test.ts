import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanAll } from "../src/cli/display-names-clean.js";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { BullNameRuleHitsTransport, NAME_RULE_HITS_LIMITS, NameRuleHits } from "../src/modules/name-rules/name-rule-hits.js";
import { PrismaNameRuleHitsRepository } from "../src/modules/name-rules/name-rule-hits.repository.js";
import { NameRulesCache } from "../src/modules/name-rules/name-rules-cache.service.js";
import { PrismaNameRulesRepository, loadNameRuleSet, type StoredNameRule } from "../src/modules/name-rules/name-rules.repository.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Счётчики срабатываний правил имён на живых Postgres и Redis (tasks/T-0340):
 * вход игрока — буфер — очередь — воркер — строка `(rule_id, сутки UTC)`.
 * Ников и id игроков в таблице нет. Без базы и Redis — пропуск. Шаблоны
 * уникальны на прогон: таблица правил общая с соседними тестами.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 5);
const RUN = randomUUID().slice(0, 4);
const TIMEOUT_MS = 30_000;
const DAY = 86_400_000;

const today = (): string => new Date().toISOString().slice(0, 10);

describe.skipIf(DATABASE_URL === "" || REDIS_URL === "")("счётчики срабатываний правил имён на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let rulesRepository: PrismaNameRulesRepository;
  let repository: PrismaNameRuleHitsRepository;
  let hits: NameRuleHits;
  let cache: NameRulesCache;
  let accounts: PrismaAccountRepository;
  const clients: Redis[] = [];
  const ruleIds: string[] = [];
  const accountIds: string[] = [];

  const newUserId = (): string => String(500_000_000 + Math.floor(Math.random() * 400_000_000));

  async function addRule(category: StoredNameRule["category"], kind: StoredNameRule["kind"], pattern: string): Promise<StoredNameRule> {
    const at = new Date();
    const row: StoredNameRule = { ruleId: randomUUID(), category, kind, pattern, active: true, note: null, createdAt: at, updatedAt: at, updatedBy: null };
    await rulesRepository.insert(row);
    ruleIds.push(row.ruleId);
    return row;
  }

  async function login(displayName: string, userId = newUserId()): Promise<string> {
    const account = await accounts.upsert({ platform: "telegram", platformUserId: userId, displayName, username: null }, Date.now());
    accountIds.push(account.accountId);
    return userId;
  }

  /** Отправить буфер и дождаться, пока воркер запишет: строки читаются из базы. */
  async function settle(ruleId: string, expected: number): Promise<void> {
    await hits.flush();
    await expect.poll(async () => await counterOf(ruleId), { timeout: 10_000, interval: 100 }).toBe(expected);
  }

  async function counterOf(ruleId: string, day = today()): Promise<number> {
    const row = await prisma.nameRuleHitDay.findUnique({ where: { ruleId_day: { ruleId, day: new Date(`${day}T00:00:00Z`) } } });
    return row?.hits ?? 0;
  }

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 10);
    rulesRepository = new PrismaNameRulesRepository(prisma);
    repository = new PrismaNameRuleHitsRepository(prisma);
    hits = new NameRuleHits(config, new BullNameRuleHitsTransport(config), repository);
    hits.onApplicationBootstrap();
    const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    clients.push(redis);
    cache = new NameRulesCache(config, rulesRepository, redis);
    await cache.onModuleInit();
    accounts = new PrismaAccountRepository(prisma, cache, hits);
  });

  afterAll(async () => {
    await hits.onModuleDestroy();
    cache.onModuleDestroy();
    await prisma.nameRule.deleteMany({ where: { ruleId: { in: ruleIds } } });
    await prisma.account.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.$disconnect();
    for (const redis of clients) redis.disconnect();
  });

  it(
    "вход игрока с правилом brand: после сброса буфера строка (rule_id, сегодня, 1); второй вход того же игрока — 2",
    async () => {
      const brand = await addRule("brand", "exact", `бренд-${RUN}-а`);
      await cache.refresh();

      const userId = await login(`Вася бренд-${RUN}-а`);
      await settle(brand.ruleId, 1);
      await login(`Вася бренд-${RUN}-а`, userId);
      await settle(brand.ruleId, 2);

      const rows = await prisma.nameRuleHitDay.findMany({ where: { ruleId: brand.ruleId } });
      expect(rows).toHaveLength(1);
      // В таблице только правило, сутки и число: ни ника, ни аккаунта.
      expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["day", "hits", "ruleId"]);
    },
    TIMEOUT_MS,
  );

  it(
    "исключение, спасшее строку, считается своим ruleId (saved), а режущее правило — своим",
    async () => {
      const cut = await addRule("brand", "exact", `пр-${RUN}-б`);
      const kept = await addRule("allow", "exact", `пр-${RUN}-б-два`);
      await cache.refresh();

      await login(`Ира пр-${RUN}-б пр-${RUN}-б-два`);

      await settle(kept.ruleId, 1);
      expect(await counterOf(cut.ruleId)).toBe(1);
    },
    TIMEOUT_MS,
  );

  it(
    "закреплённый ник счётчик не трогает: вход аккаунта с nameLockedAt, где правило сработало бы, ничего не пишет",
    async () => {
      const brand = await addRule("brand", "exact", `бренд-${RUN}-в`);
      await cache.refresh();
      const userId = await login("Вася");
      const account = await prisma.account.findFirstOrThrow({ where: { platformUserId: userId } });
      await prisma.account.update({ where: { accountId: account.accountId }, data: { nameLockedAt: new Date() } });

      await login(`Вася бренд-${RUN}-в`, userId);
      await hits.flush();
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(await counterOf(brand.ruleId)).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    "names:clean и перечистка счётчик не меняют",
    async () => {
      const brand = await addRule("brand", "exact", `бренд-${RUN}-г`);
      // Ник с брендом уже лежит в базе: вход его не видел, а чистка перепишет.
      const userId = newUserId();
      const created = await prisma.account.create({
        data: { accountId: randomUUID(), platform: "telegram", platformUserId: userId, displayName: `Оля бренд-${RUN}-г`, platformName: `Оля бренд-${RUN}-г`, createdAt: new Date(), lastSeenAt: new Date() },
      });
      accountIds.push(created.accountId);
      await cache.refresh();

      const rules = await loadNameRuleSet(prisma);
      const result = await cleanAll(prisma, { dryRun: false }, {}, rules);
      expect(result.updated).toBeGreaterThanOrEqual(1);
      await hits.flush();
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(await counterOf(brand.ruleId)).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    "пачка с удалённым правилом записывается без ошибки: строки нет, остальные правила пачки учтены; удаление правила каскадом убирает его строки",
    async () => {
      const kept = await addRule("other", "exact", `пример-${RUN}-д`);
      const removed = await addRule("other", "exact", `пример-${RUN}-е`);
      await repository.addHits(today(), { [kept.ruleId]: 2, [removed.ruleId]: 3 });
      expect(await counterOf(removed.ruleId)).toBe(3);

      await rulesRepository.remove(removed.ruleId);
      expect(await prisma.nameRuleHitDay.count({ where: { ruleId: removed.ruleId } })).toBe(0);
      await expect(repository.addHits(today(), { [kept.ruleId]: 1, [removed.ruleId]: 5, [randomUUID()]: 7 })).resolves.toBeUndefined();

      expect(await counterOf(kept.ruleId)).toBe(3);
      expect(await prisma.nameRuleHitDay.count({ where: { ruleId: removed.ruleId } })).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    "addHits двух вызовов подряд складывает, а не затирает; два процесса разом — тоже",
    async () => {
      const rule = await addRule("other", "exact", `пример-${RUN}-ж`);
      await repository.addHits(today(), { [rule.ruleId]: 2 });
      await repository.addHits(today(), { [rule.ruleId]: 5 });
      expect(await counterOf(rule.ruleId)).toBe(7);

      await Promise.all(Array.from({ length: 6 }, () => repository.addHits(today(), { [rule.ruleId]: 1 })));
      expect(await counterOf(rule.ruleId)).toBe(13);
    },
    TIMEOUT_MS,
  );

  it(
    "prune: строки старше 180 суток исчезают, моложе остаются",
    async () => {
      const rule = await addRule("other", "exact", `пример-${RUN}-з`);
      const dayAgo = (days: number): string => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
      await repository.addHits(dayAgo(NAME_RULE_HITS_LIMITS.retentionDays + 5), { [rule.ruleId]: 1 });
      await repository.addHits(dayAgo(NAME_RULE_HITS_LIMITS.retentionDays - 5), { [rule.ruleId]: 1 });
      await repository.addHits(today(), { [rule.ruleId]: 1 });

      await repository.prune(NAME_RULE_HITS_LIMITS.retentionDays);

      const left = (await prisma.nameRuleHitDay.findMany({ where: { ruleId: rule.ruleId }, orderBy: { day: "asc" } })).map((row) => row.day.toISOString().slice(0, 10));
      expect(left).toEqual([dayAgo(NAME_RULE_HITS_LIMITS.retentionDays - 5), today()]);
    },
    TIMEOUT_MS,
  );

  it(
    "statsFor: окно, lastDay за всё время, правило без строк — ноль; trackedSince — первые сутки с данными",
    async () => {
      const busy = await addRule("other", "exact", `пример-${RUN}-и`);
      const idle = await addRule("other", "exact", `пример-${RUN}-к`);
      const dayAgo = (days: number): string => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
      await repository.addHits(dayAgo(40), { [busy.ruleId]: 4 });
      await repository.addHits(dayAgo(2), { [busy.ruleId]: 3 });

      const stats = await repository.statsFor(dayAgo(6));

      expect(stats.rules.find((rule) => rule.ruleId === busy.ruleId)).toEqual({ ruleId: busy.ruleId, hits: 3, lastDay: dayAgo(2) });
      expect(stats.rules.find((rule) => rule.ruleId === idle.ruleId)).toEqual({ ruleId: idle.ruleId, hits: 0, lastDay: null });
      expect(stats.trackedSince !== null && stats.trackedSince <= dayAgo(40)).toBe(true);
    },
    TIMEOUT_MS,
  );
});
