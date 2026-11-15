import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { LINK_CODE_PATTERN, LINK_CODE_TTL_SEC } from "../src/modules/external-identity/external-identity-rules.js";
import { PrismaExternalIdentityRepository } from "../src/modules/external-identity/external-identity.repository.js";
import { ExternalIdentityService } from "../src/modules/external-identity/external-identity.service.js";
import { RedisLinkCodes } from "../src/modules/external-identity/link-codes.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";
import { WIPE_PLAN } from "../src/modules/wipe/wipe-plan.js";
import { ExternalLinkStarters } from "../src/platforms/ports/external-link.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { uniquePlatformUserId } from "./helpers/player-ids.js";

/**
 * Связь аккаунта MAX и VK с игровым на настоящих Postgres и Redis
 * (docs/17-testing-strategy.md §4.2; docs/35-stage4-plan.md Р188,
 * tasks/T-0377). Адреса — TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL, без
 * них пропуск.
 *
 * Память этого не покажет: «один id площадки — один аккаунт» держит
 * уникальный индекс под гонкой двух ботов, а «код применяется один раз» —
 * атомарный `GETDEL`. Тест смотрит только на свои аккаунты и ключи; Redis
 * не чистится целиком — соседние файлы делят базу.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 4);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

/** Одну и ту же «площадку MAX» в этом файле представляет один стартер. */
const starters = new ExternalLinkStarters([
  { platform: "max", startUrl: (code) => `https://max.ru/rubezh_bot?start=${code}` },
  { platform: "vk", startUrl: (code) => `https://vk.com/rubezh_bot?start=${code}` },
]);

