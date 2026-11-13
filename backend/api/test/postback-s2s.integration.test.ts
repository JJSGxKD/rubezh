import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { Prisma, type PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
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
 * Постбэки в s2s-сети и партнёру на живом Postgres (tasks/T-0070, docs/35-stage4-plan.md Р86, Р96):
 * назначения `s2s` и `partner` выводятся из кликов после задания адреса, события берутся у того
 * объекта, чей адрес действует, прямой запуск `l-<код>` им строк не даёт. Без базы — пропуск.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ADDRESS = "https://track.example.com/pb?cid={click_id}&e={event}&id={event_id}&a={amount}&c={currency}&s1={sub1}";
const PARAMS = { click_id: "k1", sub1: "x-y" };
const PUBLIC_IP = async () => ["93.184.216.34"];

/**
 * Проход по настоящему набору назначений, но только по ссылкам этого файла: схема общая, и проход по всем
 * ссылкам заводил бы строки соседним тестам посреди их работы. Запрос набора тот же, что в проходе, — отбор
 * ссылок оборачивает его снаружи.
 */
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

/**
 * Очередь только из названных конверсий: в общей схеме лежат строки соседних тестов. Срок повтора не смотрим —
 * проход соседнего файла мог записать строку с будущим временем; обнуление параметров не трогаем — оно общее
 * для всей схемы, и чужой тест мог как раз состарить свой клик.
 */
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
    return (await super.due(new Date(Date.now() + 40 * DAY), 1_000)).filter((row) => this.ids.includes(row.conversionId)).slice(0, limit);
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

/** Какое ограничение таблицы сработало — по имени из ошибки базы. */
const LINK_EVENTS_CHECK = /link_postback_events_check/;
const LINK_SINCE_CHECK = /link_postback_since_check/;
const PARTNER_EVENTS_CHECK = /partner_postback_events_check/;
const PARTNER_SINCE_CHECK = /partner_postback_since_check/;

describe.skipIf(DATABASE_URL === "")("постбэки в s2s-сети и партнёру на живом Postgres", () => {
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

  /** Партнёр, у которого адрес можно сразу задать: `since` — минут назад. */
  async function newPartner(address: { url: string; sinceMinutesAgo: number } | null = null, events?: string[]): Promise<string> {
    const partnerId = randomUUID();
    partnerIds.push(partnerId);
    await prisma.partner.create({
      data: {
        partnerId,
        name: `Тест ${partnerId.slice(0, 8)}`,
        createdBy: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(address === null ? {} : { postbackUrl: address.url, postbackSince: new Date(Date.now() - address.sinceMinutesAgo * MINUTE) }),
        ...(events === undefined ? {} : { postbackEvents: events }),
      },
    });
    return partnerId;
  }

  /** Ссылка: без сети или AdsGram, с владельцем-партнёром или без, с адресом или без. */
  async function newLink(patch: { network?: "adsgram"; partnerId?: string; address?: { url: string; sinceMinutesAgo: number }; events?: string[] } = {}): Promise<string> {
    const code = newLinkCode();
    linkCodes.push(code);
    await links.create({
      code,
      platform: "telegram",
      campaign: "s2s-test",
      source: "tg",
      medium: null,
      note: null,
      createdBy: null,
      network: patch.network ?? null,
      registrationOn: "launch",
      ...(patch.partnerId === undefined ? {} : { partnerId: patch.partnerId }),
    });
    if (patch.address !== undefined || patch.events !== undefined) {
      await prisma.link.update({
        where: { code },
        data: {
          ...(patch.address === undefined ? {} : { postbackUrl: patch.address.url, postbackSince: new Date(Date.now() - patch.address.sinceMinutesAgo * MINUTE) }),
          ...(patch.events === undefined ? {} : { postbackEvents: patch.events }),
        },
      });
    }
    return code;
  }

  async function playerFromClick(code: string, params: Record<string, string> | null = PARAMS, minutesAgo = 5, team = false) {
    const clickId = newClickId();
    await links.recordClick({
      clickId,
      linkCode: code,
      at: new Date(Date.now() - minutesAgo * MINUTE),
      utm: { source: null, medium: null, campaign: null, content: null, term: null },
      refererHost: null,
      deviceClass: "mobile",
      ipPrefix: null,
      language: null,
      networkParams: params,
    });
    const account = await accounts.upsert(
      { platform: "telegram", platformUserId: String(700_000_000 + Math.floor(Math.random() * 99_000_000)), displayName: "Из рекламы", username: null, photoUrl: null },
      Date.now(),
    );
    // Роль — до первой сессии: пока касания нет, чужой проход по общей схеме аккаунта не видит.
    if (team) await prisma.accountRole.create({ data: { accountId: account.accountId, role: "marketer" } });
    await launch(account.accountId, "click", `c-${clickId}`, clickId);
    return { clickId, accountId: account.accountId };
  }

  /** Новичок по прямой ссылке: аккаунт заведён сейчас, первая сессия — запуск `l-<код>`. */
  async function playerFromDirect(code: string, startParam: string = `l-${code}`) {
    const account = await accounts.upsert(
      { platform: "telegram", platformUserId: String(700_000_000 + Math.floor(Math.random() * 99_000_000)), displayName: "По прямой", username: null, photoUrl: null },
      Date.now(),
    );
    await launch(account.accountId, "link", startParam, code);
    return { accountId: account.accountId };
  }

  async function launch(accountId: string, kind: "click" | "link", startParam: string, startRef: string) {
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
      startedAt: new Date().toISOString(),
    });
  }

  async function finishedRun(accountId: string, survivalSec = 95) {
    await prisma.run.create({
      data: {
        runId: `s2s-${randomUUID()}`,
        accountId,
        status: "finished",
        difficulty: "normal",
        startingWeaponId: "spark",
        contentHash: "abc",
        startedAt: new Date(Date.now() - survivalSec * 1000),
        finishedAt: new Date(),
        outcome: "died",
        survivalSec,
        cheats: false,
        verdictReasons: [],
      },
    });
  }

  async function purchase(accountId: string, paidMinutesAgo: number, chargedStars = 50) {
    const purchaseId = randomUUID();
    const paidAt = new Date(Date.now() - paidMinutesAgo * MINUTE);
    await prisma.purchase.create({
      data: { purchaseId, accountId, product: "shop_item", sku: "gems_small", priceStars: 50, chargedStars, mode: "live", status: "paid", invoicedAt: paidAt, paidAt },
    });
    return purchaseId;
  }

  const dueOf = (ids: readonly string[]) => new OnlyThese(prisma, ids).due(new Date(), 1_000);
  const ofAccount = (accountId: string) => prisma.adConversion.findMany({ where: { accountId }, orderBy: [{ goal: "asc" }, { destination: "asc" }] });
  const shape = async (accountId: string) => (await ofAccount(accountId)).map((row) => [row.goal, row.destination, row.network]);

  async function sendThese(ids: readonly string[], respond: (url: string) => Response = () => new Response("ok", { status: 200 })) {
    const service = new AdConversionsService(
      loadAppConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv),
      new OnlyThese(prisma, ids),
      [new AdsgramDestination({ get: () => "tok_integration" }), new TemplateDestination("s2s", PUBLIC_IP), new TemplateDestination("partner", PUBLIC_IP)],
      FREE_LOCK as never,
    );
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return respond(String(input));
    }) as typeof fetch;
    const report = await service.tick(new Date(), fetchImpl);
    return { report, calls };
  }

  it("ссылка без сети и владельца с адресом: регистрация после засчитанного забега — строка s2s; клик раньше postback_since — строки нет", async () => {
    const code = await newLink({ address: { url: ADDRESS, sinceMinutesAgo: 60 } });
    const player = await playerFromClick(code, PARAMS, 5);
    await finishedRun(player.accountId);
    await conversions.sweep(new Date());
    await conversions.sweep(new Date());
    const rows = await ofAccount(player.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ goal: 1, destination: "s2s", network: "s2s", status: "pending", linkCode: code, clickId: player.clickId });

    // Адрес задан двадцать минут назад: клик пять минут назад — после него, а клик час назад — до.
    const late = await newLink({ address: { url: ADDRESS, sinceMinutesAgo: 20 } });
    const after = await playerFromClick(late, PARAMS, 5);
    await finishedRun(after.accountId);
    const before = await playerFromClick(late, PARAMS, 30);
    await finishedRun(before.accountId);
    await conversions.sweep(new Date());
    expect(await shape(after.accountId)).toEqual([[1, "s2s", "s2s"]]);
    expect(await ofAccount(before.accountId)).toEqual([]);
  });

  it("без засчитанного забега регистрации нет — правило то же, что у сети: ссылка «после забега»", async () => {
    const code = await newLink({ address: { url: ADDRESS, sinceMinutesAgo: 60 } });
    await prisma.link.update({ where: { code }, data: { registrationOn: "first_run" } });
    const player = await playerFromClick(code);
    await conversions.sweep(new Date());
    expect(await ofAccount(player.accountId)).toEqual([]);
    await finishedRun(player.accountId);
    await conversions.sweep(new Date());
    expect(await shape(player.accountId)).toEqual([[1, "s2s", "s2s"]]);
  });

  it("ссылка партнёра: адрес партнёра — назначение partner; параметры клика доходят до очереди вместе с адресом", async () => {
    const partnerId = await newPartner({ url: ADDRESS, sinceMinutesAgo: 60 });
    const code = await newLink({ partnerId });
    const player = await playerFromClick(code);
    await conversions.sweep(new Date());
    const [row] = await ofAccount(player.accountId);
    expect(row).toMatchObject({ goal: 1, destination: "partner", network: "partner" });

    const queued = (await dueOf([row?.conversionId ?? ""]))[0];
    expect(queued).toMatchObject({ destination: "partner", event: "registration", params: PARAMS, postbackUrl: ADDRESS, purchase: null });
  });

  it("свой адрес ссылки важнее адреса партнёра, и события берутся у того объекта, чей адрес действует", async () => {
    const own = "https://own.example.com/in?cid={click_id}";
    // У партнёра регистрация и первая покупка, у ссылки — по умолчанию одна регистрация.
    const partnerId = await newPartner({ url: ADDRESS, sinceMinutesAgo: 60 }, ["registration", "purchase_first"]);
    const withOwn = await newLink({ partnerId, address: { url: own, sinceMinutesAgo: 60 } });
    const withoutOwn = await newLink({ partnerId });

    const ownPlayer = await playerFromClick(withOwn);
    const partnerPlayer = await playerFromClick(withoutOwn);
    for (const player of [ownPlayer, partnerPlayer]) await purchase(player.accountId, 40);
    await conversions.sweep(new Date());

    // Адрес ссылки: события ссылки — только регистрация, покупка не уходит.
    expect(await shape(ownPlayer.accountId)).toEqual([[1, "partner", "partner"]]);
    // Адрес партнёра: события партнёра — регистрация и первая покупка.
    expect(await shape(partnerPlayer.accountId)).toEqual([
      [1, "partner", "partner"],
      [2, "partner", "partner"],
    ]);

    const ownRow = (await ofAccount(ownPlayer.accountId))[0];
    const partnerRow = (await ofAccount(partnerPlayer.accountId))[0];
    expect((await dueOf([ownRow?.conversionId ?? ""]))[0]?.postbackUrl).toBe(own);
    expect((await dueOf([partnerRow?.conversionId ?? ""]))[0]?.postbackUrl).toBe(ADDRESS);
  });

  it("ссылка партнёра без адреса у обоих — строк нет, хотя параметры клика сохранены", async () => {
    const partnerId = await newPartner();
    const code = await newLink({ partnerId });
    const player = await playerFromClick(code);
    await conversions.sweep(new Date());
    expect(await ofAccount(player.accountId)).toEqual([]);
    expect((await prisma.linkClick.findUniqueOrThrow({ where: { clickId: player.clickId } })).networkParams).toEqual(PARAMS);
  });

  it("ссылка AdsGram со своим адресом: у клика две строки, повтор и параллельные проходы их не задваивают", async () => {
    const code = await newLink({ network: "adsgram", address: { url: ADDRESS, sinceMinutesAgo: 60 } });
    const player = await playerFromClick(code, { record: "rec123", campaign: "55", ...PARAMS });
    const now = new Date();
    await expect(Promise.all([conversions.sweep(now), conversions.sweep(now), conversions.sweep(now)])).resolves.toHaveLength(3);
    await conversions.sweep(new Date());
    expect(await shape(player.accountId)).toEqual([
      [1, "adsgram", "adsgram"],
      [1, "s2s", "s2s"],
    ]);
  });

  it("по умолчанию покупка строки не даёт; после UPDATE postback_events — даёт purchase_first, но не purchase_repeat", async () => {
    const code = await newLink({ address: { url: ADDRESS, sinceMinutesAgo: 60 } });
    const player = await playerFromClick(code);
    const first = await purchase(player.accountId, 40);
    await purchase(player.accountId, 30);

    await conversions.sweep(new Date());
    expect(await shape(player.accountId)).toEqual([[1, "s2s", "s2s"]]);

    await prisma.$executeRaw`UPDATE link SET postback_events = '{registration,purchase_first}' WHERE code = ${code}`;
    await conversions.sweep(new Date());
    await conversions.sweep(new Date());
    const rows = await ofAccount(player.accountId);
    expect(rows.map((row) => [row.goal, row.destination, row.purchaseId])).toEqual([
      [1, "s2s", null],
      [2, "s2s", first],
    ]);
  });

  it("очередь отдаёт сумму покупки в звёздах и вид события; отправка уходит GET-запросом с event_id, повтор не задваивает", async () => {
    const code = await newLink({ address: { url: ADDRESS, sinceMinutesAgo: 60 }, events: ["registration", "purchase_first"] });
    const player = await playerFromClick(code);
    await purchase(player.accountId, 40, 75);
    await conversions.sweep(new Date());
    const rows = await ofAccount(player.accountId);
    expect(rows.map((row) => row.goal)).toEqual([1, 2]);

    const { report, calls } = await sendThese(rows.map((row) => row.conversionId));
    expect(report).toMatchObject({ sent: 2, failed: 0, skipped: 0 });
    const byEvent = new Map(calls.map((call) => [new URL(call.url).searchParams.get("e"), new URL(call.url)]));
    expect(byEvent.get("registration")?.searchParams.get("id")).toBe(rows[0]?.conversionId);
    expect(byEvent.get("registration")?.searchParams.get("cid")).toBe("k1");
    expect(byEvent.get("registration")?.searchParams.get("a")).toBe("0");
    expect(byEvent.get("purchase_first")?.searchParams.get("a")).toBe("75");
    expect(byEvent.get("purchase_first")?.searchParams.get("c")).toBe("XTR");
    expect(calls.every((call) => call.init?.redirect === "manual")).toBe(true);
    expect(await ofAccount(player.accountId)).toMatchObject([{ status: "sent" }, { status: "sent" }]);

    // Второй тик на тех же строках: отправленное не уходит снова.
    const again = await sendThese(rows.map((row) => row.conversionId));
    expect(again.calls).toHaveLength(0);
  });

  it("адрес снят после создания строки: при отправке она пропускается с причиной no_address", async () => {
    const code = await newLink({ address: { url: ADDRESS, sinceMinutesAgo: 60 } });
    const player = await playerFromClick(code);
    await conversions.sweep(new Date());
    const [row] = await ofAccount(player.accountId);
    await prisma.link.update({ where: { code }, data: { postbackUrl: null, postbackSince: null } });

    const { report, calls } = await sendThese([row?.conversionId ?? ""]);
    expect(report).toMatchObject({ skipped: 1, sent: 0 });
    expect(calls).toHaveLength(0);
    expect(await ofAccount(player.accountId)).toMatchObject([{ status: "skipped", reason: "no_address" }]);
  });

  it("шаблон требует click_id, а в клике его не было: строка пропускается с причиной no_click_id", async () => {
    const code = await newLink({ address: { url: ADDRESS, sinceMinutesAgo: 60 } });
    const player = await playerFromClick(code, null);
    await conversions.sweep(new Date());
    const [row] = await ofAccount(player.accountId);
    const { report, calls } = await sendThese([row?.conversionId ?? ""]);
    expect(report).toMatchObject({ skipped: 1 });
    expect(calls).toHaveLength(0);
    expect(await ofAccount(player.accountId)).toMatchObject([{ status: "skipped", reason: "no_click_id" }]);
  });

  it("аккаунт команды: строка пишется пропущенной с причиной team для s2s и partner", async () => {
    const partnerId = await newPartner({ url: ADDRESS, sinceMinutesAgo: 60 });
    const partnerLink = await newLink({ partnerId });
    const plain = await newLink({ address: { url: ADDRESS, sinceMinutesAgo: 60 } });
    for (const code of [partnerLink, plain]) {
      const team = await playerFromClick(code, PARAMS, 5, true);
      await conversions.sweep(new Date());
      expect(await ofAccount(team.accountId)).toMatchObject([{ goal: 1, status: "skipped", reason: "team" }]);
    }
  });

  it("журнал и счёт по назначению: строки s2s не мешают счёту AdsGram", async () => {
    const code = await newLink({ network: "adsgram", address: { url: ADDRESS, sinceMinutesAgo: 60 } });
    const player = await playerFromClick(code, { record: "rec123", campaign: "55", ...PARAMS });
    await conversions.sweep(new Date());
    const journal = await conversions.journal(code, null, 50);
    expect(journal.map((row) => [row.destination, row.event]).sort()).toEqual([
      ["adsgram", "registration"],
      ["s2s", "registration"],
    ]);
    expect((await conversions.summaries([code])).get(code)?.[1]).toEqual({ pending: 1, sent: 0, failed: 0, skipped: 0 });
    expect((await conversions.summaries([code], "s2s")).get(code)?.[1]).toEqual({ pending: 1, sent: 0, failed: 0, skipped: 0 });
    expect(journal[0]?.accountId).toBe(player.accountId);
  });

  it("параметры клика, в том числе click_id и sub, обнуляются через 31 сутки", async () => {
    const partnerId = await newPartner({ url: ADDRESS, sinceMinutesAgo: 60 });
    const code = await newLink({ partnerId });
    const stale = await playerFromClick(code);
    const fresh = await playerFromClick(code);
    // Проход вызывается с «сейчас» в 2000 году: старше окна оказываются только эти клики, чужие не задеваются.
    const longAgo = new Date("2000-03-01T00:00:00Z");
    await prisma.linkClick.update({ where: { clickId: stale.clickId }, data: { at: new Date("2000-01-01T00:00:00Z") } });
    await prisma.linkClick.update({ where: { clickId: fresh.clickId }, data: { at: new Date("2000-02-20T00:00:00Z") } });
    expect(await conversions.purgeParams(longAgo, 500)).toBe(1);
    expect((await prisma.linkClick.findUniqueOrThrow({ where: { clickId: stale.clickId } })).networkParams).toBeNull();
    expect((await prisma.linkClick.findUniqueOrThrow({ where: { clickId: fresh.clickId } })).networkParams).toEqual(PARAMS);
  });

  // --- Прямой запуск `l-<код>` событий постбэкам не даёт (уточнение claude-lead-1 от 07.11.2026) ---

  it("ссылка партнёра с адресом: новичок пришёл по l-<код> и сыграл засчитанный забег — строк partner нет", async () => {
    const partnerId = await newPartner({ url: ADDRESS, sinceMinutesAgo: 60 }, ["registration", "purchase_first"]);
    const code = await newLink({ partnerId });
    const direct = await playerFromDirect(code);
    await finishedRun(direct.accountId);
    await purchase(direct.accountId, 40);
    const clicked = await playerFromClick(code);

    await conversions.sweep(new Date());
    await conversions.sweep(new Date());
    expect(await ofAccount(direct.accountId)).toEqual([]);
    // Тот же проход по клику строку даёт: адрес и ссылка рабочие, дело только в запуске без клика.
    expect(await shape(clicked.accountId)).toEqual([[1, "partner", "partner"]]);
  });

  it("ссылка без сети и владельца с собственным адресом: прямой запуск строк s2s не даёт", async () => {
    const code = await newLink({ address: { url: ADDRESS, sinceMinutesAgo: 60 }, events: ["registration", "purchase_first"] });
    const direct = await playerFromDirect(code);
    await finishedRun(direct.accountId);
    await purchase(direct.accountId, 40);
    await conversions.sweep(new Date());
    expect(await ofAccount(direct.accountId)).toEqual([]);
  });

  it("ссылка AdsGram со своим адресом: прямой запуск с метками — ровно одна строка adsgram, строки s2s нет", async () => {
    const code = await newLink({ network: "adsgram", address: { url: ADDRESS, sinceMinutesAgo: 60 }, events: ["registration", "purchase_first"] });
    const direct = await playerFromDirect(code, `l-${code}_campaign-55_clickid-3f2a-9c_record-rec123`);
    await purchase(direct.accountId, 40);
    await conversions.sweep(new Date());
    await conversions.sweep(new Date());
    const rows = await ofAccount(direct.accountId);
    expect(rows.map((row) => [row.goal, row.destination, row.clickId])).toEqual([
      [1, "adsgram", null],
      [2, "adsgram", null],
    ]);
    expect(rows[0]?.networkParams).toEqual({ campaign: "55", clickid: "3f2a-9c", record: "rec123" });
  });

  // --- Таблицы ---

  it("CHECK: неизвестное событие и адрес без postback_since отвергаются у ссылки и у партнёра", async () => {
    const code = await newLink();
    const partnerId = await newPartner();
    await expect(prisma.$executeRaw`UPDATE link SET postback_events = '{registration,teleport}' WHERE code = ${code}`).rejects.toThrow(LINK_EVENTS_CHECK);
    await expect(prisma.$executeRaw`UPDATE link SET postback_url = 'https://track.example.com/pb' WHERE code = ${code}`).rejects.toThrow(LINK_SINCE_CHECK);
    await expect(prisma.$executeRaw`UPDATE link SET postback_since = now() WHERE code = ${code}`).rejects.toThrow(LINK_SINCE_CHECK);
    await expect(prisma.$executeRaw`UPDATE partner SET postback_events = '{registration,teleport}' WHERE partner_id = ${partnerId}::uuid`).rejects.toThrow(PARTNER_EVENTS_CHECK);
    await expect(prisma.$executeRaw`UPDATE partner SET postback_url = 'https://track.example.com/pb' WHERE partner_id = ${partnerId}::uuid`).rejects.toThrow(PARTNER_SINCE_CHECK);
    await expect(prisma.$executeRaw`UPDATE partner SET postback_since = now() WHERE partner_id = ${partnerId}::uuid`).rejects.toThrow(PARTNER_SINCE_CHECK);

    // Допустимое проходит: все четыре события, адрес с моментом, пустой список событий.
    await prisma.$executeRaw`UPDATE link SET postback_events = '{registration,purchase_first,purchase_repeat,d1_return}', postback_url = 'https://track.example.com/pb', postback_since = now() WHERE code = ${code}`;
    await prisma.$executeRaw`UPDATE partner SET postback_events = '{}' WHERE partner_id = ${partnerId}::uuid`;
  });

  it("по умолчанию у ссылки и партнёра: адреса нет, событие — одна регистрация", async () => {
    const code = await newLink();
    const partnerId = await newPartner();
    expect(await prisma.link.findUniqueOrThrow({ where: { code } })).toMatchObject({ postbackUrl: null, postbackSince: null, postbackEvents: ["registration"] });
    expect(await prisma.partner.findUniqueOrThrow({ where: { partnerId } })).toMatchObject({ postbackUrl: null, postbackSince: null, postbackEvents: ["registration"] });
  });

  it("due отдаёт адрес ссылки, а если его нет, — партнёра; у ссылки без обоих — null", async () => {
    const partnerId = await newPartner({ url: "https://partner.example.com/in?c={click_id}", sinceMinutesAgo: 60 });
    const own = await newLink({ partnerId, address: { url: ADDRESS, sinceMinutesAgo: 60 } });
    const shared = await newLink({ partnerId });
    const plain = await newLink({ network: "adsgram" });
    const rows = new Map<string, string>();
    for (const code of [own, shared, plain]) {
      const player = await playerFromClick(code, { record: "r", ...PARAMS });
      await conversions.sweep(new Date());
      const [row] = (await ofAccount(player.accountId)).filter((item) => item.destination !== "adsgram" || code === plain);
      rows.set(code, row?.conversionId ?? "");
    }
    const queue = await dueOf([...rows.values()]);
    const urlOf = (code: string) => queue.find((item) => item.conversionId === rows.get(code))?.postbackUrl;
    expect(urlOf(own)).toBe(ADDRESS);
    expect(urlOf(shared)).toBe("https://partner.example.com/in?c={click_id}");
    expect(urlOf(plain)).toBeNull();
  });
});
