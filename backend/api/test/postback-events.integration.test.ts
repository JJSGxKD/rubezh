import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { Prisma, type PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { CONVERSION_WINDOWS } from "../src/modules/ad-conversions/conversion-rules.js";
import { PrismaConversionsRepository, type DueConversion } from "../src/modules/ad-conversions/conversions.repository.js";
import { AdConversionsService } from "../src/modules/ad-conversions/conversions.service.js";
import { AdsgramDestination } from "../src/modules/ad-conversions/destinations/adsgram.destination.js";
import { TARGETS_SELECT } from "../src/modules/ad-conversions/destinations/destination-targets.js";
import { TemplateDestination } from "../src/modules/ad-conversions/destinations/template.destination.js";
import { PrismaSessionsRepository } from "../src/modules/attribution/sessions.repository.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { newClickId, newLinkCode } from "../src/modules/links/link-code.js";
import { PrismaLinksRepository } from "../src/modules/links/links.repository.js";

/**
 * Покупки и возврат на следующий день в постбэках на живом Postgres (tasks/T-0071, docs/35-stage4-plan.md
 * Р86, Р96, О39): возврат — засчитанный забег в следующие игровые сутки (полночь по Москве) после дня
 * первого засчитанного забега, один на клик и назначение, только там, где выбран. Время проходов — параметром
 * `sweep(now)`, поэтому даты забегов и кликов здесь абсолютные. Без базы — пропуск.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const MINUTE = 60_000;
const ADDRESS = "https://track.example.com/pb?cid={click_id}&e={event}&id={event_id}&a={amount}&c={currency}";
const PARAMS = { click_id: "k1", sub1: "x-y" };
const PUBLIC_IP = async () => ["93.184.216.34"];
/** Момент, с которого действуют адреса тестов: раньше любого клика ниже. */
const SINCE = new Date("2026-10-01T00:00:00Z");
/** «Сейчас» проходов по возвратам: через двое суток после основного клика. */
const NOW = new Date("2026-10-12T12:00:00Z");
const CLICK = new Date("2026-10-10T18:00:00Z");
const ALL = ["registration", "purchase_first", "purchase_repeat", "d1_return"];

/** Проход по настоящему набору назначений, но только по ссылкам этого файла: схема общая. */
class Scoped extends PrismaConversionsRepository {
  constructor(
    prisma: PrismaClient,
    private readonly codes: readonly string[],
  ) {
    super(prisma);
  }
  protected override targets(): Prisma.Sql {
    return Prisma.sql`all_targets(link_code, destination, events, since) AS (${TARGETS_SELECT}),
      targets(link_code, destination, events, since) AS (SELECT * FROM all_targets WHERE link_code IN (${Prisma.join(this.codes)}))`;
  }
}

/** Очередь только из названных конверсий; срок повтора не смотрим, обнуление параметров не трогаем. */
class OnlyThese extends PrismaConversionsRepository {
  constructor(
    prisma: PrismaClient,
    private readonly ids: readonly string[],
  ) {
    super(prisma);
  }
  override async sweep(): Promise<{ registrations: number; purchases: number }> {
    return { registrations: 0, purchases: 0 };
  }
  override async due(_now: Date, limit: number): Promise<DueConversion[]> {
    return (await super.due(new Date(Date.now() + 400 * 24 * 60 * MINUTE), 1_000)).filter((row) => this.ids.includes(row.conversionId)).slice(0, limit);
  }
  override async purgeParams(): Promise<number> {
    return 0;
  }
}

const FREE_LOCK = {
  async set(): Promise<"OK"> {
    return "OK";
  },
  async eval(): Promise<number> {
    return 1;
  },
};

describe.skipIf(DATABASE_URL === "")("возврат на следующий день и покупки в постбэках на живом Postgres", () => {
  let prisma: PrismaClient;
  let conversions: Scoped;
  let links: PrismaLinksRepository;
  let accounts: PrismaAccountRepository;
  let sessions: PrismaSessionsRepository;
  const linkCodes: string[] = [];
  const partnerIds: string[] = [];

  beforeAll(() => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
    conversions = new Scoped(prisma, linkCodes);
    links = new PrismaLinksRepository(prisma);
    accounts = new PrismaAccountRepository(prisma);
    sessions = new PrismaSessionsRepository(prisma);
  });

  afterAll(async () => {
    await prisma.link.deleteMany({ where: { code: { in: linkCodes } } });
    await prisma.partner.deleteMany({ where: { partnerId: { in: partnerIds } } });
    await prisma.$disconnect();
  });

  /** Ссылка со своим адресом: без сети, с сетью AdsGram или у партнёра; события — как выбраны. */
  async function newLink(patch: { network?: "adsgram"; events?: string[]; address?: boolean; since?: Date; partnerId?: string } = {}): Promise<string> {
    const code = newLinkCode();
    linkCodes.push(code);
    await links.create({
      code,
      platform: "telegram",
      campaign: "d1-test",
      source: "tg",
      medium: null,
      note: null,
      createdBy: null,
      network: patch.network ?? null,
      registrationOn: "launch",
      ...(patch.partnerId === undefined ? {} : { partnerId: patch.partnerId }),
    });
    if (patch.address !== false) {
      await prisma.link.update({
        where: { code },
        data: { postbackUrl: ADDRESS, postbackSince: patch.since ?? SINCE, postbackEvents: patch.events ?? [...ALL] },
      });
    }
    return code;
  }

  /** Новичок по клику: клик в `clickAt`, аккаунт заведён через 30 секунд (или раньше — `createdAt`), первое касание — клик. */
  async function newcomer(code: string, clickAt: Date, patch: { team?: boolean; createdAt?: Date; params?: Record<string, string> | null } = {}) {
    const clickId = newClickId();
    await links.recordClick({
      clickId,
      linkCode: code,
      at: clickAt,
      utm: { source: null, medium: null, campaign: null, content: null, term: null },
      refererHost: null,
      deviceClass: "mobile",
      ipPrefix: null,
      language: null,
      networkParams: patch.params === undefined ? PARAMS : patch.params,
    });
    const launchedAt = new Date(clickAt.getTime() + 30_000);
    const account = await accounts.upsert(
      { platform: "telegram", platformUserId: String(5_000_000_000 + Math.floor(Math.random() * 900_000_000)), displayName: "Из рекламы", username: null, photoUrl: null },
      (patch.createdAt ?? launchedAt).getTime(),
    );
    if (patch.team === true) await prisma.accountRole.create({ data: { accountId: account.accountId, role: "marketer" } });
    await launch(account.accountId, "click", `c-${clickId}`, clickId, launchedAt);
    return { clickId, accountId: account.accountId };
  }

  /** Новичок по прямой ссылке `l-<код>`: клика нет. */
  async function direct(code: string, at: Date) {
    const account = await accounts.upsert(
      { platform: "telegram", platformUserId: String(5_000_000_000 + Math.floor(Math.random() * 900_000_000)), displayName: "По прямой", username: null, photoUrl: null },
      at.getTime(),
    );
    await launch(account.accountId, "link", `l-${code}`, code, at);
    return { accountId: account.accountId };
  }

  async function launch(accountId: string, kind: "click" | "link", startParam: string, startRef: string, startedAt: Date) {
    await sessions.record({
      sessionId: randomUUID(),
      accountId,
      platform: "telegram",
      place: "miniapp",
      startKind: kind,
      startParam,
      startRef,
      clientPlatform: "android",
      clientVersion: "8.0",
      deviceClass: "mobile",
      os: "android",
      ipPrefix: null,
      startedAt: startedAt.toISOString(),
    });
  }

  /** Забег, законченный в `finishedAt`; по умолчанию засчитанный. */
  async function run(accountId: string, finishedAt: string | Date | null, patch: { survivalSec?: number; cheats?: boolean; verdict?: "ok" | "suspicious" | "rejected" } = {}) {
    const finished = finishedAt === null ? null : new Date(finishedAt);
    const survivalSec = patch.survivalSec ?? 95;
    await prisma.run.create({
      data: {
        runId: `d1-${randomUUID()}`,
        accountId,
        status: finished === null ? "started" : "finished",
        difficulty: "normal",
        startingWeaponId: "spark",
        contentHash: "abc",
        startedAt: new Date((finished ?? CLICK).getTime() - survivalSec * 1000),
        ...(finished === null ? {} : { finishedAt: finished, outcome: "died" as const, survivalSec }),
        cheats: patch.cheats ?? false,
        ...(patch.verdict === undefined ? {} : { verdict: patch.verdict }),
        verdictReasons: [],
      },
    });
  }

  async function purchase(accountId: string, paidMinutesAgo: number, patch: { mode?: "live" | "test"; refunded?: boolean; chargedStars?: number } = {}) {
    const purchaseId = randomUUID();
    const paidAt = new Date(Date.now() - paidMinutesAgo * MINUTE);
    await prisma.purchase.create({
      data: {
        purchaseId,
        accountId,
        product: "shop_item",
        sku: "gems_small",
        priceStars: 50,
        chargedStars: patch.chargedStars ?? 50,
        mode: patch.mode ?? "live",
        status: patch.refunded === true ? "refunded" : "paid",
        invoicedAt: paidAt,
        paidAt,
        ...(patch.refunded === true ? { refundRequestedAt: new Date(), refundedAt: new Date() } : {}),
      },
    });
    return purchaseId;
  }

  const ofAccount = (accountId: string) => prisma.adConversion.findMany({ where: { accountId }, orderBy: [{ goal: "asc" }, { destination: "asc" }] });
  const returnsOf = async (accountId: string) => (await ofAccount(accountId)).filter((row) => row.goal === 4);
  const shape = async (accountId: string) => (await ofAccount(accountId)).map((row) => [row.goal, row.destination]);

  /** Новичок с двумя забегами: первый засчитанный и второй в назначенное время. */
  async function twoRuns(code: string, first: string, second: string, clickAt: Date = CLICK) {
    const player = await newcomer(code, clickAt);
    await run(player.accountId, first);
    await run(player.accountId, second);
    return player;
  }

  async function sendThese(ids: readonly string[], respond: (url: string) => Response = () => new Response("ok", { status: 200 })) {
    const service = new AdConversionsService(
      loadAppConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv),
      new OnlyThese(prisma, ids),
      [new AdsgramDestination({ get: () => "tok_integration" }), new TemplateDestination("s2s", PUBLIC_IP), new TemplateDestination("partner", PUBLIC_IP)],
      FREE_LOCK as never,
    );
    const calls: URL[] = [];
    const fetchImpl = (async (input: URL | string) => {
      calls.push(new URL(String(input)));
      return respond(String(input));
    }) as typeof fetch;
    const report = await service.tick(new Date(), fetchImpl);
    return { report, calls };
  }

  // --- Граница игровых суток ---

  it("граница суток по Москве: первый забег 23:59 МСК, второй 00:01 МСК — возврат; в тот же день и через день — нет", async () => {
    const code = await newLink();
    const next = await twoRuns(code, "2026-10-10T20:59:00Z", "2026-10-10T21:01:00Z");
    const sameDay = await twoRuns(code, "2026-10-10T20:59:00Z", "2026-10-10T20:59:30Z");
    const dayAfterNext = await twoRuns(code, "2026-10-10T20:59:00Z", "2026-10-11T21:01:00Z");
    await conversions.sweep(NOW);

    expect(await returnsOf(next.accountId)).toMatchObject([{ goal: 4, destination: "s2s", network: "s2s", status: "pending", linkCode: code, clickId: next.clickId, purchaseId: null }]);
    expect(await returnsOf(sameDay.accountId)).toEqual([]);
    expect(await returnsOf(dayAfterNext.accountId)).toEqual([]);
  });

  it("день регистрации — день первого засчитанного забега, а не создания аккаунта", async () => {
    const code = await newLink();
    // Аккаунт создан 10.10, первый засчитанный забег 11.10, второй 12.10: возврат по забегу 12.10.
    const late = await newcomer(code, CLICK);
    await run(late.accountId, "2026-10-10T19:00:00Z", { survivalSec: 10 });
    await run(late.accountId, "2026-10-11T10:00:00Z");
    // Единственный засчитанный забег 11.10 — это регистрация, а не возврат.
    const single = await newcomer(code, CLICK);
    await run(single.accountId, "2026-10-11T10:00:00Z");
    // Короткий забег 10.10 днём регистрации не делает: регистрация — 11.10, возврата в тот же день нет.
    const shortFirst = await newcomer(code, CLICK);
    await run(shortFirst.accountId, "2026-10-10T19:00:00Z", { survivalSec: 10 });
    await run(shortFirst.accountId, "2026-10-11T10:00:00Z");

    await conversions.sweep(new Date("2026-10-11T12:00:00Z"));
    expect(await returnsOf(late.accountId)).toEqual([]);
    expect(await returnsOf(single.accountId)).toEqual([]);
    expect(await returnsOf(shortFirst.accountId)).toEqual([]);

    await run(late.accountId, "2026-10-12T10:00:00Z");
    await run(single.accountId, "2026-10-12T10:00:00Z");
    await conversions.sweep(NOW);
    expect(await returnsOf(late.accountId)).toHaveLength(1);
    expect(await returnsOf(single.accountId)).toHaveLength(1);
    // У третьего второго засчитанного забега так и нет: короткий забег 10.10 днём регистрации не был.
    expect(await returnsOf(shortFirst.accountId)).toEqual([]);
  });

  it("первый засчитанный забег должен попасть в окно регистрации от клика: на восьмые сутки возврата нет, на седьмые — есть", async () => {
    const code = await newLink();
    // Окно регистрации кончается через семь суток после клика: 09.10 18:00Z. Первый забег на час позже.
    const tooLate = await twoRuns(code, "2026-10-09T19:00:00Z", "2026-10-10T10:00:00Z", new Date("2026-10-02T18:00:00Z"));
    const inWindow = await twoRuns(code, "2026-10-10T17:00:00Z", "2026-10-11T10:00:00Z", new Date("2026-10-03T18:00:00Z"));
    await conversions.sweep(new Date("2026-10-11T12:00:00Z"));
    expect(await returnsOf(tooLate.accountId)).toEqual([]);
    expect(await returnsOf(inWindow.accountId)).toHaveLength(1);
  });

  it("первое касание старше окна просмотра возвратов не перебирается", async () => {
    expect(CONVERSION_WINDOWS.returnLookbackDays).toBe(CONVERSION_WINDOWS.registrationDays + 2);
    const code = await newLink();
    const now = new Date("2026-10-20T12:00:00Z");
    // Порог — 11.10 12:00Z (девять суток до `now`): один клик на три часа старше, другой на три часа новее.
    const old = await twoRuns(code, "2026-10-11T10:00:00Z", "2026-10-12T10:00:00Z", new Date("2026-10-11T09:00:00Z"));
    const fresh = await twoRuns(code, "2026-10-11T16:00:00Z", "2026-10-12T10:00:00Z", new Date("2026-10-11T15:00:00Z"));
    await conversions.sweep(now);
    expect(await returnsOf(old.accountId)).toEqual([]);
    expect(await returnsOf(fresh.accountId)).toHaveLength(1);
  });

  // --- Какие забеги и какие игроки ---

  it("короткий, с читами, rejected и не завершённый забеги возвратом не считаются; suspicious считается", async () => {
    const code = await newLink();
    const bad: { accountId: string }[] = [];
    for (const patch of [{ survivalSec: 12 }, { cheats: true }, { verdict: "rejected" as const }]) {
      const player = await newcomer(code, CLICK);
      await run(player.accountId, "2026-10-10T19:00:00Z");
      await run(player.accountId, "2026-10-11T10:00:00Z", patch);
      bad.push(player);
    }
    const unfinished = await newcomer(code, CLICK);
    await run(unfinished.accountId, "2026-10-10T19:00:00Z");
    await run(unfinished.accountId, null);
    const suspicious = await twoRuns(code, "2026-10-10T19:00:00Z", "2026-10-11T10:00:00Z");
    await prisma.run.updateMany({ where: { accountId: suspicious.accountId }, data: { verdict: "suspicious" } });

    await conversions.sweep(NOW);
    for (const player of [...bad, unfinished]) expect(await returnsOf(player.accountId)).toEqual([]);
    expect(await returnsOf(suspicious.accountId)).toHaveLength(1);
  });

  it("события нет в списке — строки нет; есть — есть; клик раньше postback_since и старый аккаунт — не конверсия", async () => {
    const without = await newLink({ events: ["registration", "purchase_first", "purchase_repeat"] });
    const only = await newLink({ events: ["d1_return"] });
    const late = await newLink({ since: new Date("2026-10-10T18:30:00Z") });
    const a = await twoRuns(without, "2026-10-10T19:00:00Z", "2026-10-11T10:00:00Z");
    const b = await twoRuns(only, "2026-10-10T19:00:00Z", "2026-10-11T10:00:00Z");
    const c = await twoRuns(late, "2026-10-10T19:00:00Z", "2026-10-11T10:00:00Z");
    // Старый игрок: аккаунт заведён за час до клика — привела его не реклама.
    const veteran = await newcomer(only, CLICK, { createdAt: new Date("2026-10-10T17:00:00Z") });
    await run(veteran.accountId, "2026-10-10T19:00:00Z");
    await run(veteran.accountId, "2026-10-11T10:00:00Z");

    await conversions.sweep(NOW);
    expect(await returnsOf(a.accountId)).toEqual([]);
    expect(await shape(b.accountId)).toEqual([[4, "s2s"]]);
    expect(await ofAccount(c.accountId)).toEqual([]);
    expect(await ofAccount(veteran.accountId)).toEqual([]);
  });

  it("ссылка AdsGram: возврата в AdsGram нет; со своим адресом возврат уходит только на адрес", async () => {
    const plain = await newLink({ network: "adsgram", address: false });
    const own = await newLink({ network: "adsgram", events: ["d1_return"] });
    const a = await twoRuns(plain, "2026-10-10T19:00:00Z", "2026-10-11T10:00:00Z");
    const b = await twoRuns(own, "2026-10-10T19:00:00Z", "2026-10-11T10:00:00Z");
    await conversions.sweep(NOW);
    expect(await returnsOf(a.accountId)).toEqual([]);
    expect(await returnsOf(b.accountId)).toMatchObject([{ goal: 4, destination: "s2s" }]);
  });

  it("ссылка партнёра: возврат — по событиям того, чей адрес действует", async () => {
    const partnerId = randomUUID();
    partnerIds.push(partnerId);
    await prisma.partner.create({
      data: {
        partnerId,
        name: `Тест ${partnerId.slice(0, 8)}`,
        createdBy: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
        postbackUrl: ADDRESS,
        postbackSince: SINCE,
        postbackEvents: ["registration", "d1_return"],
      },
    });
    const shared = await newLink({ partnerId, address: false });
    // Свой адрес ссылки важнее: у него события без возврата.
    const own = await newLink({ partnerId, events: ["registration"] });
    const a = await twoRuns(shared, "2026-10-10T19:00:00Z", "2026-10-11T10:00:00Z");
    const b = await twoRuns(own, "2026-10-10T19:00:00Z", "2026-10-11T10:00:00Z");
    await conversions.sweep(NOW);
    expect(await returnsOf(a.accountId)).toMatchObject([{ destination: "partner" }]);
    expect(await returnsOf(b.accountId)).toEqual([]);
  });

  it("аккаунт команды: возврат пишется пропущенным с причиной team", async () => {
    const code = await newLink();
    const team = await newcomer(code, CLICK, { team: true });
    await run(team.accountId, "2026-10-10T19:00:00Z");
    await run(team.accountId, "2026-10-11T10:00:00Z");
    await conversions.sweep(NOW);
    expect(await returnsOf(team.accountId)).toMatchObject([{ status: "skipped", reason: "team" }]);
  });

  it("повтор и два параллельных прохода: ровно одна строка на клик и назначение; второй забег того же дня её не множит", async () => {
    const code = await newLink({ network: "adsgram" });
    const player = await twoRuns(code, "2026-10-10T19:00:00Z", "2026-10-11T10:00:00Z");
    await run(player.accountId, "2026-10-11T11:00:00Z");
    await Promise.all([conversions.sweep(NOW), conversions.sweep(NOW), conversions.sweep(NOW)]);
    await conversions.sweep(NOW);
    const rows = await returnsOf(player.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ destination: "s2s", clickId: player.clickId });
  });

  // --- Прямой запуск возвратов не порождает ---

  it("ссылка AdsGram: новичок по l-<код> играет засчитанный забег сегодня и завтра — строк goal = 4 нет", async () => {
    const code = await newLink({ network: "adsgram" });
    const player = await direct(code, CLICK);
    await run(player.accountId, "2026-10-10T19:00:00Z");
    await run(player.accountId, "2026-10-11T10:00:00Z");
    await conversions.sweep(NOW);
    await conversions.sweep(NOW);
    const rows = await ofAccount(player.accountId);
    expect(rows.filter((row) => row.goal === 4)).toEqual([]);
    // Регистрация по прямому запуску AdsGram работает как раньше.
    expect(rows.map((row) => [row.goal, row.destination, row.clickId])).toEqual([[1, "adsgram", null]]);
  });

  // --- Покупки на адрес ---

  it("покупки на s2s: первая настоящая — цель 2, вторая — 3; тестовая, возвращённая и не отлежавшая 10 минут не уходят", async () => {
    const code = await newLink({ events: ["registration", "purchase_first", "purchase_repeat"] });
    const player = await newcomer(code, new Date(Date.now() - 5 * MINUTE), { createdAt: new Date() });
    const first = await purchase(player.accountId, 40);
    await purchase(player.accountId, 38, { mode: "test" });
    await purchase(player.accountId, 36, { refunded: true });
    const second = await purchase(player.accountId, 30);
    await purchase(player.accountId, 4);
    await conversions.sweep(new Date());
    await conversions.sweep(new Date());
    const rows = await ofAccount(player.accountId);
    expect(rows.map((row) => [row.goal, row.destination, row.purchaseId])).toEqual([
      [1, "s2s", null],
      [2, "s2s", first],
      [3, "s2s", second],
    ]);
  });

  it("номер оплаты считается по аккаунту: у адреса без первой покупки вторая оплата остаётся повторной", async () => {
    const code = await newLink({ events: ["registration", "purchase_repeat"] });
    const player = await newcomer(code, new Date(Date.now() - 5 * MINUTE), { createdAt: new Date() });
    await purchase(player.accountId, 40);
    const second = await purchase(player.accountId, 30);
    await conversions.sweep(new Date());
    const rows = await ofAccount(player.accountId);
    expect(rows.map((row) => [row.goal, row.purchaseId])).toEqual([
      [1, null],
      [3, second],
    ]);
  });

  it("событие включено после оплаты: строка появляется на следующем проходе (клик после since, окно открыто)", async () => {
    const code = await newLink({ events: ["registration"], since: new Date(Date.now() - 60 * MINUTE) });
    const player = await newcomer(code, new Date(Date.now() - 5 * MINUTE), { createdAt: new Date() });
    const paid = await purchase(player.accountId, 40);
    await conversions.sweep(new Date());
    expect(await shape(player.accountId)).toEqual([[1, "s2s"]]);

    await prisma.link.update({ where: { code }, data: { postbackEvents: ["registration", "purchase_first"] } });
    await conversions.sweep(new Date());
    expect((await ofAccount(player.accountId)).map((row) => [row.goal, row.purchaseId])).toEqual([
      [1, null],
      [2, paid],
    ]);
  });

  // --- Отправка ---

  it("через tick: оплата 50 звёзд уходит с amount=50, currency=XTR, event=purchase_first; возврат — amount=0 и пустая валюта; повтор несёт тот же event_id", async () => {
    const code = await newLink({ events: ["registration", "purchase_first", "d1_return"] });
    const payer = await newcomer(code, new Date(Date.now() - 5 * MINUTE), { createdAt: new Date() });
    await purchase(payer.accountId, 40, { chargedStars: 50 });
    const returning = await twoRuns(code, "2026-10-10T19:00:00Z", "2026-10-11T10:00:00Z");
    await conversions.sweep(NOW);
    await conversions.sweep(new Date());

    const payment = (await ofAccount(payer.accountId)).find((row) => row.goal === 2);
    const back = (await returnsOf(returning.accountId))[0];
    expect(payment).toBeDefined();
    expect(back).toBeDefined();

    const { report, calls } = await sendThese([payment?.conversionId ?? "", back?.conversionId ?? ""]);
    expect(report).toMatchObject({ sent: 2, failed: 0, skipped: 0 });
    const byEvent = new Map(calls.map((call) => [call.searchParams.get("e"), call]));
    expect(byEvent.get("purchase_first")?.searchParams.get("a")).toBe("50");
    expect(byEvent.get("purchase_first")?.searchParams.get("c")).toBe("XTR");
    expect(byEvent.get("d1_return")?.searchParams.get("a")).toBe("0");
    expect(byEvent.get("d1_return")?.searchParams.get("c")).toBe("");
    expect(byEvent.get("d1_return")?.searchParams.get("id")).toBe(back?.conversionId);
    expect(byEvent.get("d1_return")?.searchParams.get("cid")).toBe("k1");

    // Повтор строки после отказа приёмника несёт тот же event_id.
    await prisma.adConversion.update({ where: { conversionId: back?.conversionId ?? "" }, data: { status: "pending", sentAt: null } });
    const first = await sendThese([back?.conversionId ?? ""], () => new Response("busy", { status: 503 }));
    expect(first.report).toMatchObject({ deferred: 1 });
    const again = await sendThese([back?.conversionId ?? ""]);
    expect(again.calls.map((call) => call.searchParams.get("id"))).toEqual([back?.conversionId]);
    expect(first.calls.map((call) => call.searchParams.get("id"))).toEqual([back?.conversionId]);
  });
});
