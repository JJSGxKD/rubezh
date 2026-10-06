import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaSessionsRepository } from "../src/modules/attribution/sessions.repository.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { bucketOf } from "../src/modules/flags/flag-rollout.js";
import { flagSplitReport } from "../src/modules/funnel/flag-split-report.js";
import { funnelReport } from "../src/modules/funnel/funnel-report.js";
import { PrismaFunnelRepository } from "../src/modules/funnel/funnel.repository.js";
import { newClickId, newLinkCode } from "../src/modules/links/link-code.js";

/**
 * Вехи воронки на живом Postgres (docs/17-testing-strategy.md
 * §4.2; адрес — TEST_DATABASE_URL, без него пропуск).
 *
 * Память этого не покажет: вехи ставит одна вставка с `ON CONFLICT`, в
 * которой `SET` видит строку до обновления, — на этом держатся счётчик
 * забегов и возвраты по московским суткам.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const HOUR = 3_600_000;
/** 25 сентября 2026, 12:00 по Москве */
const T0 = Date.UTC(2026, 8, 25, 9, 0, 0);

describe.skipIf(DATABASE_URL === "")("вехи воронки на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let funnel: PrismaFunnelRepository;

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(710_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Путник", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  async function row(accountId: string) {
    return await prisma.accountFunnel.findUniqueOrThrow({ where: { accountId } });
  }

  beforeAll(() => {
    prisma = createPrisma(loadAppConfig({ DATABASE_URL }));
    accounts = new PrismaAccountRepository(prisma);
    funnel = new PrismaFunnelRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("веха — дата первого раза: повтор ничего не двигает", async () => {
    const id = await account();
    await funnel.entered(id, new Date(T0));
    await funnel.entered(id, new Date(T0 + HOUR));
    await funnel.firstRunStarted(id, new Date(T0 + 2 * HOUR));
    await funnel.firstRunStarted(id, new Date(T0 + 3 * HOUR));

    const saved = await row(id);
    expect(saved.enteredAt).toEqual(new Date(T0));
    expect(saved.firstRunStartedAt).toEqual(new Date(T0 + 2 * HOUR));
  });

  it("второй и пятый забег — по счётчику записанных, первый — дата первого", async () => {
    const id = await account();
    for (let run = 1; run <= 6; run++) await funnel.runRecorded(id, new Date(T0 + run * HOUR));

    const saved = await row(id);
    expect(saved.runsRecorded).toBe(6);
    expect(saved.firstRunFinishedAt).toEqual(new Date(T0 + HOUR));
    expect(saved.runs2At).toEqual(new Date(T0 + 2 * HOUR));
    expect(saved.runs5At).toEqual(new Date(T0 + 5 * HOUR));
  });

  it("параллельные записи забегов не теряют ни одного", async () => {
    const id = await account();
    await Promise.all(Array.from({ length: 10 }, (_, index) => funnel.runRecorded(id, new Date(T0 + index * 1000))));
    expect((await row(id)).runsRecorded).toBe(10);
  });

  it("возврат считается по московским суткам от первого открытия", async () => {
    const id = await account();
    // Первое открытие — 23:30 по Москве 25-го; через час по Москве уже 26-е: это D1,
    // хотя по UTC прошёл всего час и сутки те же.
    const late = Date.UTC(2026, 8, 25, 20, 30, 0);
    await funnel.appOpened(id, new Date(late));
    await funnel.appOpened(id, new Date(late + 20 * 60_000));
    expect((await row(id)).returnedD1At).toBeNull();

    await funnel.appOpened(id, new Date(late + HOUR));
    const d1 = await row(id);
    expect(d1.appOpenedAt).toEqual(new Date(late));
    expect(d1.returnedD1At).toEqual(new Date(late + HOUR));
    expect(d1.returnedD7At).toBeNull();

    await funnel.appOpened(id, new Date(late + 6 * 24 * HOUR));
    expect((await row(id)).returnedD7At).toBeNull();
    await funnel.appOpened(id, new Date(late + 6 * 24 * HOUR + 2 * HOUR));
    const d7 = await row(id);
    expect(d7.returnedD7At).toEqual(new Date(late + 6 * 24 * HOUR + 2 * HOUR));
    expect(d7.returnedD1At).toEqual(new Date(late + HOUR));
  });

  it("отчёт считает вехи по кампании ссылки, а не по клику; приглашения — одной строкой", async () => {
    const sessions = new PrismaSessionsRepository(prisma);
    const campaign = `camp-${randomUUID().slice(0, 8)}`;
    const linkCode = newLinkCode();
    await prisma.link.create({ data: { code: linkCode, campaign, source: "tg_ads" } });
    const record = async (accountId: string, startKind: "click" | "invite", startRef: string) => {
      await sessions.record({
        sessionId: randomUUID(),
        accountId,
        platform: "telegram",
        place: "channel",
        startKind,
        startParam: `${startKind === "click" ? "c" : "r"}-${startRef}`,
        startRef,
        clientPlatform: null,
        clientVersion: null,
        deviceClass: "unknown",
        os: "unknown",
        ipPrefix: null,
        startedAt: new Date(T0).toISOString(),
      });
      await funnel.entered(accountId, new Date(T0));
    };
    // Каждый переход по ссылке — свой код клика, но кампания у них одна.
    const ids = [await account(), await account(), await account()];
    for (const id of ids) {
      const clickId = newClickId();
      await prisma.linkClick.create({ data: { clickId, linkCode } });
      await record(id, "click", clickId);
    }
    await funnel.appOpened(ids[0]!, new Date(T0 + HOUR));
    await funnel.appOpened(ids[1]!, new Date(T0 + HOUR));
    await funnel.runRecorded(ids[0]!, new Date(T0 + 2 * HOUR));
    // Двое пришли по приглашениям разных людей.
    await record(await account(), "invite", `inv${randomUUID().slice(0, 6)}`);
    await record(await account(), "invite", `inv${randomUUID().slice(0, 6)}`);

    const report = await funnelReport(prisma, new Date(T0 - HOUR), new Date(T0 + 24 * HOUR));
    expect(report.filter((line) => line.startRef === campaign)).toEqual([
      expect.objectContaining({ platform: "telegram", startKind: "click", startSource: "tg_ads", accounts: 3, entered: 3, appOpened: 2, firstRunFinished: 1 }),
    ]);
    const invites = report.filter((line) => line.startKind === "invite");
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({ startRef: null, startSource: null });
    expect(invites[0]?.accounts).toBeGreaterThanOrEqual(2);
  });

  it("доля флага против остальных: корзина та же, что у флага; считаются только настоящие оплаты, ролики с сетью и созревшие возвраты", async () => {
    // Свой день далеко в прошлом и свой ключ флага: чужие тесты в когорту не попадут.
    const day = Date.UTC(2004, 0, 1, 9) + Math.floor(Math.random() * 300) * 24 * HOUR;
    const rule = { key: `it.split.${randomBytes(4).toString("hex")}`, enabled: true, platforms: ["telegram" as const], percent: 50 };
    const ids: string[] = [];
    for (let index = 0; index < 24; index++) {
      const id = await account();
      ids.push(id);
      await funnel.appOpened(id, new Date(day + index * 60_000));
    }
    // Вернулись: первые восемь — на следующие сутки, первые четыре — ещё и на восьмые.
    for (const id of ids.slice(0, 8)) await funnel.appOpened(id, new Date(day + 24 * HOUR));
    for (const id of ids.slice(0, 4)) await funnel.appOpened(id, new Date(day + 8 * 24 * HOUR));

    const purchase = (accountId: string, stars: number, mode: "live" | "test", status: "paid" | "refunded") => prisma.$executeRaw`
      INSERT INTO purchase (purchase_id, account_id, product, sku, price_stars, charged_stars, mode, status, invoiced_at, paid_at)
      VALUES (${randomUUID()}::uuid, ${accountId}::uuid, 'shop_item', 'gems_60', ${stars}, ${stars}, ${mode}::"PaymentMode", ${status}::"PurchaseStatus", ${new Date(day)}, ${new Date(day)})`;
    await purchase(ids[0]!, 50, "live", "paid");
    await purchase(ids[0]!, 250, "live", "paid");
    await funnel.firstPurchase(ids[0]!, new Date(day));
    // Не в счёт: проверка платёжной цепочки и возврат.
    await purchase(ids[1]!, 1, "test", "paid");
    await purchase(ids[2]!, 100, "live", "refunded");

    const run = (accountId: string) => prisma.$executeRaw`
      INSERT INTO run (run_id, account_id, status, difficulty, starting_weapon_id, content_hash, finished_at, survival_sec)
      VALUES (${`it-${randomBytes(6).toString("hex")}`}, ${accountId}::uuid, 'finished', 'easy', 'spark', 'hash', ${new Date(day + HOUR)}, 120)`;
    for (const id of [ids[0]!, ids[0]!, ids[0]!, ids[3]!]) await run(id);

    const network = `it_${randomBytes(4).toString("hex")}`;
    const blockId = randomUUID();
    await prisma.$executeRaw`INSERT INTO ad_network (network_key, name, active, priority, updated_at) VALUES (${network}, 'Проверка', false, 5, now())`;
    await prisma.$executeRaw`
      INSERT INTO ad_block (block_id, network_key, place, external_id, success, platforms, devices, created_at, updated_at)
      VALUES (${blockId}::uuid, ${network}, 'interstitial', NULL, 'view', ARRAY[]::"Platform"[], ARRAY[]::varchar(16)[], now(), now())`;
    const ad = (accountId: string, place: string, status: string, shown: boolean, block: string | null) => prisma.$executeRaw`
      INSERT INTO ad_session (session_id, account_id, place, block_id, network_key, success, status, created_at, shown_at, completed_at, expires_at)
      VALUES (${randomBytes(12).toString("base64url")}, ${accountId}::uuid, ${place}::"AdPlace", ${block}::uuid, ${block === null ? "vip" : network}, 'view',
              ${status}::"AdSessionStatus", ${new Date(day + HOUR)}, ${shown ? new Date(day + HOUR) : null},
              ${status === "completed" || status === "claimed" ? new Date(day + HOUR) : null}, ${new Date(day + 2 * HOUR)})`;
    await ad(ids[0]!, "interstitial", "completed", true, blockId);
    await ad(ids[0]!, "interstitial", "failed", false, blockId);
    await ad(ids[1]!, "wheel_spin", "claimed", true, blockId);
    // Пропуск VIP — награда без ролика: роликом не считается.
    await ad(ids[1]!, "run_double", "claimed", false, null);

    const inShare = (id: string) => bucketOf(rule.key, id) < rule.percent;
    const ofGroup = (share: boolean) => ids.filter((id) => inShare(id) === share);
    const count = (list: readonly string[], within: readonly string[]) => list.filter((id) => within.includes(id)).length;
    const later = new Date(day + 10 * 24 * HOUR);
    const split = await flagSplitReport(prisma, rule, new Date(day - HOUR), new Date(day + 2 * HOUR), later, ["second_chance", "wheel_spin", "run_double"]);
    for (const [group, share] of [[split.share, true], [split.rest, false]] as const) {
      const members = ofGroup(share);
      expect(group.players).toBe(members.length);
      expect(group.d1Eligible).toBe(members.length);
      expect(group.d1Returned).toBe(count(ids.slice(0, 8), members));
      expect(group.d7Returned).toBe(count(ids.slice(0, 4), members));
      expect(group.payers).toBe(count([ids[0]!], members));
      expect(group.stars).toEqual(members.includes(ids[0]!) ? { sum: 300, sumSq: 90_000 } : { sum: 0, sumSq: 0 });
      expect(group.runs.sum).toBe(count([ids[0]!, ids[0]!, ids[0]!, ids[3]!], members));
      expect(group.interstitials.sum).toBe(count([ids[0]!], members));
      expect(group.rewarded.sum).toBe(count([ids[1]!], members));
    }
    // Обе доли не пусты: иначе проверка корзины ничего не доказала бы.
    expect(split.share.players).toBeGreaterThan(0);
    expect(split.rest.players).toBeGreaterThan(0);

    // Через три дня D7 созреть ещё не мог ни у кого; площадка вне флага — пустая когорта.
    const early = await flagSplitReport(prisma, rule, new Date(day - HOUR), new Date(day + 2 * HOUR), new Date(day + 3 * 24 * HOUR), []);
    expect(early.share.d7Eligible + early.rest.d7Eligible).toBe(0);
    expect(early.share.d1Eligible + early.rest.d1Eligible).toBe(24);
    const elsewhere = await flagSplitReport(prisma, { ...rule, platforms: ["vk"] }, new Date(day - HOUR), new Date(day + 2 * HOUR), later, []);
    expect(elsewhere.share.players + elsewhere.rest.players).toBe(0);
  });
});
