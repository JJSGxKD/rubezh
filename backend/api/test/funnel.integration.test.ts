import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaSessionsRepository } from "../src/modules/attribution/sessions.repository.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { bucketOf } from "../src/modules/flags/flag-rollout.js";
import { flagSplitReport } from "../src/modules/funnel/flag-split-report.js";
import { funnelMarked, funnelReport, partnerFunnelReport } from "../src/modules/funnel/funnel-report.js";
import { PrismaPartnersRepository } from "../src/modules/partners/partners.repository.js";
import { PrismaFunnelRepository } from "../src/modules/funnel/funnel.repository.js";
import { newClickId, newLinkCode } from "../src/modules/links/link-code.js";
import { vi } from "vitest";
import type { Account } from "../src/modules/auth/account.repository.js";
import { AdminReviewController } from "../src/modules/admin/admin-review.controller.js";
import { PrismaBoardMarkReader } from "../src/modules/admin/board-mark.reader.js";
import type { Role } from "../src/modules/roles/permissions.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import type { ReviewRow } from "../src/modules/runs/runs.repository.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

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

/**
 * Метка «Отдельная доска» в воронке и разборе забегов (T-0115). Окно — в 2019
 * году, раньше любых видов соседних тестов; виды этого блока кончаются до 2020.
 */
