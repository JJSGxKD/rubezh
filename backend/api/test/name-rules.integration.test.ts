import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanAll } from "../src/cli/display-names-clean.js";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { cleanName } from "../src/modules/auth/display-name.js";
import { NameRulesCache } from "../src/modules/name-rules/name-rules-cache.service.js";
import { PrismaNameRulesRepository, loadNameRuleSet, type StoredNameRule } from "../src/modules/name-rules/name-rules.repository.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Правила фильтра имён на живых Postgres и Redis (tasks/T-0338,
 * docs/17-testing-strategy.md §4.2): таблица и уникальность, две реплики
 * кэша, вход игрока и команда `names:clean` дают один ник. Без базы и Redis
 * — пропуск. Шаблоны уникальны на прогон: таблица общая с соседними тестами.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 4);
const RUN = randomUUID().slice(0, 4);
const BRAND = `бренд-${RUN}`;
const BAD_WORD = `слово-${RUN}`;
const CUT = `пр-${RUN}`;
const KEPT = `пр-${RUN}-два`;
const TIMEOUT_MS = 30_000;

describe.skipIf(DATABASE_URL === "" || REDIS_URL === "")("правила фильтра имён на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let repository: PrismaNameRulesRepository;
  const clients: Redis[] = [];
  const replicas: NameRulesCache[] = [];
  const ruleIds: string[] = [];
  const accountIds: string[] = [];

  function newUserId(): string {
    return String(500_000_000 + Math.floor(Math.random() * 400_000_000));
  }

  async function addRule(category: StoredNameRule["category"], kind: StoredNameRule["kind"], pattern: string): Promise<StoredNameRule> {
    const at = new Date();
    const row: StoredNameRule = { ruleId: randomUUID(), category, kind, pattern, active: true, note: null, createdAt: at, updatedAt: at, updatedBy: null };
    await repository.insert(row);
    ruleIds.push(row.ruleId);
    return row;
  }

  async function replica(): Promise<NameRulesCache> {
    const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    clients.push(redis);
    const cache = new NameRulesCache(config, repository, redis);
    await cache.onModuleInit();
    replicas.push(cache);
    return cache;
  }

  beforeAll(() => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 10);
    repository = new PrismaNameRulesRepository(prisma);
  });

  afterAll(async () => {
    for (const cache of replicas) cache.onModuleDestroy();
    await prisma.nameRule.deleteMany({ where: { ruleId: { in: ruleIds } } });
    await prisma.account.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.$disconnect();
    for (const redis of clients) redis.disconnect();
  });

  it("миграция создала таблицу; тройка (category, kind, pattern) уникальна, findByKey и count её видят", async () => {
    const pattern = `пример-уникальный-${RUN}`;
    const first = await addRule("other", "exact", pattern);
    expect(await repository.findByKey("other", "exact", pattern)).toMatchObject({ ruleId: first.ruleId, active: true });
    expect(await repository.findByKey("other", "word", pattern)).toBeNull();
    expect(await repository.count()).toBeGreaterThanOrEqual(1);

    await expect(addRule("other", "exact", pattern)).rejects.toThrow();
    // Та же фраза в другой категории — другое правило.
    await expect(addRule("ads", "exact", pattern)).resolves.toBeDefined();
  });

  it("update и remove: возвращают строку и признак; чужого id нет", async () => {
    const row = await addRule("other", "exact", `пример-правка-${RUN}`);
    const changed = await repository.update(row.ruleId, { active: false, note: "пауза" }, new Date(), null);
    expect(changed).toMatchObject({ ruleId: row.ruleId, active: false, note: "пауза" });
    expect((await repository.listActive()).some((item) => item.ruleId === row.ruleId)).toBe(false);
    expect((await repository.list()).some((item) => item.ruleId === row.ruleId)).toBe(true);
    expect(await repository.update(randomUUID(), { active: true }, new Date(), null)).toBeNull();
    expect(await repository.remove(row.ruleId)).toBe(true);
    expect(await repository.remove(row.ruleId)).toBe(false);
  });

  it("loadNameRuleSet читает активные правила и пропускает битое с причиной", async () => {
    const good = await addRule("brand", "exact", `пример-загрузка-${RUN}`);
    const broken = await addRule("ads", "regex", "(");
    const invalid: string[] = [];

    const set = await loadNameRuleSet(prisma, (def) => invalid.push(def.ruleId));

    expect(invalid).toContain(broken.ruleId);
    expect(cleanName(`Вася ${good.pattern}`, set).name).toBe("Вася");
    // Битое правило не оставляем: оно мешало бы соседним тестам предупреждением в логе.
    await repository.remove(broken.ruleId);
    await repository.remove(good.ruleId);
  });

  it(
    "две реплики на одной базе и одном Redis: правка с publishChanged видна другой за 2 с, не дожидаясь минуты",
    async () => {
      const first = await replica();
      const second = await replica();
      expect(cleanName(`Вася ${BRAND}`, second.current()).name).toBe(`Вася ${BRAND}`);

      const rule = await addRule("brand", "exact", BRAND);
      await first.publishChanged(rule.ruleId);

      await expect.poll(() => cleanName(`Вася ${BRAND}`, second.current()).name, { timeout: 2_000 }).toBe("Вася");
    },
    TIMEOUT_MS,
  );

  it(
    "вход: правило brand режет ник, platformName хранит исходник; закреплённый ник правило не меняет",
    async () => {
      const cache = await replica();
      await cache.refresh();
      const accounts = new PrismaAccountRepository(prisma, cache);
      const raw = `Вася ${BRAND}`;

      const account = await accounts.upsert({ platform: "telegram", platformUserId: newUserId(), displayName: raw, username: null }, Date.now());
      accountIds.push(account.accountId);

      expect(account.displayName).toBe("Вася");
      const stored = await prisma.account.findUniqueOrThrow({ where: { accountId: account.accountId } });
      expect(stored.displayName).toBe("Вася");
      expect(stored.platformName).toBe(raw);

      await prisma.account.update({ where: { accountId: account.accountId }, data: { displayName: "Главная Оля", nameLockedAt: new Date() } });
      const again = await accounts.upsert({ platform: "telegram", platformUserId: account.platformUserId, displayName: raw, username: null }, Date.now());
      expect(again.displayName).toBe("Главная Оля");
      expect((await prisma.account.findUniqueOrThrow({ where: { accountId: account.accountId } })).platformName).toBe(raw);
    },
    TIMEOUT_MS,
  );

  it(
    "один результат: ник после входа равен нику после names:clean с теми же правилами, второй проход — planned 0",
    async () => {
      await addRule("profanity", "exact", BAD_WORD);
      await addRule("brand", "exact", CUT);
      await addRule("allow", "exact", KEPT);
      const cache = await replica();
      await cache.refresh();
      const rules = cache.current();
      const accounts = new PrismaAccountRepository(prisma, cache);

      const names: [string, string | null][] = [
        ["Вася", null],
        [`Оля ${BRAND}`, null],
        [`Петя ${BAD_WORD}`, "petya"],
        [`Гена ${BAD_WORD}`, null],
        [`Ира ${KEPT}`, null],
        [`Ира ${CUT} ${KEPT}`, null],
        [`${BRAND}`, "tolik"],
        [`${BRAND} ${CUT}`, null],
      ];
      const loggedIn = new Map<string, string>();
      const byRaw = new Map<string, string>();
      for (const [raw, username] of names) {
        const account = await accounts.upsert({ platform: "telegram", platformUserId: newUserId(), displayName: raw, username }, Date.now());
        accountIds.push(account.accountId);
        loggedIn.set(account.accountId, account.displayName);
        byRaw.set(raw, account.displayName);
      }
      expect(byRaw.get("Вася")).toBe("Вася");
      expect(byRaw.get(`Оля ${BRAND}`)).toBe("Оля");
      expect(byRaw.get(`Петя ${BAD_WORD}`)).toBe("petya");
      expect(byRaw.get(`Гена ${BAD_WORD}`)).toMatch(/^Игрок \d{4}$/u);
      expect(byRaw.get(`Ира ${KEPT}`)).toBe(`Ира ${KEPT}`);
      expect(byRaw.get(`Ира ${CUT} ${KEPT}`)).toBe(`Ира ${KEPT}`);
      expect(byRaw.get(BRAND)).toBe("tolik");
      expect(byRaw.get(`${BRAND} ${CUT}`)).toMatch(/^Игрок \d{4}$/u);

      // Старые аккаунты: ник в базе устарел, команда должна прийти к тому же.
      const mine = [...loggedIn.keys()];
      await prisma.account.updateMany({ where: { accountId: { in: mine } }, data: { displayName: "Устаревший" } });

      // Команда идёт по всей таблице, а в ней есть чужие строки соседних тестов — смотрим только свои.
      const scoped = {
        account: {
          findMany: (args: Parameters<PrismaClient["account"]["findMany"]>[0]) => prisma.account.findMany({ ...args, where: { AND: [args?.where ?? {}, { accountId: { in: mine } }] } }),
          updateMany: (args: Parameters<PrismaClient["account"]["updateMany"]>[0]) => prisma.account.updateMany(args),
        },
        $transaction: (writes: Parameters<PrismaClient["$transaction"]>[0]) => prisma.$transaction(writes as never),
      } as unknown as PrismaClient;

      const first = await cleanAll(scoped, { dryRun: false }, {}, rules);
      expect(first).toMatchObject({ scanned: mine.length, planned: mine.length, updated: mine.length });
      for (const [accountId, expected] of loggedIn) {
        expect((await prisma.account.findUniqueOrThrow({ where: { accountId } })).displayName, accountId).toBe(expected);
      }

      const second = await cleanAll(scoped, { dryRun: false }, {}, rules);
      expect(second).toMatchObject({ scanned: mine.length, planned: 0, updated: 0 });
    },
    TIMEOUT_MS,
  );
});
