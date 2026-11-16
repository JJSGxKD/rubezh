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
import { RolesService } from "../src/modules/roles/roles.service.js";
import { FreeGemsService, type FreeGemsPlayer } from "../src/modules/shop/free-gems.service.js";
import { PrismaFreeGemsRepository } from "../src/modules/shop/free-gems.repository.js";
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
 * Самоцветы за ролик на живом Postgres с настоящим кошельком и модулем
 * рекламы (docs/17-testing-strategy.md §4.2; адрес — TEST_DATABASE_URL, без
 * него пропуск; tasks/T-0243): раз в московские сутки, одна запись под
 * гонкой, сессия показа — одна на взятие, дневной кап роликов (T-0241) и
 * пропуск VIP. Память этого не покажет: ключи таблицы и граница суток — у базы.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const RACE_TIMEOUT_MS = 30_000;
const MINUTE = 60_000;
/** среда, 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));
const NEXT_NOON = new Date(NOON.getTime() + 24 * 60 * MINUTE);
const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * MINUTE);
const AMOUNT_KEY = "ads.free-gems.amount";
const CAP_KEY = "ads.rewarded.daily-cap";

/**
 * Сессии пишутся в живую базу, а блоки для выдачи берутся из памяти: общие
 * сети в базе из теста включать нельзя — их читают соседние тесты.
 */
class ServedRepository extends PrismaAdsRepository {
  override async activeBlocks(): Promise<AdBlockRow[]> {
    return [adBlock("adsgram", 10, { place: "free_gems" }), adBlock("adsgram", 10, { place: "wheel_spin" })];
  }
}

