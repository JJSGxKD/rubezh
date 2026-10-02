import { randomBytes, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import type { AdSuccess } from "../src/modules/ads/ads-rules.js";
import { PrismaAdsCatalogRepository } from "../src/modules/ads/ads-catalog.repository.js";
import { PrismaAdsRepository, type AdBlockRow } from "../src/modules/ads/ads.repository.js";
import { claimVerdict } from "../src/modules/ads/ads.service.js";
import { REWARDED_VIDEO_PLACES } from "../src/modules/ads/interstitial-gate.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";

/**
 * Реклама на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск): начало суток считает база по Москве,
 * клиент засчитывает только показ, одну сессию забирают однажды, две
 * сессии разом не проскакивают кулдаун, база не примет забор без выполнения,
 * а сессию без блока — иначе как выполненный пропуск рекламы. Факты для
 * межстраничной — сутки по Москве и счёт забегов с потолком.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const MINUTE = 60_000;
/** среда, 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));
const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * MINUTE);
/** полночь на четверг, 01.10.2026, по Москве */
const MIDNIGHT = new Date(Date.UTC(2026, 8, 30, 21));

describe.skipIf(DATABASE_URL === "")("реклама на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let repository: PrismaAdsRepository;
  /** свои сети теста: общие из миграции выключены, а чужие тесты их не трогают */
  const network = `it_${randomBytes(4).toString("hex")}`;
  const blocks: Partial<Record<AdSuccess, AdBlockRow>> = {};

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(930_000_000 + Math.floor(Math.random() * 30_000_000)), displayName: "Реклама", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  function blockOf(success: AdSuccess): AdBlockRow {
    const found = blocks[success];
    if (found === undefined) throw new Error(`нет блока ${success}`);
    return found;
  }

  async function session(accountId: string, success: AdSuccess = "view", createdAt = NOON, place: "wheel_spin" | "task" = "wheel_spin"): Promise<string> {
    const sessionId = randomBytes(12).toString("base64url");
    await repository.createSession({ sessionId, accountId, place, block: { ...blockOf(success), place }, creative: null, createdAt, expiresAt: at(createdAt, 30) });
    return sessionId;
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 10, connectionTimeoutMillis: 30_000 }) });
    accounts = new PrismaAccountRepository(prisma);
    repository = new PrismaAdsRepository(prisma);
    await prisma.$executeRaw`INSERT INTO ad_network (network_key, name, active, priority, updated_at) VALUES (${network}, 'Проверка', true, 5, now())`;
    for (const success of ["view", "click", "cpa"] as const) {
      const blockId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO ad_block (block_id, network_key, place, external_id, success, platforms, devices, created_at, updated_at)
        VALUES (${blockId}::uuid, ${network}, 'wheel_spin', ${`ext-${success}`}, ${success}::"AdSuccess", ARRAY['telegram']::"Platform"[], ARRAY['android']::varchar(16)[], now(), now())`;
      blocks[success] = { blockId, networkKey: network, place: "wheel_spin", externalId: `ext-${success}`, success, priority: 5, networkKeys: {}, platforms: ["telegram"], devices: ["android"] };
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("сети из миграции выключены; в работе — только включённые блоки включённых сетей, с приоритетом сети", async () => {
    const seeded = await prisma.$queryRaw<{ network_key: string; active: boolean }[]>`
      SELECT network_key, active FROM ad_network WHERE network_key IN ('adsgram', 'adsonar', 'richads', 'taddy') ORDER BY priority`;
    expect(seeded).toEqual(["adsgram", "adsonar", "richads", "taddy"].map((key) => ({ network_key: key, active: false })));

    const mine = (await repository.activeBlocks()).filter((block) => block.networkKey === network);
    expect(mine).toHaveLength(3);
    expect(mine.find((block) => block.success === "view")).toEqual(blockOf("view"));

    await prisma.$executeRaw`UPDATE ad_block SET active = false WHERE block_id = ${blockOf("cpa").blockId}::uuid`;
    expect((await repository.activeBlocks()).filter((block) => block.networkKey === network)).toHaveLength(2);
    await prisma.$executeRaw`UPDATE ad_block SET active = true WHERE block_id = ${blockOf("cpa").blockId}::uuid`;
  });

  it("сутки истории — московские: 23:59 и 00:01 — разные сутки, окно — с начала вчерашних, забранные первыми", async () => {
    const me = await account();
    const lateNight = new Date(Date.UTC(2026, 8, 30, 20, 59));
    const earlyMorning = new Date(Date.UTC(2026, 8, 30, 21, 1));
    expect((await repository.history(me, "wheel_spin", lateNight)).dayStart).toEqual(new Date(Date.UTC(2026, 8, 29, 21)));
    expect((await repository.history(me, "wheel_spin", earlyMorning)).dayStart).toEqual(new Date(Date.UTC(2026, 8, 30, 21)));

    // До начала вчерашних суток — за окном истории.
    await session(me, "view", new Date(Date.UTC(2026, 8, 28, 20, 59)));
    const claimed = await session(me, "view", at(NOON, -10));
    const fresh = await session(me, "view", NOON);
    await repository.report(claimed, me, { kind: "completed" }, at(NOON, -9));
    await repository.claim(claimed, me, "wheel_spin", at(NOON, -9), () => ({ kind: "allow" }));

    const history = await repository.history(me, "wheel_spin", NOON);
    expect(history.sessions.map((row) => row.sessionId).sort()).toEqual([claimed, fresh].sort());
    expect(history.sessions.find((row) => row.sessionId === claimed)).toMatchObject({ status: "claimed", networkKey: network, claimedAt: at(NOON, -9) });
    expect(await repository.history(me, "task", NOON)).toEqual({ dayStart: new Date(Date.UTC(2026, 8, 29, 21)), sessions: [] });
  });

  it("воронка: показ и досмотр — метками, клик не выполняет, отказ закрывает; чужая и истёкшая шагов не принимают", async () => {
    const me = await account();
    const stranger = await account();
    const view = await session(me);
    expect(await repository.report(view, me, { kind: "shown" }, at(NOON, 1))).not.toBeNull();
    expect(await repository.report(view, stranger, { kind: "completed" }, at(NOON, 2))).toBeNull();
    expect(await repository.report(view, me, { kind: "completed" }, at(NOON, 2))).not.toBeNull();
    expect(await repository.report(view, me, { kind: "failed", reason: "late" }, at(NOON, 3))).toBeNull();

    const click = await session(me, "click");
    expect(await repository.report(click, me, { kind: "clicked" }, at(NOON, 1))).not.toBeNull();
    expect(await repository.report(click, me, { kind: "completed" }, at(NOON, 1))).toBeNull();
    expect(await repository.report(click, me, { kind: "failed", reason: "sdk_error" }, at(NOON, 2))).not.toBeNull();
    expect(await repository.report(click, me, { kind: "shown" }, at(NOON, 3))).toBeNull();

    const expired = await session(me);
    expect(await repository.report(expired, me, { kind: "completed" }, at(NOON, 30))).toBeNull();

    const [row] = await prisma.$queryRaw<{ status: string; shown_at: Date; completed_at: Date }[]>`
      SELECT status::text, shown_at, completed_at FROM ad_session WHERE session_id = ${view}`;
    expect(row).toEqual({ status: "completed", shown_at: at(NOON, 1), completed_at: at(NOON, 2) });
    const [failed] = await prisma.$queryRaw<{ status: string; clicked_at: Date; fail_reason: string }[]>`
      SELECT status::text, clicked_at, fail_reason FROM ad_session WHERE session_id = ${click}`;
    expect(failed).toEqual({ status: "failed", clicked_at: at(NOON, 1), fail_reason: "sdk_error" });
  });

  it("креатив сети с API: показ отмечен впервые однажды, досмотр — не раньше срока от выдачи; отказ сети — сессией", async () => {
    const me = await account();
    const sessionId = randomBytes(12).toString("base64url");
    await repository.createSession({ sessionId, accountId: me, place: "wheel_spin", block: blockOf("view"), creative: { id: "taddy-1", viewSec: 10 }, createdAt: NOON, expiresAt: at(NOON, 30) });
    const seconds = (value: number) => new Date(NOON.getTime() + value * 1000);
    expect(await repository.report(sessionId, me, { kind: "shown" }, seconds(1))).toEqual({ networkKey: network, creativeId: "taddy-1", firstShown: true });
    expect(await repository.report(sessionId, me, { kind: "shown" }, seconds(2))).toEqual({ networkKey: network, creativeId: "taddy-1", firstShown: false });
    expect(await repository.report(sessionId, me, { kind: "clicked" }, seconds(3))).toMatchObject({ firstShown: false });
    expect(await repository.report(sessionId, me, { kind: "completed" }, seconds(9.999))).toBeNull();
    expect(await repository.report(sessionId, me, { kind: "completed" }, seconds(10))).toEqual({ networkKey: network, creativeId: "taddy-1", firstShown: false });

    // Шаг показа потерялся — досмотр отмечает показ впервые.
    const lost = randomBytes(12).toString("base64url");
    await repository.createSession({ sessionId: lost, accountId: me, place: "wheel_spin", block: blockOf("view"), creative: { id: "taddy-2", viewSec: 5 }, createdAt: NOON, expiresAt: at(NOON, 30) });
    expect(await repository.report(lost, me, { kind: "completed" }, seconds(6))).toMatchObject({ creativeId: "taddy-2", firstShown: true });

    const failed = randomBytes(12).toString("base64url");
    await repository.createFailedSession({ sessionId: failed, accountId: me, place: "wheel_spin", block: blockOf("view"), creative: null, createdAt: NOON, expiresAt: at(NOON, 30) }, "no_fill");
    const [row] = await prisma.$queryRaw<{ status: string; failed_at: Date; fail_reason: string; creative_id: string | null }[]>`
      SELECT status::text, failed_at, fail_reason, creative_id FROM ad_session WHERE session_id = ${failed}`;
    expect(row).toEqual({ status: "failed", failed_at: NOON, fail_reason: "no_fill", creative_id: null });
    expect(await repository.report(failed, me, { kind: "shown" }, seconds(1))).toBeNull();
    const history = await repository.history(me, "wheel_spin", seconds(1));
    expect(history.sessions.map((entry) => entry.sessionId)).toContain(failed);
  });

  it("ключи сетей — всех, и выключенных тоже", async () => {
    await prisma.$executeRaw`UPDATE ad_network SET keys = ${JSON.stringify({ pubId: "abc" })}::jsonb WHERE network_key = ${network}`;
    const keys = await repository.networkKeys();
    expect(keys.find((row) => row.networkKey === network)?.keys).toEqual({ pubId: "abc" });
    // Сети из миграции выключены, но в списке есть: SDK учёта живёт и у выключенной сети.
    expect(keys.map((row) => row.networkKey)).toEqual(expect.arrayContaining(["adsgram", "taddy"]));
    await prisma.$executeRaw`UPDATE ad_network SET keys = '{}'::jsonb WHERE network_key = ${network}`;
  });

  it("одну сессию шесть раз разом забирают однажды — остальным она отдаётся повтором", async () => {
    const me = await account();
    const sessionId = await session(me);
    await repository.report(sessionId, me, { kind: "completed" }, at(NOON, 1));
    const verdict = (row: Parameters<typeof claimVerdict>[0], history: Parameters<typeof claimVerdict>[1]) => claimVerdict(row, history, at(NOON, 1));
    const results = await Promise.all(Array.from({ length: 6 }, () => repository.claim(sessionId, me, "wheel_spin", at(NOON, 1), verdict)));
    expect(results.filter((result) => result.status === "claimed" && !result.repeat)).toHaveLength(1);
    expect(results.every((result) => result.status === "claimed")).toBe(true);
  });

  it("две досмотренные сессии разом не проскакивают кулдаун места", async () => {
    const me = await account();
    const sessions = [await session(me), await session(me), await session(me)];
    for (const sessionId of sessions) await repository.report(sessionId, me, { kind: "completed" }, at(NOON, 1));
    const verdict = (row: Parameters<typeof claimVerdict>[0], history: Parameters<typeof claimVerdict>[1]) => claimVerdict(row, history, at(NOON, 1));
    const results = await Promise.all(sessions.map((sessionId) => repository.claim(sessionId, me, "wheel_spin", at(NOON, 1), verdict)));
    expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "cooldown")).toEqual([
      { status: "cooldown", retryAt: at(NOON, 121) },
      { status: "cooldown", retryAt: at(NOON, 121) },
    ]);
  });

  it("не выполненное не забирается — ни через сервис, ни мимо него: база не примет забор без выполнения", async () => {
    const me = await account();
    const sessionId = await session(me);
    expect(await repository.claim(sessionId, me, "wheel_spin", NOON, (row, history) => claimVerdict(row, history, NOON))).toEqual({ status: "not_completed" });
    expect(await repository.claim(sessionId, me, "task", NOON, () => ({ kind: "allow" }))).toEqual({ status: "not_completed" });
    await expect(prisma.$executeRaw`UPDATE ad_session SET claimed_at = now() WHERE session_id = ${sessionId}`).rejects.toThrow();
    await expect(prisma.$executeRaw`
      INSERT INTO ad_session (session_id, account_id, place, block_id, network_key, success, created_at, expires_at)
      VALUES ('it-bad-expiry', ${me}::uuid, 'wheel_spin', ${blockOf("view").blockId}::uuid, ${network}, 'view', now(), now() - interval '1 minute')`).rejects.toThrow();
    await expect(prisma.$executeRaw`
      INSERT INTO ad_block (block_id, network_key, place, external_id, devices, created_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${network}, 'task', 'ext-tv', ARRAY['tv']::varchar(16)[], now(), now())`).rejects.toThrow();
  });

  it("сессия пропуска (VIP) — без блока и сразу выполнена: забирается однажды, в истории — под именем пропуска", async () => {
    const me = await account();
    const sessionId = randomBytes(12).toString("base64url");
    await repository.createPassSession({ sessionId, accountId: me, place: "wheel_spin", pass: "vip", createdAt: NOON, expiresAt: at(NOON, 30) });
    // шагов воронки у неё нет: ролика не было
    expect(await repository.report(sessionId, me, { kind: "shown" }, at(NOON, 1))).toBeNull();

    const verdict = (row: Parameters<typeof claimVerdict>[0], history: Parameters<typeof claimVerdict>[1]) => claimVerdict(row, history, at(NOON, 1));
    const results = await Promise.all([1, 2, 3].map(() => repository.claim(sessionId, me, "wheel_spin", at(NOON, 1), verdict)));
    expect(results.filter((result) => result.status === "claimed" && !result.repeat)).toHaveLength(1);
    const history = await repository.history(me, "wheel_spin", at(NOON, 2));
    expect(history.sessions).toEqual([expect.objectContaining({ sessionId, networkKey: "vip", shownAt: null, claimedAt: at(NOON, 1) })]);

    // без блока — только выполненный досмотр: база не примет «пропуск» клика или невыполненный
    await expect(prisma.$executeRaw`
      INSERT INTO ad_session (session_id, account_id, place, block_id, network_key, success, status, created_at, completed_at, expires_at)
      VALUES ('it-pass-click', ${me}::uuid, 'wheel_spin', NULL, 'vip', 'click', 'completed', now(), now(), now() + interval '1 minute')`).rejects.toThrow();
    await expect(prisma.$executeRaw`
      INSERT INTO ad_session (session_id, account_id, place, block_id, network_key, success, created_at, expires_at)
      VALUES ('it-pass-open', ${me}::uuid, 'wheel_spin', NULL, 'vip', 'view', now(), now() + interval '1 minute')`).rejects.toThrow();
  });

  it("каталог панели: ключи сети и блок с площадками и устройствами заводятся и правятся, блок чужой сети — нет, воронка — за окно", async () => {
    const catalog = new PrismaAdsCatalogRepository(prisma);
    const actor = await account();
    expect((await catalog.networks()).find((row) => row.networkKey === network)).toEqual({ networkKey: network, name: "Проверка", active: true, priority: 5, keys: {} });
    expect(await catalog.updateNetwork({ networkKey: network, active: true, priority: 6, keys: { pubId: "792361", appId: "1396" } }, NOON)).toBe(true);
    expect((await catalog.networks()).find((row) => row.networkKey === network)?.keys).toEqual({ pubId: "792361", appId: "1396" });
    expect(await catalog.updateNetwork({ networkKey: "it_missing", active: true, priority: 6, keys: {} }, NOON)).toBe(false);
    // Ключи доходят до выдачи показа вместе с блоком — их ждёт SDK.
    expect((await repository.activeBlocks()).find((row) => row.blockId === blockOf("view").blockId)?.networkKeys).toEqual({ pubId: "792361", appId: "1396" });
    await catalog.updateNetwork({ networkKey: network, active: true, priority: 5, keys: {} }, NOON);
    // Формат без блока в кабинете — `null`, пустая строка вместо него база не примет.
    const unitless = await catalog.insertBlock({ networkKey: network, place: "interstitial", externalId: null, success: "view", active: false, platforms: [], devices: [] }, actor, NOON);
    expect((await catalog.blocks()).find((row) => row.blockId === unitless?.blockId)?.externalId).toBeNull();
    await expect(prisma.$executeRaw`UPDATE ad_block SET external_id = '' WHERE block_id = ${unitless?.blockId ?? ""}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE ad_network SET keys = '[]'::jsonb WHERE network_key = ${network}`).rejects.toThrow();

    const created = await catalog.insertBlock(
      { networkKey: network, place: "run_double", externalId: "ext-panel", success: "click", active: true, platforms: ["telegram", "vk"], devices: ["android", "ios"] },
      actor,
      NOON,
    );
    expect(created).not.toBeNull();
    expect(await catalog.insertBlock({ networkKey: "it_missing", place: "task", externalId: "x", success: "view", active: true, platforms: [], devices: [] }, actor, NOON)).toBeNull();
    if (created === null) throw new Error("блок не заведён");
    expect((await catalog.blocks()).find((row) => row.blockId === created.blockId)).toEqual(created);

    const edited = { ...created, externalId: "ext-panel-2", active: false, platforms: [], devices: ["desktop" as const] };
    expect(await catalog.updateBlock(edited, actor, NOON)).toBe(true);
    expect((await catalog.blocks()).find((row) => row.blockId === created.blockId)).toEqual(edited);
    expect(await catalog.updateBlock({ ...edited, blockId: randomUUID() }, actor, NOON)).toBe(false);

    // Окно воронки — в будущем, куда не пишет ни один другой тест.
    const window = new Date(Date.UTC(2031, 0, 1, 9));
    const shown = await session(actor, "view", window);
    await session(actor, "click", at(window, 1));
    await repository.report(shown, actor, { kind: "completed" }, at(window, 2));
    const rows = (await catalog.funnel(window, at(window, 60))).filter((row) => row.networkKey === network);
    expect(rows).toEqual([{ networkKey: network, place: "wheel_spin", offered: 2, shown: 1, clicked: 0, completed: 1, claimed: 0, failed: 0 }]);
    expect((await catalog.funnel(at(window, 60), at(window, 120))).filter((row) => row.networkKey === network)).toEqual([]);
  });

  it("удалённый аккаунт уносит свои сессии показа", async () => {
    const me = await account();
    await session(me);
    await prisma.$executeRaw`DELETE FROM account WHERE account_id = ${me}::uuid`;
    const [left] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM ad_session WHERE account_id = ${me}::uuid`;
    expect(Number(left?.n)).toBe(0);
  });

  it("факты межстраничной: сутки — по Москве, забеги — не короче порога и с потолком, ролик — по показу, покупка — по оплате", async () => {
    const me = await account();
    // Первый вход — в 23:50 по Москве: в 23:59 это ещё день первого входа, в полночь — уже следующий.
    await prisma.$executeRaw`UPDATE account SET created_at = ${at(MIDNIGHT, -10)} WHERE account_id = ${me}::uuid`;
    const query = { countedRunSec: 60, newbieRuns: 5, everyRuns: 3, rewardedPlaces: REWARDED_VIDEO_PLACES, rewardedSince: at(MIDNIGHT, -120) };
    expect(await repository.interstitialFacts(me, at(MIDNIGHT, -1), query)).toEqual({
      daysSinceSignup: 0,
      countedRuns: 0,
      runsSinceShown: 0,
      lastShownAt: null,
      lastPurchaseAt: null,
      lastRewardedAt: null,
    });
    expect((await repository.interstitialFacts(me, MIDNIGHT, query))?.daysSinceSignup).toBe(1);

    const run = (finishedAt: Date | null, survivalSec: number) => prisma.$executeRaw`
      INSERT INTO run (run_id, account_id, status, difficulty, starting_weapon_id, content_hash, finished_at, survival_sec)
      VALUES (${`it-${randomBytes(6).toString("hex")}`}, ${me}::uuid, ${finishedAt === null ? "started" : "finished"}::"RunStatus", 'easy', 'spark', 'hash',
              ${finishedAt}, ${survivalSec})`;
    // До показа — четыре долгих, короткий и неоконченный: в счёт идут только долгие.
    for (const minute of [1, 2, 3, 4]) await run(at(MIDNIGHT, minute), 120);
    await run(at(MIDNIGHT, 5), 59);
    await run(null, 0);
    const shownId = randomBytes(12).toString("base64url");
    await repository.createSession({ sessionId: shownId, accountId: me, place: "interstitial", block: blockOf("view"), creative: null, createdAt: at(MIDNIGHT, 10), expiresAt: at(MIDNIGHT, 40) });
    await repository.report(shownId, me, { kind: "shown" }, at(MIDNIGHT, 11));
    // Невыданная позже сессия межстраничной последним показом не считается.
    await repository.createFailedSession({ sessionId: randomBytes(12).toString("base64url"), accountId: me, place: "interstitial", block: blockOf("view"), creative: null, createdAt: at(MIDNIGHT, 20), expiresAt: at(MIDNIGHT, 50) }, "no_fill");
    // После показа — четыре долгих: потолок счёта — N.
    for (const minute of [12, 13, 14, 15]) await run(at(MIDNIGHT, minute), 600);

    const wheel = await session(me, "view", at(MIDNIGHT, 30));
    await repository.report(wheel, me, { kind: "shown" }, at(MIDNIGHT, 31));
    await prisma.$executeRaw`
      INSERT INTO purchase (purchase_id, account_id, product, sku, price_stars, charged_stars, mode, status, invoiced_at, paid_at)
      VALUES (${randomUUID()}::uuid, ${me}::uuid, 'shop_item', 'gems_60', 50, 50, 'live'::"PaymentMode", 'paid'::"PurchaseStatus", ${at(MIDNIGHT, 32)}, ${at(MIDNIGHT, 33)})`;

    expect(await repository.interstitialFacts(me, at(MIDNIGHT, 40), query)).toEqual({
      daysSinceSignup: 1,
      countedRuns: 5,
      runsSinceShown: 3,
      lastShownAt: at(MIDNIGHT, 11),
      lastPurchaseAt: at(MIDNIGHT, 33),
      lastRewardedAt: at(MIDNIGHT, 31),
    });
    // Ролик, выданный раньше окна поиска, не виден: окно — по выдаче, чтобы идти индексом.
    expect((await repository.interstitialFacts(me, at(MIDNIGHT, 40), { ...query, rewardedSince: at(MIDNIGHT, 35) }))?.lastRewardedAt).toBeNull();
    expect(await repository.interstitialFacts(randomUUID(), MIDNIGHT, query)).toBeNull();
  });
});
