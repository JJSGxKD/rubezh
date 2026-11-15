import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { AdNetworkKeys } from "../src/modules/ads/ad-network-keys.js";
import { AdPasses } from "../src/modules/ads/ads-passes.js";
import { InterstitialGate } from "../src/modules/ads/interstitial-gate.js";
import type { AdPlace } from "../src/modules/ads/ads-rules.js";
import { PrismaAdsRepository, type AdBlockRow } from "../src/modules/ads/ads.repository.js";
import { AdsService, type AdOffer, type AdViewer } from "../src/modules/ads/ads.service.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { RunAdChestService } from "../src/modules/runs/run-ad-chest.service.js";
import { PrismaRunAdChestsRepository } from "../src/modules/runs/run-ad-chests.repository.js";
import { AdChestTakenError, AdChestUnavailableError } from "../src/modules/runs/run-chest-errors.js";
import { ContinueRunUnverifiedError } from "../src/modules/runs/run-continue-errors.js";
import { PrismaRunsRepository } from "../src/modules/runs/runs.repository.js";
import { FakeCreatives, adBlock, flagsOn } from "./helpers/memory-ads.js";
import { restrictionsGate } from "./helpers/memory-restrictions.js";
import { panelSettings } from "./helpers/settings.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Второй сундук клада за рекламу на настоящем Postgres (tasks/T-0327, Р162;
 * адрес — TEST_DATABASE_URL, без него пропуск). Память этого не покажет:
 * «один на забег» и «одна сессия — один забег» держатся ключами таблицы, два
 * параллельных забора обязаны дать ровно одну запись, а общий дневной кап
 * роликов считается по настоящим сессиям показов.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const RACE_TIMEOUT_MS = 30_000;
const MINUTE = 60_000;
/** среда, 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));
const at = (minutes: number) => new Date(NOON.getTime() + minutes * MINUTE);
const CAP_KEY = "ads.rewarded.daily-cap";
const PLACES: readonly AdPlace[] = ["clad_chest", "run_double"];

/**
 * Сессии пишутся в живую базу, а блоки для выдачи берутся из памяти: готовность
 * места требует блок настоящей сети по профилю, а включать общие сети в базе
 * из теста нельзя — их читают соседние тесты.
 */
class ServedRepository extends PrismaAdsRepository {
  override async activeBlocks(): Promise<AdBlockRow[]> {
    return PLACES.map((place) => adBlock("adsgram", 10, { place }));
  }
}

