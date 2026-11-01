import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { cleanName } from "../src/modules/auth/display-name.js";
import { PrismaNameRuleCandidatesRepository } from "../src/modules/name-rules/name-rule-candidates.repository.js";
import { NameRuleCandidatesAdminService, NameRuleCandidatesService } from "../src/modules/name-rules/name-rule-candidates.service.js";
import type { NameRulesCache } from "../src/modules/name-rules/name-rules-cache.service.js";
import { PrismaNameRulesRepository, loadNameRuleSet } from "../src/modules/name-rules/name-rules.repository.js";
import { NameRulesService } from "../src/modules/name-rules/name-rules.service.js";
import { PrismaRolesRepository } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Кандидаты в правила имён на живых Postgres и Redis (tasks/T-0341, Р168):
 * ночной расчёт по настоящей таблице аккаунтов, хранение агрегата, замок,
 * «в стирания» и «не нужно». Без базы и Redis — пропуск. Слова уникальны на
 * прогон: таблица аккаунтов общая с соседними тестами, и в расчёт попадают
 * чужие ники, поэтому проверяются только свои слова.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 6);
const RUN = randomUUID().slice(0, 4);
const ALPHA = `alpha${RUN}`;
const BETA = `beta${RUN}`;
const GAMMA = `gamma${RUN}`;
const DAY = 86_400_000;
const OWNER_ID = "777000555";
const TIMEOUT_MS = 60_000;