describe.skipIf(DATABASE_URL === "")("метка «Отдельная доска» в воронке и разборе", () => {
  const FROM = new Date("2019-06-10T00:00:00Z");
  const TO = new Date("2019-06-11T00:00:00Z");
  const at = (hours: number) => new Date(FROM.getTime() + hours * HOUR);
  let prisma: PrismaClient;
  let reader: PrismaBoardMarkReader;
  const ids: Record<string, string> = {};

  async function player(name: string, milestones: { entered?: number; appOpened?: number; firstRunStarted?: number; firstPurchase?: number }, view: "active" | "lifted" | null): Promise<void> {
    const accountId = randomUUID();
    ids[name] = accountId;
    await prisma.account.create({ data: { accountId, platform: "telegram", platformUserId: `fm-${accountId.slice(0, 8)}`, displayName: name, createdAt: at(0), lastSeenAt: at(0) } });
    await prisma.accountFunnel.create({
      data: {
        accountId,
        enteredAt: milestones.entered === undefined ? null : at(milestones.entered),
        appOpenedAt: milestones.appOpened === undefined ? null : at(milestones.appOpened),
        firstRunStartedAt: milestones.firstRunStarted === undefined ? null : at(milestones.firstRunStarted),
        firstPurchaseAt: milestones.firstPurchase === undefined ? null : at(milestones.firstPurchase),
      },
    });
    if (view === null) return;
    await prisma.accountRestriction.create({
      data: {
        accountId,
        kind: "separate_board",
        startsAt: new Date("2019-05-01T00:00:00Z"),
        endsAt: new Date("2019-07-01T00:00:00Z"),
        liftedAt: view === "lifted" ? new Date("2019-06-01T00:00:00Z") : null,
        liftComment: view === "lifted" ? "снято" : null,
        reason: "other",
        notify: false,
      },
    });
  }

  async function staff(role: Role) {
    const accounts = new MemoryAccountRepository();
    const rolesRepository = new MemoryRolesRepository();
    const roles = new RolesService(loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv), rolesRepository, accounts);
    const account: Account = await accounts.upsert({ platform: "telegram", platformUserId: "9", displayName: "Сотрудник", username: null, photoUrl: null }, Date.now());
    await rolesRepository.grant(account.accountId, role, null);
    return { roles, request: { account: { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId } } };
  }

  async function controller(role: Role, rows: ReviewRow[]) {
    const { roles, request } = await staff(role);
    const runs = { review: async () => rows };
    const accounts = { displayNames: async () => new Map<string, string>() };
    const funnel = new PrismaFunnelRepository(prisma);
    return { request, controller: new AdminReviewController(runs as never, funnel, accounts as never, {} as never, roles, reader) };
  }

  const flagged = (name: string, finishedAt: Date): ReviewRow => ({ runId: `fm-${name}`, accountId: ids[name]!, verdict: "suspicious", verdictReasons: [], difficulty: "easy", survivalSec: 60, level: 1, enemiesKilled: 1, finishedAt });

  beforeAll(async () => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
    reader = new PrismaBoardMarkReader(prisma);
    await player("m1", { entered: 1, appOpened: 1, firstRunStarted: 2 }, "active");
    await player("m2", { entered: 2, appOpened: 2, firstPurchase: 5 }, "active");
    // Помечен, но когорта не в окне: первый контакт днём позже.
    await player("m3", { entered: 30, appOpened: 30 }, "active");
    await player("p1", { entered: 1, appOpened: 1 }, null);
    // Вид снят до окна: не помечен.
    await player("p2", { entered: 3, appOpened: 3 }, "lifted");
  });

  afterAll(async () => {
    await prisma.account.deleteMany({ where: { accountId: { in: Object.values(ids) } } });
    await prisma.$disconnect();
  });

  it("сводная строка по помеченным: те же числа вех, когорта по первому контакту в окне", async () => {
    expect(await funnelMarked(prisma, FROM, TO)).toEqual({
      accounts: 2,
      entered: 2,
      appOpened: 2,
      firstRunStarted: 1,
      firstRunFinished: 0,
      runs2: 0,
      runs5: 0,
      returnedD1: 0,
      returnedD7: 0,
      firstPurchase: 1,
    });
  });

  it("окно без помеченных — нули, а не пропавшая строка", async () => {
    expect(await funnelMarked(prisma, new Date("2018-01-01T00:00:00Z"), new Date("2018-01-02T00:00:00Z"))).toMatchObject({ accounts: 0, entered: 0, firstPurchase: 0 });
  });

  it("маршрут воронки: `marked` только у держателя права players.board.restrict", async () => {
    const owner = await controller("owner", []);
    const query = { from: FROM.toISOString(), to: TO.toISOString() };
    const full = await owner.controller.funnelReport(owner.request, query);
    expect(full.data.marked).toMatchObject({ accounts: 2, entered: 2 });

    const analyst = await controller("analyst", []);
    const plain = await analyst.controller.funnelReport(analyst.request, query);
    expect("marked" in plain.data).toBe(false);
    expect(plain.data.rows).toEqual(full.data.rows);
  });

  it("разбор забегов: `boardMarked` у нужных строк владельцу, одним запросом на страницу; остальным поля нет", async () => {
    const rows = [flagged("m1", at(3)), flagged("p1", at(4)), flagged("m2", at(5)), flagged("p2", at(6))];
    const owner = await controller("owner", rows);
    const spy = vi.spyOn(reader, "ids");
    const seen = await owner.controller.review(owner.request, undefined);
    expect(seen.data.runs.map((run) => [run.runId, run.boardMarked])).toEqual([
      ["fm-m1", true],
      ["fm-p1", false],
      ["fm-m2", true],
      ["fm-p2", false],
    ]);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockClear();
    const moderator = await controller("moderator", rows);
    const hidden = await moderator.controller.review(moderator.request, undefined);
    expect(hidden.data.runs.every((run) => !("boardMarked" in run))).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("отчёт `funnelReport` метки не знает: до и после снятия видов он тот же", async () => {
    const before = await funnelReport(prisma, FROM, TO);
    await prisma.accountRestriction.deleteMany({ where: { accountId: { in: Object.values(ids) } } });
    expect(await funnelReport(prisma, FROM, TO)).toEqual(before);
    expect(before.reduce((sum, row) => sum + row.accounts, 0)).toBe(4);
  });
  describe("прямые ссылки и воронка партнёра (T-0068, Р96)", () => {
    const WINDOW_FROM = new Date(T0 - HOUR);
    const WINDOW_TO = new Date(T0 + 24 * HOUR);

    async function touchSession(accountId: string, startKind: "link" | "click", startRef: string): Promise<void> {
      await new PrismaSessionsRepository(prisma).record({
        sessionId: randomUUID(),
        accountId,
        platform: "telegram",
        place: "channel",
        startKind,
        startParam: `${startKind === "link" ? "l" : "c"}-${startRef}`,
        startRef,
        clientPlatform: null,
        clientVersion: null,
        deviceClass: "unknown",
        os: "unknown",
        ipPrefix: null,
        startedAt: new Date(T0).toISOString(),
      });
      await funnel.entered(accountId, new Date(T0));
    }

    it("аккаунт с первым касанием «прямая ссылка» стоит в отчёте под кампанией своей ссылки, как клик; без ссылки — кампании нет", async () => {
      const campaign = `direct-${randomUUID().slice(0, 8)}`;
      const code = newLinkCode();
      await prisma.link.create({ data: { code, campaign, source: "tg_ads" } });
      const [first, second, orphan] = [await account(), await account(), await account()];
      await touchSession(first, "link", code);
      await touchSession(second, "link", code);
      // Клик той же ссылки — в той же строке: прямая ссылка и переходник сравниваются как одна кампания.
      const clickId = newClickId();
      await prisma.linkClick.create({ data: { clickId, linkCode: code } });
      await touchSession(await account(), "click", clickId);
      await touchSession(orphan, "link", newLinkCode());

      const report = await funnelReport(prisma, WINDOW_FROM, WINDOW_TO);

      expect(report.filter((line) => line.startRef === campaign)).toEqual([expect.objectContaining({ platform: "telegram", startKind: "click", startSource: "tg_ads", accounts: 3, entered: 3 })]);
      // Ссылка удалена или кода нет — кампания пуста, а в строку «неизвестно» не уходит.
      expect(report.some((line) => line.startKind === "link")).toBe(false);
    });

    /** Партнёр, ссылка и код партнёра. */
    async function setupPartner(name: string) {
      const partnerId = randomUUID();
      const long = new Date(Date.UTC(2020, 0, 1));
      await new PrismaPartnersRepository(prisma).create({ partnerId, name, contact: null, note: null, createdBy: randomUUID(), createdAt: long, updatedAt: long });
      const linkCode = newLinkCode();
      const campaign = `p-${randomUUID().slice(0, 8)}`;
      await prisma.link.create({ data: { code: linkCode, campaign, source: null, partnerId } });
      const campaignId = randomUUID();
      const title = `Код ${randomUUID().slice(0, 6)}`;
      await prisma.$executeRaw`
        INSERT INTO promo_campaign (campaign_id, title, kind, reward, max_redemptions, redeemed, starts_at, ends_at, created_by, created_at, updated_at, partner_id)
        VALUES (${campaignId}::uuid, ${title}, 'shared', '{}'::jsonb, NULL, 0, ${new Date(T0)}, NULL, ${randomUUID()}::uuid, ${new Date(T0)}, ${new Date(T0)}, ${partnerId}::uuid)`;
      return { partnerId, linkCode, campaign, campaignId, title };
    }

    async function bind(accountId: string, partnerId: string, boundAt: Date, via: { linkCode?: string; campaignId?: string }): Promise<void> {
      await prisma.partnerBinding.create({ data: { accountId, partnerId, boundAt, linkCode: via.linkCode ?? null, campaignId: via.campaignId ?? null } });
    }

    async function milestones(accountId: string, steps: Partial<Record<"enteredAt" | "appOpenedAt" | "firstRunStartedAt" | "firstRunFinishedAt" | "runs2At" | "runs5At" | "returnedD1At" | "returnedD7At" | "firstPurchaseAt", boolean>>): Promise<void> {
      const at = new Date(T0);
      await prisma.accountFunnel.create({ data: { accountId, ...Object.fromEntries(Object.entries(steps).filter(([, on]) => on).map(([key]) => [key, at])) } });
    }

    it("воронка партнёра: двое по ссылке и один по коду — всего три, две строки источников, вехи верны; чужой партнёр и привязка вне окна не видны", async () => {
      const mine = await setupPartner("Мой");
      const other = await setupPartner("Чужой");
      const [byLinkA, byLinkB, byCode, foreign, early] = [await account(), await account(), await account(), await account(), await account()];
      await milestones(byLinkA, { enteredAt: true, appOpenedAt: true, firstRunStartedAt: true, firstRunFinishedAt: true });
      await milestones(byLinkB, { enteredAt: true, appOpenedAt: true });
      await milestones(byCode, { enteredAt: true, appOpenedAt: true, firstRunStartedAt: true, firstRunFinishedAt: true, runs2At: true, firstPurchaseAt: true });
      await milestones(foreign, { enteredAt: true, appOpenedAt: true, firstPurchaseAt: true });
      await milestones(early, { enteredAt: true, appOpenedAt: true });
      await bind(byLinkA, mine.partnerId, new Date(T0), { linkCode: mine.linkCode });
      await bind(byLinkB, mine.partnerId, new Date(T0 + HOUR), { linkCode: mine.linkCode });
      await bind(byCode, mine.partnerId, new Date(T0 + 2 * HOUR), { campaignId: mine.campaignId });
      await bind(foreign, other.partnerId, new Date(T0), { linkCode: other.linkCode });
      // Привязан к партнёру давно — по дате привязки в окно не попадает, хотя вехи свежие.
      await bind(early, mine.partnerId, new Date(T0 - 40 * 24 * HOUR), { linkCode: mine.linkCode });

      const rows = await partnerFunnelReport(prisma, mine.partnerId, WINDOW_FROM, WINDOW_TO);

      const total = rows.reduce((sum, row) => sum + row.accounts, 0);
      expect(total).toBe(3);
      const link = rows.filter((row) => row.via === "link");
      const code = rows.filter((row) => row.via === "code");
      expect(link).toEqual([expect.objectContaining({ platform: "telegram", viaName: mine.campaign, viaRef: mine.linkCode, accounts: 2, entered: 2, appOpened: 2, firstRunStarted: 1, firstRunFinished: 1, runs2: 0, firstPurchase: 0 })]);
      expect(code).toEqual([expect.objectContaining({ platform: "telegram", viaName: mine.title, viaRef: mine.campaignId, accounts: 1, entered: 1, firstRunStarted: 1, runs2: 1, firstPurchase: 1 })]);
      expect(rows).toHaveLength(2);

      // Чужой партнёр — своя воронка; у партнёра без привязок — пусто.
      const theirs = await partnerFunnelReport(prisma, other.partnerId, WINDOW_FROM, WINDOW_TO);
      expect(theirs.reduce((sum, row) => sum + row.accounts, 0)).toBe(1);
      expect(await partnerFunnelReport(prisma, randomUUID(), WINDOW_FROM, WINDOW_TO)).toEqual([]);
    });

    it("окно — по дате привязки, а не по первому контакту: левая граница включительно, правая исключительно", async () => {
      const partner = await setupPartner("Окно");
      const [inside, onFrom, onTo] = [await account(), await account(), await account()];
      for (const id of [inside, onFrom, onTo]) await milestones(id, { enteredAt: true });
      await bind(inside, partner.partnerId, new Date(T0), { linkCode: partner.linkCode });
      await bind(onFrom, partner.partnerId, WINDOW_FROM, { linkCode: partner.linkCode });
      await bind(onTo, partner.partnerId, WINDOW_TO, { linkCode: partner.linkCode });

      const rows = await partnerFunnelReport(prisma, partner.partnerId, WINDOW_FROM, WINDOW_TO);

      expect(rows.reduce((sum, row) => sum + row.accounts, 0)).toBe(2);
    });

    it("игрок без строки воронки всё равно считается в «всех», а вехи у него нули; ссылка и код с разных площадок — разные строки", async () => {
      const partner = await setupPartner("Площадки");
      const bare = await account();
      await bind(bare, partner.partnerId, new Date(T0), { linkCode: partner.linkCode });
      const max = await accounts.upsert({ platform: "max", platformUserId: String(Math.floor(Math.random() * 1e12)), displayName: "Из MAX", username: null, photoUrl: null }, Date.now());
      await milestones(max.accountId, { enteredAt: true });
      await bind(max.accountId, partner.partnerId, new Date(T0), { linkCode: partner.linkCode });

      const rows = await partnerFunnelReport(prisma, partner.partnerId, WINDOW_FROM, WINDOW_TO);

      expect(rows.map((row) => [row.platform, row.accounts, row.entered]).sort()).toEqual([["max", 1, 1], ["telegram", 1, 0]]);
    });

    it("ссылка удалена: привязка остаётся, строка источника — «ссылка» без названия; удалён и код — тоже без названия", async () => {
      const partner = await setupPartner("Удалённые");
      const [viaLink, viaCode] = [await account(), await account()];
      await bind(viaLink, partner.partnerId, new Date(T0), { linkCode: partner.linkCode });
      await bind(viaCode, partner.partnerId, new Date(T0), { campaignId: partner.campaignId });
      await prisma.link.delete({ where: { code: partner.linkCode } });

      const rows = await partnerFunnelReport(prisma, partner.partnerId, WINDOW_FROM, WINDOW_TO);

      // Удалённая ссылка обнуляет `link_code` привязки: она читается как привязка кодом без названия кампании.
      expect(rows.reduce((sum, row) => sum + row.accounts, 0)).toBe(2);
      expect(rows.every((row) => row.via === "code")).toBe(true);
    });
  });
});
