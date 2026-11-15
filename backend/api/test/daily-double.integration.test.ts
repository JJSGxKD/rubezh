import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { AdNetworkKeys } from "../src/modules/ads/ad-network-keys.js";
import { AdPasses } from "../src/modules/ads/ads-passes.js";
import { InterstitialGate } from "../src/modules/ads/interstitial-gate.js";
import type { AdPlace } from "../src/modules/ads/ads-rules.js";
import { PrismaAdsRepository, type AdBlockRow } from "../src/modules/ads/ads.repository.js";
import { AdsService, type AdViewer } from "../src/modules/ads/ads.service.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { DailyDoubleService, type DailyDoublePlayer } from "../src/modules/daily/daily-double.service.js";
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
 * Награда дня ×2 на живом Postgres с настоящим кошельком и модулем рекламы
 * (docs/17-testing-strategy.md §4.2; адрес — TEST_DATABASE_URL, без него
 * пропуск; tasks/T-0242): раз в московские сутки, одна запись под гонкой,
 * сессия показа — одна на удвоение, дневной кап роликов (T-0241) и пропуск
 * VIP. Память этого не покажет: ключи таблицы и граница суток — у базы.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const RACE_TIMEOUT_MS = 30_000;
const MINUTE = 60_000;
/** среда, 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));
const NEXT_NOON = new Date(NOON.getTime() + 24 * 60 * MINUTE);
const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * MINUTE);
const CAP_KEY = "ads.rewarded.daily-cap";

/**
 * Сессии пишутся в живую базу, а блоки для выдачи берутся из памяти: общие
 * сети в базе из теста включать нельзя — их читают соседние тесты.
 */
class ServedRepository extends PrismaAdsRepository {
  override async activeBlocks(): Promise<AdBlockRow[]> {
    return [adBlock("adsgram", 10, { place: "daily_double" }), adBlock("adsgram", 10, { place: "wheel_spin" })];
  }
}