describe.skipIf(!live)("связь аккаунта MAX и VK с игровым на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let service: ExternalIdentityService;
  let repository: PrismaExternalIdentityRepository;
  const created: string[] = [];
  /** уникальный на прогон id «пользователя MAX»: общая база могла остаться от прошлого прогона */
  const run = randomUUID().slice(0, 8);
  let counter = 0;

  const maxUser = (): string => `max-${run}-${++counter}`;

  async function player(): Promise<AccountRef> {
    const accounts = new PrismaAccountRepository(prisma);
    const account = await accounts.upsert({ platform: "telegram", platformUserId: uniquePlatformUserId(), displayName: "Игрок", username: null, photoUrl: null }, Date.now());
    created.push(account.accountId);
    return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
  }

  /** Код, выданный аккаунту так же, как его выдаёт игровая ручка. */
  async function codeFor(account: AccountRef, platform: "max" | "vk" = "max"): Promise<string> {
    const { url } = await service.startLink(account, platform);
    return new URL(url).searchParams.get("start") ?? "";
  }

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    redis = createRedis(config);
    await redis.connect();
    repository = new PrismaExternalIdentityRepository(prisma);
    service = new ExternalIdentityService(repository, new RedisLinkCodes(redis), starters, new RateLimiter(redis), new PrismaAccountRepository(prisma));
  });

  afterEach(async () => {
    if (created.length === 0) return;
    // Каскад по внешнему ключу убирает и связи.
    await prisma.account.deleteMany({ where: { accountId: { in: created.splice(0) } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  it("первая связь — linked, повтор той же пары — already; id читается обратно", async () => {
    const me = await player();
    const id = maxUser();
    expect(await service.consume("max", await codeFor(me), id)).toBe("linked");
    expect(await service.consume("max", await codeFor(me), id)).toBe("already");
    expect(await service.externalId(me.accountId, "max")).toBe(id);
    expect(await service.externalId(me.accountId, "vk")).toBeNull();
    const row = await repository.find(me.accountId, "max");
    expect(row).toMatchObject({ accountId: me.accountId, platform: "max", externalUserId: id });
    expect(row?.linkedAt).toBeInstanceOf(Date);
  });

  it("MAX и VK — две отдельные связи одного аккаунта", async () => {
    const me = await player();
    const [maxId, vkId] = [maxUser(), `vk-${run}-${counter}`];
    expect(await service.consume("max", await codeFor(me, "max"), maxId)).toBe("linked");
    expect(await service.consume("vk", await codeFor(me, "vk"), vkId)).toBe("linked");
    expect(await service.externalId(me.accountId, "max")).toBe(maxId);
    expect(await service.externalId(me.accountId, "vk")).toBe(vkId);
  });

  it("тот же id MAX с другим аккаунтом — taken; у второго аккаунта связи нет", async () => {
    const [first, second] = [await player(), await player()];
    const id = maxUser();
    expect(await service.consume("max", await codeFor(first), id)).toBe("linked");
    expect(await service.consume("max", await codeFor(second), id)).toBe("taken");
    expect(await service.externalId(second.accountId, "max")).toBeNull();
    expect(await service.externalId(first.accountId, "max")).toBe(id);
  });

  it("тот же id на другой площадке — не занят: пара «площадка + id», а не просто id", async () => {
    const [first, second] = [await player(), await player()];
    const id = maxUser();
    expect(await service.consume("max", await codeFor(first, "max"), id)).toBe("linked");
    expect(await service.consume("vk", await codeFor(second, "vk"), id)).toBe("linked");
  });

  it("у аккаунта уже есть связь MAX, пришёл новый id MAX — taken, прежняя связь цела", async () => {
    const me = await player();
    const [first, second] = [maxUser(), maxUser()];
    expect(await service.consume("max", await codeFor(me), first)).toBe("linked");
    expect(await service.consume("max", await codeFor(me), second)).toBe("taken");
    expect(await service.externalId(me.accountId, "max")).toBe(first);
    // и второй id остался свободным для другого аккаунта
    const other = await player();
    expect(await service.consume("max", await codeFor(other), second)).toBe("linked");
  });

  it("два параллельных consume одного кода — ровно один linked, второй expired", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const me = await player();
      const code = await codeFor(me);
      const id = maxUser();
      const results = await Promise.all([service.consume("max", code, id), service.consume("max", code, id), service.consume("max", code, `${id}-x`)]);
      expect(results.filter((result) => result === "linked")).toHaveLength(1);
      expect(results.filter((result) => result === "expired")).toHaveLength(2);
      expect(await service.externalId(me.accountId, "max")).not.toBeNull();
    }
  });

  it("два аккаунта разом применяют коды с одним id MAX — один linked, другой taken", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const [first, second] = [await player(), await player()];
      const id = maxUser();
      const codes = [await codeFor(first), await codeFor(second)];
      const results = await Promise.all(codes.map((code) => service.consume("max", code, id)));
      expect([...results].sort()).toEqual(["linked", "taken"]);
      const owners = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM external_identity WHERE platform = 'max'::"Platform" AND external_user_id = ${id}`;
      expect(Number(owners[0]?.n)).toBe(1);
    }
  });

  it("один аккаунт разом применяет коды с двумя id MAX — одна связь остаётся", async () => {
    const me = await player();
    const [a, b] = [maxUser(), maxUser()];
    const codes = [await codeFor(me), await codeFor(me)];
    const results = await Promise.all([service.consume("max", codes[0] ?? "", a), service.consume("max", codes[1] ?? "", b)]);
    expect([...results].sort()).toEqual(["linked", "taken"]);
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM external_identity WHERE account_id = ${me.accountId}::uuid AND platform = 'max'::"Platform"`;
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("код лежит в Redis с сроком жизни до 30 минут и после применения исчезает", async () => {
    const me = await player();
    const code = await codeFor(me);
    expect(code).toMatch(LINK_CODE_PATTERN);
    const ttl = await redis.ttl(`ext-link:${code}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(LINK_CODE_TTL_SEC);
    expect(await service.consume("max", code, maxUser())).toBe("linked");
    expect(await redis.exists(`ext-link:${code}`)).toBe(0);
  });

  it("аккаунта нет в базе — expired, связь не создаётся", async () => {
    const me = await player();
    const code = await codeFor(me);
    await prisma.account.delete({ where: { accountId: me.accountId } });
    created.splice(created.indexOf(me.accountId), 1);
    expect(await service.consume("max", code, maxUser())).toBe("expired");
  });

  it("репозиторий сам не вставит связь без аккаунта", async () => {
    expect(await repository.link(randomUUID(), "max", maxUser())).toBe("missing");
  });

  it("удаление аккаунта уносит его связи, и id площадки освобождается вместе с ними", async () => {
    const [first, second] = [await player(), await player()];
    const id = maxUser();
    expect(await service.consume("max", await codeFor(first), id)).toBe("linked");
    await prisma.account.delete({ where: { accountId: first.accountId } });
    created.splice(created.indexOf(first.accountId), 1);
    expect(await repository.find(first.accountId, "max")).toBeNull();
    expect(await service.consume("max", await codeFor(second), id)).toBe("linked");
  });

  it("база сама отказывает в связи с Telegram и веб-версией: CHECK по площадке", async () => {
    const me = await player();
    for (const platform of ["telegram", "web"]) {
      await expect(
        prisma.$executeRaw`INSERT INTO external_identity (account_id, platform, external_user_id) VALUES (${me.accountId}::uuid, ${platform}::"Platform", ${maxUser()})`,
      ).rejects.toThrow();
    }
  });

  it("вайп игровой прогресс стирает, а связь остаётся: она постоянна (Р188), как привязки приглашения и источника", () => {
    expect(WIPE_PLAN.ExternalIdentity.action).toBe("keep");
  });
});