describe.skipIf(DATABASE_URL === "" || REDIS_URL === "")("кандидаты в правила имён на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let repository: PrismaNameRuleCandidatesRepository;
  let service: NameRuleCandidatesService;
  const accountIds: string[] = [];
  const ruleIds: string[] = [];
  let ownerAccount: AccountRef;

  async function addAccounts(raw: string, count: number, seenDaysAgo = 1): Promise<string[]> {
    const ids: string[] = [];
    const rows = Array.from({ length: count }, () => {
      const accountId = randomUUID();
      ids.push(accountId);
      return {
        accountId,
        platform: "telegram" as const,
        platformUserId: `cand-${accountId.slice(0, 12)}`,
        displayName: "Игрок",
        platformName: raw,
        createdAt: new Date(Date.now() - seenDaysAgo * DAY),
        lastSeenAt: new Date(Date.now() - seenDaysAgo * DAY),
      };
    });
    await prisma.account.createMany({ data: rows });
    accountIds.push(...ids);
    return ids;
  }

  const mine = async () => await prisma.nameRuleCandidate.findMany({ where: { token: { contains: RUN } }, orderBy: [{ kind: "asc" }, { token: "asc" }] });

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL, REDIS_URL, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 10);
    redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    await redis.del("name-rules:candidates:lock");
    repository = new PrismaNameRuleCandidatesRepository(prisma);
    service = new NameRuleCandidatesService(prisma, redis, repository);
    const owner = await new PrismaAccountRepository(prisma).upsert({ platform: "telegram", platformUserId: OWNER_ID, displayName: "Владелец", username: null }, Date.now());
    ownerAccount = { accountId: owner.accountId, platform: owner.platform, platformUserId: owner.platformUserId };
    // Пока работает расчёт, ожидаются свои слова: строки прошлых прогонов не мешают, но и не нужны.
    await prisma.nameRuleCandidate.deleteMany({ where: { token: { contains: "alpha" } } });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await prisma.nameRuleCandidate.deleteMany({ where: { token: { contains: RUN } } });
    await prisma.nameRule.deleteMany({ where: { ruleId: { in: ruleIds } } });
    await prisma.account.deleteMany({ where: { accountId: { in: accountIds } } });
    await redis.del("name-rules:candidates:lock");
    await prisma.$disconnect();
    redis.disconnect();
  }, TIMEOUT_MS);

  it("25 ников со словами, 19 с одним словом и 5 вне окна: кандидатов три, у каждого 25 игроков; слово у 19 — нет", async () => {
    await addAccounts(`${ALPHA} ${BETA}`, 25);
    await addAccounts(GAMMA, 19);
    await addAccounts(`${ALPHA} ${BETA}`, 5, 31);

    const result = await service.run();

    expect(result.status).toBe("done");
    const rows = await mine();
    // Вид сортируется по порядку значений перечисления: слова раньше пар.
    expect(rows.map((row) => [row.kind, row.token, row.players])).toEqual([
      ["word", ALPHA, 25],
      ["word", BETA, 25],
      ["pair", `${ALPHA} ${BETA}`, 25],
    ]);
    expect(rows.every((row) => row.dismissedAt === null)).toBe(true);
  }, TIMEOUT_MS);

  it("в таблице нет столбца с аккаунтом и ника — только слово и число игроков", async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'name_rule_candidate'`;
    expect(columns.map((column) => column.column_name).sort()).toEqual(["candidate_id", "computed_at", "dismissed_at", "dismissed_by", "first_seen_at", "kind", "players", "token"]);
    expect(columns.some((column) => /account|nick|name$/u.test(column.column_name))).toBe(false);
  });

  it("повторный расчёт не двигает first_seen_at и обновляет число игроков", async () => {
    const before = await mine();
    await addAccounts(`${ALPHA} ${BETA}`, 2);

    await service.run();

    const after = await mine();
    expect(after.map((row) => row.players)).toEqual([27, 27, 27]);
    expect(after.map((row) => row.firstSeenAt.getTime())).toEqual(before.map((row) => row.firstSeenAt.getTime()));
    expect(after.every((row, index) => row.candidateId === before[index]?.candidateId)).toBe(true);
  }, TIMEOUT_MS);

  it("скрытый кандидат после повторного расчёта по-прежнему скрыт; упавшее ниже порога удалено; скрытое старше 90 суток забыто", async () => {
    const [beta] = (await mine()).filter((row) => row.token === BETA);
    await prisma.nameRuleCandidate.update({ where: { candidateId: beta?.candidateId ?? "" }, data: { dismissedAt: new Date(), dismissedBy: ownerAccount.accountId } });
    const before = await mine();

    await service.run();

    expect((await mine()).find((row) => row.token === BETA)?.dismissedAt).not.toBeNull();

    // Слова у 19 игроков не набирают порог: прошлая строка удаляется. Ники прежних 27 «уходят из окна».
    await prisma.account.updateMany({ where: { accountId: { in: accountIds }, platformName: `${ALPHA} ${BETA}` }, data: { lastSeenAt: new Date(Date.now() - 40 * DAY) } });
    await service.run();
    const left = await mine();
    expect(left.map((row) => row.token)).toEqual([BETA]);
    expect(before.length).toBe(3);

    // Скрытая строка живёт, пока её считали недавно; без пересчёта 90 суток — забыта.
    await prisma.nameRuleCandidate.updateMany({ where: { token: BETA }, data: { computedAt: new Date(Date.now() - 100 * DAY) } });
    await service.run();
    expect(await mine()).toEqual([]);
  }, TIMEOUT_MS);

  it("«В стирания»: правило в name_rule, кандидат удалён, ник со словом чистится", async () => {
    const word = `delta${RUN}`;
    await addAccounts(word, 21);
    await service.run();
    const candidate = (await mine()).find((row) => row.token === word);
    expect(candidate?.players).toBe(21);

    const roles = new RolesService(config, new PrismaRolesRepository(prisma), new PrismaAccountRepository(prisma));
    const nameRules = new NameRulesService(new PrismaNameRulesRepository(prisma), { publishChanged: async () => undefined } as unknown as NameRulesCache, roles);
    const admin = new NameRuleCandidatesAdminService(repository, roles, nameRules, redis);

    const rule = await admin.accept(ownerAccount, candidate?.candidateId ?? "", { category: "brand", kind: "word" });
    ruleIds.push(rule.ruleId);

    expect(await prisma.nameRule.findUnique({ where: { ruleId: rule.ruleId } })).toMatchObject({ category: "brand", kind: "word", pattern: word, active: true });
    expect((await mine()).some((row) => row.token === word)).toBe(false);
    const rules = await loadNameRuleSet(prisma);
    expect(cleanName(`Вася ${word}`, rules).name).toBe("Вася");
    const view = await admin.list(ownerAccount);
    expect(view.items.some((item) => item.token === word)).toBe(false);
  }, TIMEOUT_MS);

  it("два одновременных расчёта: один считает, второй пропускает", async () => {
    const other = new NameRuleCandidatesService(prisma, redis, repository);
    const results = await Promise.all([service.run(), other.run()]);
    expect(results.map((result) => result.status).sort()).toEqual(["done", "skipped"]);
    expect(await redis.get("name-rules:candidates:lock")).toBeNull();
    expect(JSON.parse((await redis.get("name-rules:candidates:last")) ?? "{}")).toHaveProperty("computedAt");
  }, TIMEOUT_MS);
});