describe.skipIf(DATABASE_URL === "")("награда дня ×2 на живом Postgres", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let adsRepository: PrismaAdsRepository;
  let wallet: WalletService;
  let dailyRepository: PrismaDailyRepository;
  let doubleRepository: PrismaDailyDoubleRepository;
  /** свои сеть и блоки теста: общие из миграции выключены, чужие тесты наши не трогают */
  const network = `dbl_${randomBytes(4).toString("hex")}`;
  const blocks = new Map<AdPlace, AdBlockRow>();

  async function account(): Promise<string> {
    const created = await accounts.upsert({ platform: "telegram", platformUserId: uniquePlatformUserId(), displayName: "Двойник", username: null }, Date.now());
    return created.accountId;
  }

  function services(settings = panelSettings()) {
    const passes = new AdPasses();
    const ads = new AdsService(new ServedRepository(prisma), () => 0, passes, settings, new FakeCreatives(), new AdNetworkKeys(adsRepository), new InterstitialGate(adsRepository, flagsOn(), settings), restrictionsGate());
    const progress = { view: async () => ({ level: 1 }) } as unknown as ProgressService;
    const daily = new DailyService(dailyRepository, progress, wallet);
    const double = new DailyDoubleService(dailyRepository, doubleRepository, progress, wallet, ads, settings);
    return { ads, passes, daily, double, settings };
  }

  const player = (accountId: string): DailyDoublePlayer => ({ accountId, platform: "telegram" });
  const viewer = (accountId: string): AdViewer => ({ accountId, platform: "telegram", device: "android" });

  /** Игрок пришёл на седьмой день недели: шесть дней забрано до вчера, сегодня забирает настоящий сервис. */
  async function atSeventhDay(accountId: string, daily: DailyService, time = NOON): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO daily_reward (account_id, claimed_days, last_claim_day, updated_at)
      VALUES (${accountId}::uuid, 6, ((${time}::timestamptz AT TIME ZONE 'Europe/Moscow')::date - 1), ${time})`;
    const claimed = await daily.claim(accountId, time);
    expect(claimed).toMatchObject({ claimed: true, coins: 300, shards: 10 });
  }

  /** Досмотренная сессия места: выдача показа и досмотр от SDK. */
  async function watched(accountId: string, place: AdPlace = "daily_double", time = NOON): Promise<string> {
    const sessionId = randomBytes(12).toString("base64url");
    const block = blocks.get(place);
    if (block === undefined) throw new Error(`нет блока ${place}`);
    await adsRepository.createSession({ sessionId, accountId, place, block, creative: null, createdAt: time, expiresAt: at(time, 30) });
    await adsRepository.report(sessionId, accountId, { kind: "completed" }, at(time, 1));
    return sessionId;
  }

  const balances = async (accountId: string) => {
    const all = await wallet.balances(accountId);
    return { coins: all.coins, shards: all.shard_common };
  };

  async function sessionStatus(sessionId: string): Promise<{ status: string; claimed: boolean }> {
    const [row] = await prisma.$queryRaw<{ status: string; claimed: boolean }[]>`SELECT status::text, claimed_at IS NOT NULL AS claimed FROM ad_session WHERE session_id = ${sessionId}`;
    if (row === undefined) throw new Error("сессии нет");
    return row;
  }

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 20);
    accounts = new PrismaAccountRepository(prisma);
    adsRepository = new PrismaAdsRepository(prisma);
    dailyRepository = new PrismaDailyRepository(prisma);
    doubleRepository = new PrismaDailyDoubleRepository(prisma);
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    await prisma.$executeRaw`INSERT INTO ad_network (network_key, name, active, priority, updated_at) VALUES (${network}, 'Проверка удвоения', true, 5, now())`;
    for (const place of ["daily_double", "wheel_spin"] as const) {
      const blockId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO ad_block (block_id, network_key, place, external_id, success, platforms, devices, created_at, updated_at)
        VALUES (${blockId}::uuid, ${network}, ${place}::"AdPlace", ${`ext-${place}`}, 'view'::"AdSuccess", ARRAY['telegram']::"Platform"[], ARRAY['android']::varchar(16)[], now(), now())`;
      blocks.set(place, { blockId, networkKey: network, place, externalId: `ext-${place}`, success: "view", priority: 5, networkKeys: {}, platforms: ["telegram"], devices: ["android"] });
    }
  });

  afterAll(async () => {
    await prisma.$executeRaw`UPDATE ad_block SET active = false WHERE network_key = ${network}`;
    await prisma.$executeRaw`UPDATE ad_network SET active = false WHERE network_key = ${network}`;
    await prisma.$disconnect();
  });

  it("забор седьмого дня, ролик — и ещё столько же на кошелёк; запись суток и сессии лежит в базе", async () => {
    const me = await account();
    const { daily, double } = services();
    await atSeventhDay(me, daily);
    expect(await balances(me)).toEqual({ coins: 300, shards: 10 });
    const sessionId = await watched(me);

    const result = await double.double(player(me), sessionId, at(NOON, 2));
    expect(result.credited).toEqual({ coins: 300, shards: 10 });
    expect(result.view).toEqual({ status: "doubled", coins: 300, shards: 10 });
    expect(await balances(me)).toEqual({ coins: 600, shards: 20 });

    const [row] = await prisma.$queryRaw<{ day_number: number; session_id: string; coins: number; shards: number; game_day: string }[]>`
      SELECT day_number, session_id, coins, shards, game_day::text FROM daily_double WHERE account_id = ${me}::uuid`;
    expect(row).toEqual({ day_number: 7, session_id: sessionId, coins: 300, shards: 10, game_day: "2026-09-30" });
    expect(await sessionStatus(sessionId)).toMatchObject({ claimed: true });
    // В журнале кошелька — причина награды дня, источник и ключ удвоения.
    const entries = await prisma.$queryRaw<{ reason: string; source: string; idempotency_key: string }[]>`
      SELECT reason::text, source, idempotency_key FROM wallet_entry WHERE account_id = ${me}::uuid AND source = 'daily:7:double' ORDER BY idempotency_key`;
    expect(entries).toEqual([
      { reason: "daily_reward", source: "daily:7:double", idempotency_key: `daily:${me}:7:double` },
      { reason: "daily_reward", source: "daily:7:double", idempotency_key: `daily:${me}:7:double:shards` },
    ]);
  });

  it("повтор той же сессией — тот же ответ, второго начисления нет", async () => {
    const me = await account();
    const { daily, double } = services();
    await atSeventhDay(me, daily);
    const sessionId = await watched(me);
    const first = await double.double(player(me), sessionId, at(NOON, 2));
    const again = await double.double(player(me), sessionId, at(NOON, 3));

    expect(again).toEqual(first);
    expect(await balances(me)).toEqual({ coins: 600, shards: 20 });
    const [count] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM daily_double WHERE account_id = ${me}::uuid`;
    expect(count?.n).toBe(1);
  });

  it("вторая сессия в тот же день — 409 daily_already_doubled, и сессия не потрачена", async () => {
    const me = await account();
    const { daily, double } = services();
    await atSeventhDay(me, daily);
    await double.double(player(me), await watched(me), at(NOON, 2));
    const second = await watched(me);

    await expect(double.double(player(me), second, at(NOON, 3))).rejects.toMatchObject({ code: "daily_already_doubled", status: 409 });
    expect(await sessionStatus(second)).toMatchObject({ claimed: false });
    expect(await balances(me)).toEqual({ coins: 600, shards: 20 });
  });

  it("до забора награды — 409 daily_not_claimed, сессия не потрачена и годится после забора", async () => {
    const me = await account();
    const { daily, double } = services();
    const sessionId = await watched(me);
    await expect(double.double(player(me), sessionId, at(NOON, 2))).rejects.toMatchObject({ code: "daily_not_claimed", status: 409 });
    expect(await sessionStatus(sessionId)).toMatchObject({ claimed: false });
    expect(await balances(me)).toEqual({ coins: 0, shards: 0 });

    await atSeventhDay(me, daily, at(NOON, 3));
    await expect(double.double(player(me), sessionId, at(NOON, 4))).resolves.toMatchObject({ credited: { coins: 300, shards: 10 } });
  });

  it("вчерашний забор сегодня не удваивается, а новые сутки открывают новое удвоение", async () => {
    const me = await account();
    const { daily, double } = services();
    await atSeventhDay(me, daily);
    await double.double(player(me), await watched(me), at(NOON, 2));

    const stale = await watched(me, "daily_double", NEXT_NOON);
    await expect(double.double(player(me), stale, NEXT_NOON)).rejects.toMatchObject({ code: "daily_not_claimed" });
    expect(await double.view(player(me), NEXT_NOON)).toEqual({ status: "unavailable" });

    expect(await daily.claim(me, NEXT_NOON)).toMatchObject({ claimed: true });
    const result = await double.double(player(me), stale, NEXT_NOON);
    expect(result.credited.coins).toBeGreaterThan(0);
    const [count] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM daily_double WHERE account_id = ${me}::uuid`;
    expect(count?.n).toBe(2);
  });

  it("граница суток — полночь по Москве, посчитанная базой: 23:59 и 00:01 — разные удвоения", async () => {
    const me = await account();
    const lateEvening = new Date(Date.UTC(2026, 8, 30, 20, 59));
    const afterMidnight = new Date(Date.UTC(2026, 8, 30, 21, 1));
    expect(await doubleRepository.record({ accountId: me, sessionId: randomBytes(12).toString("base64url"), dayNumber: 3, coins: 10, shards: 0 }, lateEvening)).toBe("granted");
    expect(await doubleRepository.today(me, lateEvening)).toMatchObject({ dayNumber: 3, coins: 10 });
    expect(await doubleRepository.today(me, afterMidnight)).toBeNull();
    expect(await doubleRepository.record({ accountId: me, sessionId: randomBytes(12).toString("base64url"), dayNumber: 4, coins: 20, shards: 0 }, afterMidnight)).toBe("granted");
  });

  it("чужая сессия и сессия чужого места не годятся, начисления нет", async () => {
    const me = await account();
    const stranger = await account();
    const { daily, double } = services();
    await atSeventhDay(me, daily);

    await expect(double.double(player(me), await watched(stranger), at(NOON, 2))).rejects.toMatchObject({ code: "ad_session_closed" });
    await expect(double.double(player(me), await watched(me, "wheel_spin"), at(NOON, 2))).rejects.toMatchObject({ code: "ad_session_closed" });
    expect(await balances(me)).toEqual({ coins: 300, shards: 10 });
    expect(await doubleRepository.today(me, NOON)).toBeNull();
  });

  it("VIP с пропуском удваивает без ролика, и ролик в кап не идёт", async () => {
    const me = await account();
    const { daily, double, ads, passes } = services();
    passes.register("vip", async (accountId) => accountId === me);
    await atSeventhDay(me, daily);
    expect(await double.view(player(me), NOON)).toMatchObject({ status: "available", ad: { available: true, pass: "vip", capped: false } });

    const offer = await ads.offer(viewer(me), "daily_double", NOON);
    if (!offer.available) throw new Error(`показа нет: ${offer.reason}`);
    expect(offer.pass).toBe("vip");
    await expect(double.double(player(me), offer.sessionId, at(NOON, 1))).resolves.toMatchObject({ credited: { coins: 300, shards: 10 } });
    expect(await adsRepository.rewardedWatchedToday(me, at(NOON, 2))).toBe(0);
  });

  it("кап роликов T-0241 достигнут — ad.capped: true; забор сверх капа — 409 ad_daily_cap, запись не появляется", async () => {
    const me = await account();
    const { daily, double } = services(panelSettings({ [CAP_KEY]: 2 }));
    await atSeventhDay(me, daily);
    const wheel = [await watched(me, "wheel_spin"), await watched(me, "wheel_spin")];
    expect(await double.view(player(me), at(NOON, 2))).toMatchObject({ status: "available", ad: { available: false, capped: true } });

    const session = await watched(me);
    for (const sessionId of wheel) await adsRepository.claim(sessionId, me, "wheel_spin", at(NOON, 2), () => ({ kind: "allow" }));
    await expect(double.double(player(me), session, at(NOON, 3))).rejects.toMatchObject({ code: "ad_daily_cap", status: 409 });
    expect(await doubleRepository.today(me, NOON)).toBeNull();
    expect(await balances(me)).toEqual({ coins: 300, shards: 10 });
  });

  it(
    "шесть запросов разом разными сессиями — удвоено один раз, кошелёк получил награду однажды",
    async () => {
      const me = await account();
      const { daily, double } = services();
      await atSeventhDay(me, daily);
      const sessions = await Promise.all(Array.from({ length: 6 }, () => watched(me)));
      const results = await Promise.allSettled(sessions.map((sessionId) => double.double(player(me), sessionId, at(NOON, 2))));

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "daily_already_doubled" });
      expect(await balances(me)).toEqual({ coins: 600, shards: 20 });
      const [count] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM daily_double WHERE account_id = ${me}::uuid`;
      expect(count?.n).toBe(1);
    },
    RACE_TIMEOUT_MS,
  );

  it(
    "шесть запросов разом одной сессией — одно начисление, все получают ответ",
    async () => {
      const me = await account();
      const { daily, double } = services();
      await atSeventhDay(me, daily);
      const sessionId = await watched(me);
      const results = await Promise.all(Array.from({ length: 6 }, () => double.double(player(me), sessionId, at(NOON, 2))));

      for (const result of results) expect(result.credited).toEqual({ coins: 300, shards: 10 });
      expect(await balances(me)).toEqual({ coins: 600, shards: 20 });
    },
    RACE_TIMEOUT_MS,
  );

  it("база не примет вторую запись суток, вторую запись той же сессии и сессию без игрока; удаление аккаунта убирает запись", async () => {
    const me = await account();
    const sessionId = randomBytes(12).toString("base64url");
    await prisma.$executeRaw`
      INSERT INTO daily_double (account_id, game_day, day_number, session_id, coins, shards, created_at)
      VALUES (${me}::uuid, '2026-09-30', 7, ${sessionId}, 300, 10, ${NOON})`;
    await expect(prisma.$executeRaw`
      INSERT INTO daily_double (account_id, game_day, day_number, session_id, coins, shards, created_at)
      VALUES (${me}::uuid, '2026-09-30', 7, ${randomBytes(12).toString("base64url")}, 300, 10, ${NOON})`).rejects.toThrow();
    await expect(prisma.$executeRaw`
      INSERT INTO daily_double (account_id, game_day, day_number, session_id, coins, shards, created_at)
      VALUES (${me}::uuid, '2026-10-01', 8, ${sessionId}, 300, 10, ${NOON})`).rejects.toThrow();
    await expect(prisma.$executeRaw`
      INSERT INTO daily_double (account_id, game_day, day_number, session_id, coins, shards, created_at)
      VALUES (${randomUUID()}::uuid, '2026-09-30', 7, ${randomBytes(12).toString("base64url")}, 300, 10, ${NOON})`).rejects.toThrow();

    await prisma.$executeRaw`DELETE FROM account WHERE account_id = ${me}::uuid`;
    const [count] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM daily_double WHERE account_id = ${me}::uuid`;
    expect(count?.n).toBe(0);
  });
});
