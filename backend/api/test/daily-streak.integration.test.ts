import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { AdNetworkKeys } from "../src/modules/ads/ad-network-keys.js";
import { AdPasses } from "../src/modules/ads/ads-passes.js";
import { InterstitialGate } from "../src/modules/ads/interstitial-gate.js";
import { PrismaAdsRepository, type AdBlockRow } from "../src/modules/ads/ads.repository.js";
import { AdsService } from "../src/modules/ads/ads.service.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { DailyDoubleService } from "../src/modules/daily/daily-double.service.js";
import { dailyReward } from "../src/modules/daily/daily-rules.js";
import { PrismaDailyDoubleRepository, PrismaDailyRepository } from "../src/modules/daily/daily.repository.js";
import { DailyService } from "../src/modules/daily/daily.service.js";
import type { ProgressService } from "../src/modules/progress/progress.service.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { FakeCreatives, adBlock, flagsOn } from "./helpers/memory-ads.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { restrictionsGate } from "./helpers/memory-restrictions.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { uniquePlatformUserId } from "./helpers/player-ids.js";
import { panelSettings } from "./helpers/settings.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Серия дней на живом Postgres с настоящим кошельком (tasks/T-0262;
 * docs/17-testing-strategy.md §4.2; адрес — TEST_DATABASE_URL, без него
 * пропуск): ступень растёт по московским суткам, пропуск снимает две ступени
 * за день, колонка держит границы, удвоение за ролик удваивает умноженное, а
 * потолок кошелька `daily_reward` выдерживает самый щедрый день.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const HOUR = 3_600_000;
/** среда, 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));
const dayAfter = (days: number) => new Date(NOON.getTime() + days * 24 * HOUR);

/** Сессии пишутся в живую базу, а блоки для выдачи берутся из памяти: общие сети в базе из теста включать нельзя. */
class ServedRepository extends PrismaAdsRepository {
  override async activeBlocks(): Promise<AdBlockRow[]> {
    return [adBlock("adsgram", 10, { place: "daily_double" })];
  }
}