describe.skipIf(DATABASE_URL === "")("самоцветы за ролик на живом Postgres", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let adsRepository: PrismaAdsRepository;
  let wallet: WalletService;
  let claimsRepository: PrismaFreeGemsRepository;
  /** свои сеть и блоки теста: общие из миграции выключены, чужие тесты наши не трогают */
  const network = `gems_${randomBytes(4).toString("hex")}`;
  const blocks = new Map<AdPlace, AdBlockRow>();

  async function account(): Promise<string> {
    const created = await accounts.upsert({ platform: "telegram", platformUserId: uniquePlatformUserId(), displayName: "Самоцветный", username: null }, Date.now());
    return created.accountId;
  }

  function services(settings = panelSettings()) {
    const passes = new AdPasses();
    const ads = new AdsService(new ServedRepository(prisma), () => 0, passes, settings, new FakeCreatives(), new AdNetworkKeys(adsRepository), new InterstitialGate(adsRepository, flagsOn(), settings), restrictionsGate());
    const gems = new FreeGemsService(claimsRepository, wallet, ads, settings);
    return { ads, passes, gems, settings };
  }

  const player = (accountId: string): FreeGemsPlayer => ({ accountId, platform: "telegram" });
  const viewer = (accountId: string): AdViewer => ({ accountId, platform: "telegram", device: "android" });

  /** Досмотренная сессия места: выдача показа и досмотр от SDK. */
  async function watched(accountId: string, place: AdPlace = "free_gems", time = NOON): Promise<string> {
    const sessionId = randomBytes(12).toString("base64url");
    const block = blocks.get(place);
    if (block === undefined) throw new Error(`нет блока ${place}`);
    await adsRepository.createSession({ sessionId, accountId, place, block, creative: null, createdAt: time, expiresAt: at(time, 30) });
    await adsRepository.report(sessionId, accountId, { kind: "completed" }, at(time, 1));
    return sessionId;
  }

  const gems = async (accountId: string) => (await wallet.balances(accountId)).gems;

  async function sessionStatus(sessionId: string): Promise<{ status: string; claimed: boolean }> {
    const [row] = await prisma.$queryRaw<{ status: string; claimed: boolean }[]>`SELECT status::text, claimed_at IS NOT NULL AS claimed FROM ad_session WHERE session_id = ${sessionId}`;
    if (row === undefined) throw new Error("сессии нет");
    return row;
  }

  async function rows(accountId: string): Promise<number> {
    const [count] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM free_gems_claim WHERE account_id = ${accountId}::uuid`;
    return count?.n ?? 0;
  }

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 20);
    accounts = new PrismaAccountRepository(prisma);
    adsRepository = new PrismaAdsRepository(prisma);
    claimsRepository = new PrismaFreeGemsRepository(prisma);
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    await prisma.$executeRaw`INSERT INTO ad_network (network_key, name, active, priority, updated_at) VALUES (${network}, 'Проверка самоцветов', true, 5, now())`;
    for (const place of ["free_gems", "wheel_spin"] as const) {
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

  it("ролик, запрос — +5 самоцветов с причиной «ad_reward»; запись суток и сессии лежит в базе", async () => {
    const me = await account();
    const { gems: service } = services();
    expect(await service.view(player(me), NOON)).toMatchObject({ status: "available", gems: 5 });
    const sessionId = await watched(me);

    const result = await service.claim(player(me), sessionId, at(NOON, 2));
    expect(result).toEqual({ credited: 5, view: { status: "claimed", gems: 5 } });
    expect(await gems(me)).toBe(5);

    const [row] = await prisma.$queryRaw<{ session_id: string; gems: number; game_day: string }[]>`
      SELECT session_id, gems, game_day::text FROM free_gems_claim WHERE account_id = ${me}::uuid`;
    expect(row).toEqual({ session_id: sessionId, gems: 5, game_day: "2026-09-30" });
    expect(await sessionStatus(sessionId)).toMatchObject({ claimed: true });
    const entries = await prisma.$queryRaw<{ reason: string; source: string; idempotency_key: string; amount: number }[]>`
      SELECT reason::text, source, idempotency_key, amount::int FROM wallet_entry WHERE account_id = ${me}::uuid AND resource = 'gems'`;
    expect(entries).toEqual([{ reason: "ad_reward", source: "free_gems:2026-09-30", idempotency_key: `free_gems:${me}:2026-09-30`, amount: 5 }]);
  });

  it("ключ панели 10 — +10; потолок кошелька пропускает и верх ключа — 20", async () => {
    const meTen = await account();
    const ten = services(panelSettings({ [AMOUNT_KEY]: 10 }));
    expect((await ten.gems.claim(player(meTen), await watched(meTen), at(NOON, 2))).credited).toBe(10);
    expect(await gems(meTen)).toBe(10);

    const meTop = await account();
    const top = services(panelSettings({ [AMOUNT_KEY]: 20 }));
    expect((await top.gems.claim(player(meTop), await watched(meTop), at(NOON, 2))).credited).toBe(20);
    expect(await gems(meTop)).toBe(20);
  });

  it("повтор той же сессией — тот же ответ, второго начисления нет", async () => {
    const me = await account();
    const { gems: service } = services();
    const sessionId = await watched(me);
    const first = await service.claim(player(me), sessionId, at(NOON, 2));
    const again = await service.claim(player(me), sessionId, at(NOON, 3));

    expect(again).toEqual(first);
    expect(await gems(me)).toBe(5);
    expect(await rows(me)).toBe(1);
  });

  it("второй раз в те же сутки — 409 free_gems_claimed, сессия не потрачена; следующие сутки — снова можно", async () => {
    const me = await account();
    const { gems: service } = services();
    await service.claim(player(me), await watched(me), at(NOON, 2));
    const second = await watched(me);

    await expect(service.claim(player(me), second, at(NOON, 3))).rejects.toMatchObject({ code: "free_gems_claimed", status: 409 });
    expect(await sessionStatus(second)).toMatchObject({ claimed: false });
    expect(await gems(me)).toBe(5);
    expect(await service.view(player(me), at(NOON, 4))).toEqual({ status: "claimed", gems: 5 });

    expect(await service.view(player(me), NEXT_NOON)).toMatchObject({ status: "available", gems: 5 });
    await expect(service.claim(player(me), await watched(me, "free_gems", NEXT_NOON), NEXT_NOON)).resolves.toMatchObject({ credited: 5 });
    expect(await gems(me)).toBe(10);
    expect(await rows(me)).toBe(2);
  });

  it("граница суток — полночь по Москве, посчитанная базой: 23:59 и 00:01 — разные взятия", async () => {
    const me = await account();
    const lateEvening = new Date(Date.UTC(2026, 8, 30, 20, 59));
    const afterMidnight = new Date(Date.UTC(2026, 8, 30, 21, 1));
    expect(await claimsRepository.record({ accountId: me, sessionId: randomBytes(12).toString("base64url"), gems: 5 }, lateEvening)).toBe("granted");
    expect(await claimsRepository.today(me, lateEvening)).toMatchObject({ gems: 5, gameDay: "2026-09-30" });
    expect(await claimsRepository.today(me, afterMidnight)).toBeNull();
    expect(await claimsRepository.record({ accountId: me, sessionId: randomBytes(12).toString("base64url"), gems: 5 }, afterMidnight)).toBe("granted");
  });

  it("чужая сессия и сессия чужого места не годятся, начисления нет", async () => {
    const me = await account();
    const stranger = await account();
    const { gems: service } = services();

    await expect(service.claim(player(me), await watched(stranger), at(NOON, 2))).rejects.toMatchObject({ code: "ad_not_completed" });
    await expect(service.claim(player(me), await watched(me, "wheel_spin"), at(NOON, 2))).rejects.toMatchObject({ code: "ad_not_completed" });
    expect(await gems(me)).toBe(0);
    expect(await claimsRepository.today(me, NOON)).toBeNull();
  });

  it("VIP с пропуском берёт без ролика, и ролик в кап не идёт", async () => {
    const me = await account();
    const { gems: service, ads, passes } = services();
    passes.register("vip", async (accountId) => accountId === me);
    expect(await service.view(player(me), NOON)).toMatchObject({ status: "available", ad: { available: true, pass: "vip", capped: false } });

    const offer = await ads.offer(viewer(me), "free_gems", NOON);
    if (!offer.available) throw new Error(`показа нет: ${offer.reason}`);
    expect(offer.pass).toBe("vip");
    await expect(service.claim(player(me), offer.sessionId, at(NOON, 1))).resolves.toMatchObject({ credited: 5 });
    expect(await adsRepository.rewardedWatchedToday(me, at(NOON, 2))).toBe(0);
  });

  it("кап роликов T-0241 достигнут — ad.capped: true; забор сверх капа — 409 ad_daily_cap, запись не появляется", async () => {
    const me = await account();
    const { gems: service } = services(panelSettings({ [CAP_KEY]: 2 }));
    const wheel = [await watched(me, "wheel_spin"), await watched(me, "wheel_spin")];
    expect(await service.view(player(me), at(NOON, 2))).toMatchObject({ status: "available", ad: { available: false, capped: true } });

    const session = await watched(me);
    for (const sessionId of wheel) await adsRepository.claim(sessionId, me, "wheel_spin", at(NOON, 2), () => ({ kind: "allow" }));
    await expect(service.claim(player(me), session, at(NOON, 3))).rejects.toMatchObject({ code: "ad_daily_cap", status: 409 });
    expect(await claimsRepository.today(me, NOON)).toBeNull();
    expect(await gems(me)).toBe(0);
  });

  it(
    "шесть запросов разом разными сессиями — взято один раз, кошелёк получил самоцветы однажды",
    async () => {
      const me = await account();
      const { gems: service } = services();
      const sessions = await Promise.all(Array.from({ length: 6 }, () => watched(me)));
      const results = await Promise.allSettled(sessions.map((sessionId) => service.claim(player(me), sessionId, at(NOON, 2))));

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "free_gems_claimed" });
      expect(await gems(me)).toBe(5);
      expect(await rows(me)).toBe(1);
    },
    RACE_TIMEOUT_MS,
  );

  it(
    "шесть запросов разом одной сессией — одно начисление, все получают ответ",
    async () => {
      const me = await account();
      const { gems: service } = services();
      const sessionId = await watched(me);
      const results = await Promise.all(Array.from({ length: 6 }, () => service.claim(player(me), sessionId, at(NOON, 2))));

      for (const result of results) expect(result.credited).toBe(5);
      expect(await gems(me)).toBe(5);
    },
    RACE_TIMEOUT_MS,
  );

  it("база не примет вторую запись суток, вторую запись той же сессии и запись без игрока; удаление аккаунта убирает запись", async () => {
    const me = await account();
    const sessionId = randomBytes(12).toString("base64url");
    await prisma.$executeRaw`
      INSERT INTO free_gems_claim (account_id, game_day, session_id, gems, created_at)
      VALUES (${me}::uuid, '2026-09-30', ${sessionId}, 5, ${NOON})`;
    await expect(prisma.$executeRaw`
      INSERT INTO free_gems_claim (account_id, game_day, session_id, gems, created_at)
      VALUES (${me}::uuid, '2026-09-30', ${randomBytes(12).toString("base64url")}, 5, ${NOON})`).rejects.toThrow();
    await expect(prisma.$executeRaw`
      INSERT INTO free_gems_claim (account_id, game_day, session_id, gems, created_at)
      VALUES (${me}::uuid, '2026-10-01', ${sessionId}, 5, ${NOON})`).rejects.toThrow();
    await expect(prisma.$executeRaw`
      INSERT INTO free_gems_claim (account_id, game_day, session_id, gems, created_at)
      VALUES (${randomUUID()}::uuid, '2026-09-30', ${randomBytes(12).toString("base64url")}, 5, ${NOON})`).rejects.toThrow();

    await prisma.$executeRaw`DELETE FROM account WHERE account_id = ${me}::uuid`;
    expect(await rows(me)).toBe(0);
  });
});