describe.skipIf(DATABASE_URL === "")("второй сундук клада на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let runs: PrismaRunsRepository;
  let adsRepository: PrismaAdsRepository;
  let chests: PrismaRunAdChestsRepository;
  /** свои сеть и блоки теста: общие из миграции выключены, чужие тесты наши не трогают */
  const network = `chest_${randomBytes(4).toString("hex")}`;
  const blocks = new Map<AdPlace, AdBlockRow>();

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(930_000_000 + Math.floor(Math.random() * 30_000_000)), displayName: "Сундук", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  async function startedRun(accountId: string): Promise<string> {
    const runId = randomUUID();
    await runs.start({ runId, accountId, difficulty: "hard", startingWeaponId: "knife", contentHash: "abc", startedAt: new Date() });
    return runId;
  }

  function blockOf(place: AdPlace): AdBlockRow {
    const found = blocks.get(place);
    if (found === undefined) throw new Error(`нет блока ${place}`);
    return found;
  }

  function stack(settings = panelSettings()) {
    const passes = new AdPasses();
    const ads = new AdsService(new ServedRepository(prisma), () => 0, passes, settings, new FakeCreatives(), new AdNetworkKeys(adsRepository), new InterstitialGate(adsRepository, flagsOn(), settings), restrictionsGate());
    return { ads, passes, service: new RunAdChestService(runs, chests, ads) };
  }

  const viewer = (accountId: string): AdViewer => ({ accountId, platform: "telegram", device: "android" });
  const player = (accountId: string) => ({ accountId, platform: "telegram" as const });

  /** Досмотренная сессия места: выдана показом и закрыта отчётом клиента. */
  async function watched(accountId: string, place: AdPlace, time = NOON): Promise<string> {
    const sessionId = randomBytes(12).toString("base64url");
    await adsRepository.createSession({ sessionId, accountId, place, block: blockOf(place), creative: null, createdAt: time, expiresAt: at(30) });
    await adsRepository.report(sessionId, accountId, { kind: "completed" }, new Date(time.getTime() + MINUTE));
    return sessionId;
  }

  function offered(offer: AdOffer): Extract<AdOffer, { available: true }> {
    if (!offer.available) throw new Error(`показа нет: ${offer.reason}`);
    return offer;
  }

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 10);
    accounts = new PrismaAccountRepository(prisma);
    runs = new PrismaRunsRepository(prisma);
    adsRepository = new PrismaAdsRepository(prisma);
    chests = new PrismaRunAdChestsRepository(prisma);
    await prisma.$executeRaw`INSERT INTO ad_network (network_key, name, active, priority, updated_at) VALUES (${network}, 'Проверка сундука', true, 5, now())`;
    for (const place of PLACES) {
      const blockId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO ad_block (block_id, network_key, place, external_id, success, platforms, devices, created_at, updated_at)
        VALUES (${blockId}::uuid, ${network}, ${place}::"AdPlace", ${`ext-${place}`}, 'view'::"AdSuccess", ARRAY['telegram']::"Platform"[], ARRAY['android']::varchar(16)[], now(), now())`;
      blocks.set(place, { blockId, networkKey: network, place, externalId: `ext-${place}`, success: "view", priority: 5, networkKeys: {}, platforms: ["telegram"], devices: ["android"] });
    }
  });

  afterAll(async () => {
    // Чужим тестам свои блоки не оставляем: выдача читает все включённые.
    await prisma.$executeRaw`UPDATE ad_block SET active = false WHERE network_key = ${network}`;
    await prisma.$executeRaw`UPDATE ad_network SET active = false WHERE network_key = ${network}`;
    await prisma.$disconnect();
  });

  it("показ досмотрен — сундук записан; повтор той же сессией — тот же ответ, строка одна", async () => {
    const me = await account();
    const runId = await startedRun(me);
    const { service } = stack();
    const sessionId = await watched(me, "clad_chest");

    expect(await service.claim(player(me), runId, sessionId, NOON)).toEqual({ granted: true });
    expect(await service.claim(player(me), runId, sessionId, at(1))).toEqual({ granted: true });
    expect(await chests.count(runId)).toBe(1);
    expect(await chests.bySession(sessionId)).toEqual({ runId });
    expect(await service.paid(runId, 1)).toBe(1);
    expect(await service.view(player(me), runId, at(2))).toEqual({ status: "unavailable", reason: "used_up" });
  });

  it("второй раз за забег — «chest_unavailable», вторая сессия не потрачена", async () => {
    const me = await account();
    const runId = await startedRun(me);
    const other = await startedRun(me);
    const { service } = stack();
    await service.claim(player(me), runId, await watched(me, "clad_chest"), NOON);

    const second = await watched(me, "clad_chest");
    await expect(service.claim(player(me), runId, second, at(1))).rejects.toBeInstanceOf(AdChestUnavailableError);
    expect(await chests.count(runId)).toBe(1);
    // Не потраченная на «занятый» забег сессия забирается на другом.
    expect(await service.claim(player(me), other, second, at(2))).toEqual({ granted: true });
  });

  it("сессия, потраченная на другой забег, и чужой забег — отказ, лишних строк нет", async () => {
    const me = await account();
    const stranger = await account();
    const first = await startedRun(me);
    const second = await startedRun(me);
    const foreign = await startedRun(stranger);
    const { service } = stack();
    const sessionId = await watched(me, "clad_chest");
    await service.claim(player(me), first, sessionId, NOON);

    await expect(service.claim(player(me), second, sessionId, at(1))).rejects.toBeInstanceOf(AdChestTakenError);
    await expect(service.claim(player(me), foreign, await watched(me, "clad_chest"), at(1))).rejects.toBeInstanceOf(ContinueRunUnverifiedError);
    // Чужой забег отвечает так же и на повтор уже потраченной сессией.
    await expect(service.claim(player(stranger), first, sessionId, at(1))).rejects.toBeInstanceOf(ContinueRunUnverifiedError);
    expect(await chests.count(second)).toBe(0);
    expect(await chests.count(foreign)).toBe(0);
  });

  it("сессия другого места не годится: забор отказывает, записи нет", async () => {
    const me = await account();
    const runId = await startedRun(me);
    const { service } = stack();
    const wrongPlace = await watched(me, "run_double");

    await expect(service.claim(player(me), runId, wrongPlace, NOON)).rejects.toMatchObject({ code: "ad_not_completed", status: 409 });
    expect(await chests.count(runId)).toBe(0);
  });

  it("два параллельных забора разными сессиями на один забег дают ровно одну запись", async () => {
    const me = await account();
    const runId = await startedRun(me);
    const { service } = stack();
    const sessions = [await watched(me, "clad_chest"), await watched(me, "clad_chest")];

    const results = await Promise.allSettled(sessions.map((sessionId) => service.claim(player(me), runId, sessionId, NOON)));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await chests.count(runId)).toBe(1);
  }, RACE_TIMEOUT_MS);

  it("VIP — без показа: пропуск вместо ролика забирается так же, сеть записи — vip", async () => {
    const me = await account();
    const runId = await startedRun(me);
    const { ads, passes, service } = stack();
    passes.register("vip", async (accountId) => accountId === me);

    expect(await service.view(player(me), runId, NOON)).toEqual({ status: "available", pass: "vip" });
    const pass = offered(await ads.offer(viewer(me), "clad_chest", NOON));
    expect(pass.pass).toBe("vip");
    expect(await service.claim(player(me), runId, pass.sessionId, NOON)).toEqual({ granted: true });

    const [row] = await prisma.$queryRaw<{ network_key: string }[]>`SELECT network_key FROM run_ad_chest WHERE run_id = ${runId}`;
    expect(row?.network_key).toBe("vip");
  });

  it("общий дневной кап роликов исчерпан — «daily_cap», забор — 409 ad_daily_cap, записи нет; VIP кап не касается", async () => {
    const me = await account();
    const runId = await startedRun(me);
    const { ads, passes, service } = stack(panelSettings({ [CAP_KEY]: 2 }));
    // Сессия сундука выдана, пока кап свободен; потом два других ролика заняли кап.
    const chest = await watched(me, "clad_chest");
    await ads.claim(me, await watched(me, "run_double"), "run_double", at(1));
    await ads.claim(me, await watched(me, "run_double"), "run_double", at(1));

    expect(await service.view(player(me), runId, at(2))).toEqual({ status: "unavailable", reason: "daily_cap" });
    await expect(service.claim(player(me), runId, chest, at(2))).rejects.toMatchObject({ code: "ad_daily_cap", status: 409 });
    expect(await chests.count(runId)).toBe(0);

    passes.register("vip", async (accountId) => accountId === me);
    expect(await service.view(player(me), runId, at(2))).toEqual({ status: "available", pass: "vip" });
  });

  it("итог с одним вторым сундуком и записью в книге — подтверждён; без записи — нет", async () => {
    const me = await account();
    const withChest = await startedRun(me);
    const without = await startedRun(me);
    const { service } = stack();
    await service.claim(player(me), withChest, await watched(me, "clad_chest"), NOON);

    expect(await service.paid(withChest, 1)).toBe(1);
    expect(await service.paid(without, 1)).toBe(0);
    expect(await service.paid(withChest, 0)).toBe(0);
  });

  it("строка уходит каскадом вместе с забегом", async () => {
    const me = await account();
    const runId = await startedRun(me);
    const sessionId = randomBytes(12).toString("base64url");
    await chests.grant({ runId, accountId: me, sessionId, networkKey: "vip", grantedAt: new Date() });
    expect(await chests.count(runId)).toBe(1);

    await prisma.run.delete({ where: { runId } });

    expect(await chests.count(runId)).toBe(0);
    expect(await chests.bySession(sessionId)).toBeNull();
  });
});