describe.skipIf(DATABASE_URL === "")("серия дней на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let adsRepository: PrismaAdsRepository;
  let wallet: WalletService;
  let dailyRepository: PrismaDailyRepository;
  let doubleRepository: PrismaDailyDoubleRepository;
  const network = `strk_${randomBytes(4).toString("hex")}`;
  let block: AdBlockRow;

  async function account(): Promise<string> {
    const created = await accounts.upsert({ platform: "telegram", platformUserId: uniquePlatformUserId(), displayName: "Серия", username: null }, Date.now());
    return created.accountId;
  }

  function services(level = 1) {
    const settings = panelSettings();
    const ads = new AdsService(new ServedRepository(prisma), () => 0, new AdPasses(), settings, new FakeCreatives(), new AdNetworkKeys(adsRepository), new InterstitialGate(adsRepository, flagsOn(), settings), restrictionsGate());
    const progress = { view: async () => ({ level }) } as unknown as ProgressService;
    return { daily: new DailyService(dailyRepository, progress, wallet), double: new DailyDoubleService(dailyRepository, doubleRepository, progress, wallet, ads, settings) };
  }

  async function watched(accountId: string, time: Date): Promise<string> {
    const sessionId = randomBytes(12).toString("base64url");
    await adsRepository.createSession({ sessionId, accountId, place: "daily_double", block, creative: null, createdAt: time, expiresAt: new Date(time.getTime() + 30 * 60_000) });
    await adsRepository.report(sessionId, accountId, { kind: "completed" }, new Date(time.getTime() + 60_000));
    return sessionId;
  }

  const balances = async (accountId: string) => {
    const all = await wallet.balances(accountId);
    return { coins: all.coins, shards: all.shard_common };
  };

  const storedStreak = async (accountId: string): Promise<number | undefined> => {
    const [row] = await prisma.$queryRaw<{ streak: number }[]>`SELECT streak FROM daily_reward WHERE account_id = ${accountId}::uuid`;
    return row?.streak;
  };

  /** строка награды дня «как после забора»: `claimed` дней, последний забор — за `daysAgo` суток до `time` */
  async function seed(accountId: string, claimed: number, streak: number, daysAgo: number, time = NOON): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO daily_reward (account_id, claimed_days, last_claim_day, streak, updated_at)
      VALUES (${accountId}::uuid, ${claimed}::int, ((${time}::timestamptz AT TIME ZONE 'Europe/Moscow')::date - ${daysAgo}::int), ${streak}::smallint, ${time})`;
  }

  beforeAll(async () => {
    const config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 20);
    accounts = new PrismaAccountRepository(prisma);
    adsRepository = new PrismaAdsRepository(prisma);
    dailyRepository = new PrismaDailyRepository(prisma);
    doubleRepository = new PrismaDailyDoubleRepository(prisma);
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    await prisma.$executeRaw`INSERT INTO ad_network (network_key, name, active, priority, updated_at) VALUES (${network}, 'Проверка серии', true, 5, now())`;
    const blockId = randomUUID();
    await prisma.$executeRaw`
      INSERT INTO ad_block (block_id, network_key, place, external_id, success, platforms, devices, created_at, updated_at)
      VALUES (${blockId}::uuid, ${network}, 'daily_double'::"AdPlace", 'ext-daily_double', 'view'::"AdSuccess", ARRAY['telegram']::"Platform"[], ARRAY['android']::varchar(16)[], now(), now())`;
    block = { blockId, networkKey: network, place: "daily_double", externalId: "ext-daily_double", success: "view", priority: 5, networkKeys: {}, platforms: ["telegram"], devices: ["android"] };
  });

  afterAll(async () => {
    await prisma.$executeRaw`UPDATE ad_block SET active = false WHERE network_key = ${network}`;
    await prisma.$executeRaw`UPDATE ad_network SET active = false WHERE network_key = ${network}`;
    await prisma.$disconnect();
  });

  it("три дня подряд — награда третьего ×1,15, ступень лежит в строке", async () => {
    const me = await account();
    const { daily } = services();
    expect(await daily.claim(me, NOON)).toMatchObject({ claimed: true, coins: 63 });
    expect(await storedStreak(me)).toBe(1);
    expect(await daily.claim(me, dayAfter(1))).toMatchObject({ claimed: true, coins: 88 });
    const third = await daily.claim(me, dayAfter(2));
    expect(third).toMatchObject({ claimed: true, coins: 115 });
    expect(third.view.streak).toEqual({ days: 3, bonusPercent: 15, next: 4 });
    expect(await storedStreak(me)).toBe(3);
    expect(await balances(me)).toEqual({ coins: 63 + 88 + 115, shards: 0 });
  });

  it("граница суток по Москве: 23:59 и 00:01 — подряд, серия растёт", async () => {
    const me = await account();
    const { daily } = services();
    await daily.claim(me, new Date(Date.UTC(2026, 8, 30, 20, 59)));
    await daily.claim(me, new Date(Date.UTC(2026, 8, 30, 21, 1)));
    expect(await storedStreak(me)).toBe(2);
  });

  it("пропуск дня снимает две ступени и не обнуляет: серия 3, день пропущен — 2", async () => {
    const me = await account();
    const { daily } = services();
    await seed(me, 3, 3, 2);
    const claimed = await daily.claim(me, NOON);
    expect(claimed).toMatchObject({ claimed: true, coins: dailyReward(4, 1, undefined, 2).coins });
    expect(await storedStreak(me)).toBe(2);
  });

  it("пропуск двух и более дней: с 10 за три дня пропуска — 5, за десять — 1", async () => {
    const first = await account();
    await seed(first, 20, 10, 4);
    await services().daily.claim(first, NOON);
    expect(await storedStreak(first)).toBe(5);

    const second = await account();
    await seed(second, 20, 10, 11);
    await services().daily.claim(second, NOON);
    expect(await storedStreak(second)).toBe(1);
  });

  it("повтор забора в те же сутки и гонка заборов — серия растёт один раз", async () => {
    const me = await account();
    const { daily } = services();
    await seed(me, 5, 4, 1);
    const results = await Promise.all(Array.from({ length: 5 }, () => daily.claim(me, NOON)));
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(await storedStreak(me)).toBe(5);
    expect(await daily.claim(me, at(NOON, 3))).toMatchObject({ claimed: false, coins: 0 });
    expect(await storedStreak(me)).toBe(5);
  });

  it("колонка держит границы: ступень от нуля до десяти", async () => {
    const me = await account();
    await expect(seed(me, 1, 11, 1)).rejects.toThrow();
    await expect(seed(me, 1, -1, 1)).rejects.toThrow();
    await seed(me, 1, 10, 1);
    expect(await storedStreak(me)).toBe(10);
  });

  it("удвоение за ролик удваивает уже умноженное на серию", async () => {
    const me = await account();
    const { daily, double } = services();
    await seed(me, 6, 9, 1);
    expect(await daily.claim(me, NOON)).toMatchObject({ coins: 450, shards: 15 });
    const result = await double.double({ accountId: me, platform: "telegram" }, await watched(me, NOON), at(NOON, 2));
    expect(result.credited).toEqual({ coins: 450, shards: 15 });
    expect(await balances(me)).toEqual({ coins: 900, shards: 30 });
  });

  it("кошелёк начисляет без упора в потолок самый щедрый день: сотый уровень, серия +50 %, удвоение", async () => {
    const me = await account();
    const { daily, double } = services(100);
    await seed(me, 34, 9, 1);
    const expected = dailyReward(35, 100, undefined, 10);
    expect(await daily.claim(me, NOON)).toMatchObject({ claimed: true, ...expected });
    const result = await double.double({ accountId: me, platform: "telegram" }, await watched(me, NOON), at(NOON, 2));
    expect(result.credited).toEqual(expected);
    expect(await balances(me)).toEqual({ coins: expected.coins * 2, shards: expected.shards * 2 });
    expect(expected.coins * 2).toBeLessThan(5_000);
    expect(expected.shards * 2).toBeLessThan(100);
  });
});

function at(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}
