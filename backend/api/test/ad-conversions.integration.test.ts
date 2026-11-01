import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { Prisma, type PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaConversionsRepository, type DueConversion } from "../src/modules/ad-conversions/conversions.repository.js";
import { AdConversionsService } from "../src/modules/ad-conversions/conversions.service.js";
import { AdsgramDestination } from "../src/modules/ad-conversions/destinations/adsgram.destination.js";
import { PrismaSessionsRepository } from "../src/modules/attribution/sessions.repository.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { newClickId, newLinkCode } from "../src/modules/links/link-code.js";
import { PrismaLinksRepository, type RegistrationOn } from "../src/modules/links/links.repository.js";

/**
 * Конверсии закупленной рекламы на живом Postgres (WP43, Р86): регистрация
 * и покупки выводятся из первого касания, забегов и оплат; повтор прохода
 * ничего не задваивает; старый игрок, аккаунт команды, возврат и тестовая
 * оплата сети не отдаются. Без базы — пропуск.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const MINUTE = 60_000;

/** Проход на своём наборе назначений: ветки T-0070 проверяются здесь, не трогая запросы прохода. */
class CustomTargets extends PrismaConversionsRepository {
  constructor(
    prisma: PrismaClient,
    private readonly cte: Prisma.Sql,
  ) {
    super(prisma);
  }
  protected override targets(): Prisma.Sql {
    return this.cte;
  }
}

/** Очередь только из названных конверсий: в общей схеме лежат строки соседних тестов. */
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
  override async due(now: Date, limit: number): Promise<DueConversion[]> {
    return (await super.due(now, 1_000)).filter((row) => this.ids.includes(row.conversionId)).slice(0, limit);
  }
}

/** Какое ограничение таблицы сработало — по имени из ошибки базы. */
const CLICK_KEY = /ad_conversion_click_id_goal_destination_key/;
const PURCHASE_KEY = /ad_conversion_purchase_id_destination_key/;
const GOAL_CHECK = /ad_conversion_goal_check/;
const PURCHASE_CHECK = /ad_conversion_purchase_check/;

const FREE_LOCK = {
  async set(): Promise<"OK"> {
    return "OK";
  },
  async eval(): Promise<number> {
    return 1;
  },
};

/** Ветки назначений: AdsGram как в проходе, плюс `s2s` у названной ссылки. */
function targetsWithS2s(code: string, events: readonly string[], since: Date | string = "-infinity"): Prisma.Sql {
  return Prisma.sql`targets(link_code, destination, events, since) AS (
    SELECT l.code, 'adsgram'::text, ARRAY['registration', 'purchase_first', 'purchase_repeat']::text[], '-infinity'::timestamptz FROM link l WHERE l.network = 'adsgram'
    UNION ALL
    SELECT l.code, 's2s'::text, ARRAY[${Prisma.join(events)}]::text[], ${since}::timestamptz FROM link l WHERE l.code = ${code}
  )`;
}

describe.skipIf(DATABASE_URL === "")("конверсии на живом Postgres", () => {
  let prisma: PrismaClient;
  let conversions: PrismaConversionsRepository;
  let links: PrismaLinksRepository;
  let accounts: PrismaAccountRepository;
  let sessions: PrismaSessionsRepository;
  const linkCodes: string[] = [];

  beforeAll(() => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
    conversions = new PrismaConversionsRepository(prisma);
    links = new PrismaLinksRepository(prisma);
    accounts = new PrismaAccountRepository(prisma);
    sessions = new PrismaSessionsRepository(prisma);
  });

  afterAll(async () => {
    await prisma.link.deleteMany({ where: { code: { in: linkCodes } } });
    await prisma.$disconnect();
  });

  async function adsgramLink(registrationOn: RegistrationOn = "first_run"): Promise<string> {
    const code = newLinkCode();
    linkCodes.push(code);
    await links.create({ code, platform: "telegram", campaign: "ag-test", source: "adsgram", medium: null, note: null, createdBy: null, network: "adsgram", registrationOn });
    return code;
  }

  /** Ссылка без сети: сама по себе конверсий не порождает. */
  async function plainLink(): Promise<string> {
    const code = newLinkCode();
    linkCodes.push(code);
    await links.create({ code, platform: "telegram", campaign: "plain-test", source: "site", medium: null, note: null, createdBy: null, network: null, registrationOn: "launch" });
    return code;
  }

  /** Игрок, пришедший по клику: клик пять минут назад, аккаунт — сейчас, первая сессия — по клику. */
  async function playerFromClick(code: string, params: Record<string, string> | null = { record: "rec123", campaign: "55" }) {
    const clickId = newClickId();
    await links.recordClick({
      clickId,
      linkCode: code,
      at: new Date(Date.now() - 5 * MINUTE),
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
    await sessions.record({
      sessionId: randomUUID(),
      accountId: account.accountId,
      platform: "telegram",
      place: "miniapp",
      startKind: "click",
      startParam: `c-${clickId}`,
      startRef: clickId,
      clientPlatform: "android",
      clientVersion: "8.0",
      deviceClass: "mobile",
      os: "android",
      ipPrefix: null,
      startedAt: new Date().toISOString(),
    });
    return { clickId, accountId: account.accountId, telegramId: account.platformUserId };
  }

  async function finishedRun(accountId: string, survivalSec: number, patch: { cheats?: boolean } = {}) {
    await prisma.run.create({
      data: {
        runId: `ag-${randomUUID()}`,
        accountId,
        status: "finished",
        difficulty: "normal",
        startingWeaponId: "spark",
        contentHash: "abc",
        startedAt: new Date(Date.now() - survivalSec * 1000),
        finishedAt: new Date(),
        outcome: "died",
        survivalSec,
        cheats: patch.cheats ?? false,
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

  /** Строка журнала напрямую, мимо прохода: проверки таблицы и будущих назначений. */
  function insertRow(player: { clickId: string; accountId: string }, code: string, row: { goal: number; destination?: string; purchaseId?: string | null }) {
    const destination = row.destination ?? "adsgram";
    return prisma.adConversion.create({
      data: { network: destination, linkCode: code, clickId: player.clickId, accountId: player.accountId, goal: row.goal, purchaseId: row.purchaseId ?? null, destination },
    });
  }

  it("регистрация — после первого засчитанного забега; короткий и с читами не считаются; повтор прохода не задваивает", async () => {
    const code = await adsgramLink();
    const player = await playerFromClick(code);

    await finishedRun(player.accountId, 12);
    await finishedRun(player.accountId, 400, { cheats: true });
    await conversions.sweep(new Date());
    expect(await ofAccount(player.accountId)).toEqual([]);

    await finishedRun(player.accountId, 95);
    await conversions.sweep(new Date());
    await conversions.sweep(new Date());
    const rows = await ofAccount(player.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ goal: 1, status: "pending", network: "adsgram", destination: "adsgram", linkCode: code, clickId: player.clickId, purchaseId: null });

    const due = (await conversions.due(new Date(), 500)).find((row) => row.conversionId === rows[0]?.conversionId);
    expect(due).toMatchObject({ destination: "adsgram", event: "registration", attempts: 0, params: { record: "rec123", campaign: "55" }, telegramId: player.telegramId, purchase: null });
  });

  it("ссылка «при первом запуске» — регистрация без забега", async () => {
    const code = await adsgramLink("launch");
    const player = await playerFromClick(code);
    await conversions.sweep(new Date());
    expect(await ofAccount(player.accountId)).toMatchObject([{ goal: 1, status: "pending" }]);
  });

  it("аккаунт под отдельной доской уходит в сеть как обычный игрок: те же строки и состояния (T-0115)", async () => {
    const code = await adsgramLink();
    const plain = await playerFromClick(code);
    const marked = await playerFromClick(code);
    await prisma.accountRestriction.create({ data: { accountId: marked.accountId, kind: "separate_board", startsAt: new Date(Date.now() - 60 * MINUTE), reason: "other", notify: false } });
    for (const player of [plain, marked]) {
      await finishedRun(player.accountId, 95);
      await purchase(player.accountId, 40);
    }

    await conversions.sweep(new Date());
    await conversions.sweep(new Date());
    const shape = (rows: Awaited<ReturnType<typeof ofAccount>>) => rows.map((row) => [row.goal, row.status, row.destination, row.reason]);
    expect(shape(await ofAccount(marked.accountId))).toEqual(shape(await ofAccount(plain.accountId)));
    expect(await ofAccount(marked.accountId)).toHaveLength(2);
  });

  it("старый игрок, открывший игру по рекламе, — не конверсия сети; аккаунт команды — пропущен", async () => {
    const code = await adsgramLink("launch");
    const old = await playerFromClick(code);
    await prisma.account.update({ where: { accountId: old.accountId }, data: { createdAt: new Date(Date.now() - 2 * 24 * 60 * MINUTE) } });
    const team = await playerFromClick(code);
    await prisma.accountRole.create({ data: { accountId: team.accountId, role: "marketer" } });

    await conversions.sweep(new Date());
    expect(await ofAccount(old.accountId)).toEqual([]);
    const [teamRow] = await ofAccount(team.accountId);
    expect(teamRow).toMatchObject({ goal: 1, status: "skipped", reason: "team" });
    // Аккаунт команды можно отправить руками — проверить связку с кабинетом.
    expect(await conversions.requeue(code, teamRow?.conversionId ?? "", new Date())).toMatchObject({ status: "pending", reason: null });
  });

  it("покупки: первая — цель 2, следующие — 3; возврат, тестовая и неотлежавшаяся не уходят", async () => {
    const code = await adsgramLink("launch");
    const player = await playerFromClick(code);
    const first = await purchase(player.accountId, 40);
    await purchase(player.accountId, 35, { refunded: true });
    await purchase(player.accountId, 30, { mode: "test" });
    const second = await purchase(player.accountId, 20);
    const fresh = await purchase(player.accountId, 2);

    await conversions.sweep(new Date());
    await conversions.sweep(new Date());
    const rows = (await ofAccount(player.accountId)).filter((row) => row.goal !== 1);
    expect(rows.map((row) => [row.goal, row.purchaseId])).toEqual([
      [2, first],
      [3, second],
    ]);

    // Через десять минут отлежится и свежая — повторной.
    await conversions.sweep(new Date(Date.now() + 15 * MINUTE));
    expect((await ofAccount(player.accountId)).find((row) => row.purchaseId === fresh)).toMatchObject({ goal: 3 });
  });

  it("журнал, счёт по ссылке, отправка и повтор неотправленной", async () => {
    const code = await adsgramLink("launch");
    const sent = await playerFromClick(code);
    const failed = await playerFromClick(code);
    await conversions.sweep(new Date());
    const [sentRow] = await ofAccount(sent.accountId);
    const [failedRow] = await ofAccount(failed.accountId);
    if (sentRow === undefined || failedRow === undefined) throw new Error("конверсии не найдены");

    await conversions.markSent(sentRow.conversionId, 200, new Date());
    await conversions.markFailed(failedRow.conversionId, 8, null, 400, "ответ 400: invalid record");

    const summary = (await conversions.summaries([code])).get(code);
    expect(summary?.[1]).toEqual({ pending: 0, sent: 1, failed: 1, skipped: 0 });
    const journal = await conversions.journal(code, null, 50);
    expect(journal.map((row) => row.status).sort()).toEqual(["failed", "sent"]);
    // Обе строки записал один проход с одним временем — страница по одной
    // строке не теряет вторую на стыке.
    const [first] = await conversions.journal(code, null, 1);
    if (first === undefined) throw new Error("журнал пуст");
    const rest = await conversions.journal(code, { createdAt: first.createdAt, conversionId: first.conversionId }, 1);
    expect([first, ...rest].map((row) => row.conversionId).sort()).toEqual([sentRow.conversionId, failedRow.conversionId].sort());

    expect(await conversions.requeue(code, sentRow.conversionId, new Date())).toBeNull();
    expect(await conversions.requeue(code, failedRow.conversionId, new Date())).toMatchObject({ status: "pending", attempts: 0, lastError: null });
    // Чужой ссылкой повторить нельзя.
    expect(await conversions.requeue(newLinkCode(), failedRow.conversionId, new Date())).toBeNull();
    // Без меток сети повтор пропустился бы снова — его не ставят.
    await conversions.skip(failedRow.conversionId, "no_macros");
    expect(await conversions.requeue(code, failedRow.conversionId, new Date())).toBeNull();
  });

  it("макросы кликов старше окна обнуляются", async () => {
    const code = await adsgramLink();
    const player = await playerFromClick(code);
    await prisma.linkClick.update({ where: { clickId: player.clickId }, data: { at: new Date(Date.now() - 40 * 24 * 60 * MINUTE) } });
    await conversions.purgeParams(new Date(), 500);
    expect((await prisma.linkClick.findUniqueOrThrow({ where: { clickId: player.clickId } })).networkParams).toBeNull();
  });

  it("новые строки несут назначение: destination и network — adsgram, у регистрации и у покупок", async () => {
    const code = await adsgramLink("launch");
    const player = await playerFromClick(code);
    await purchase(player.accountId, 40);
    await purchase(player.accountId, 30);
    await conversions.sweep(new Date());
    const rows = await ofAccount(player.accountId);
    expect(rows.map((row) => row.goal)).toEqual([1, 2, 3]);
    for (const row of rows) expect(row).toMatchObject({ destination: "adsgram", network: "adsgram", status: "pending" });
  });

  it("ссылка без сети конверсий не порождает", async () => {
    const code = await plainLink();
    const player = await playerFromClick(code);
    await purchase(player.accountId, 40);
    await conversions.sweep(new Date());
    expect(await ofAccount(player.accountId)).toEqual([]);
  });

  it("проходы разом — по одной строке на (клик, цель, назначение) и на (оплату, назначение), без ошибок", async () => {
    const code = await adsgramLink("launch");
    const player = await playerFromClick(code);
    const first = await purchase(player.accountId, 40);
    const second = await purchase(player.accountId, 30);

    const now = new Date();
    await expect(Promise.all([conversions.sweep(now), conversions.sweep(now), conversions.sweep(now), conversions.sweep(now)])).resolves.toHaveLength(4);
    const rows = await ofAccount(player.accountId);
    expect(rows.map((row) => [row.goal, row.destination, row.purchaseId])).toEqual([
      [1, "adsgram", null],
      [2, "adsgram", first],
      [3, "adsgram", second],
    ]);
  });

  it("таблица: две строки одной цели одного клика допустимы при разных назначениях и недопустимы при одинаковых", async () => {
    const code = await adsgramLink("launch");
    const player = await playerFromClick(code);
    await conversions.sweep(new Date());
    expect(await ofAccount(player.accountId)).toMatchObject([{ goal: 1, destination: "adsgram" }]);

    await insertRow(player, code, { goal: 1, destination: "s2s" });
    await insertRow(player, code, { goal: 1, destination: "partner" });
    await expect(insertRow(player, code, { goal: 1, destination: "s2s" })).rejects.toThrow(CLICK_KEY);
    await expect(insertRow(player, code, { goal: 1, destination: "adsgram" })).rejects.toThrow(CLICK_KEY);
    expect(await ofAccount(player.accountId)).toHaveLength(3);
  });

  it("таблица: одна оплата — одна строка на назначение; повторных покупок на клик сколько угодно", async () => {
    const code = await adsgramLink("launch");
    const player = await playerFromClick(code);
    const first = await purchase(player.accountId, 40);
    const second = await purchase(player.accountId, 30);
    const third = await purchase(player.accountId, 20);
    await conversions.sweep(new Date());

    await insertRow(player, code, { goal: 2, destination: "s2s", purchaseId: first });
    // Та же оплата тому же назначению: нарушены оба ключа, база называет любой из них.
    await expect(insertRow(player, code, { goal: 2, destination: "s2s", purchaseId: first })).rejects.toThrow(/ad_conversion_(purchase_id_destination|click_id_goal_destination)_key/);
    // Та же оплата тому же назначению другой целью — тоже та же строка.
    await expect(insertRow(player, code, { goal: 3, destination: "adsgram", purchaseId: first })).rejects.toThrow(PURCHASE_KEY);
    // Первая покупка клика одному назначению — одна, хотя оплата другая.
    await expect(insertRow(player, code, { goal: 2, destination: "s2s", purchaseId: second })).rejects.toThrow(CLICK_KEY);
    // Повторные не ограничены ключом на клик: ограничивает только ключ на оплату.
    await insertRow(player, code, { goal: 3, destination: "s2s", purchaseId: second });
    await insertRow(player, code, { goal: 3, destination: "s2s", purchaseId: third });
    expect((await ofAccount(player.accountId)).filter((row) => row.destination === "s2s")).toHaveLength(3);
  });

  it("таблица: назначение — одно из трёх, цель 4 допустима только без оплаты, цель 5 — никогда", async () => {
    const code = await adsgramLink("launch");
    const player = await playerFromClick(code);
    const paid = await purchase(player.accountId, 40);

    await expect(insertRow(player, code, { goal: 1, destination: "tiktok" })).rejects.toThrow(/ad_conversion_destination_check/);
    await expect(insertRow(player, code, { goal: 5 })).rejects.toThrow(GOAL_CHECK);
    await expect(insertRow(player, code, { goal: 0 })).rejects.toThrow(GOAL_CHECK);
    await expect(insertRow(player, code, { goal: 4, purchaseId: paid })).rejects.toThrow(PURCHASE_CHECK);
    await expect(insertRow(player, code, { goal: 1, purchaseId: paid })).rejects.toThrow(PURCHASE_CHECK);
    await expect(insertRow(player, code, { goal: 2 })).rejects.toThrow(PURCHASE_CHECK);
    await expect(insertRow(player, code, { goal: 3 })).rejects.toThrow(PURCHASE_CHECK);

    await insertRow(player, code, { goal: 4 });
    // Возврат на следующий день — один на клик и назначение, как регистрация.
    await expect(insertRow(player, code, { goal: 4 })).rejects.toThrow(CLICK_KEY);
    await insertRow(player, code, { goal: 4, destination: "partner" });
    expect((await ofAccount(player.accountId)).map((row) => [row.goal, row.destination])).toEqual([
      [4, "adsgram"],
      [4, "partner"],
    ]);
  });

  it("цель 4 не читается как регистрация: очередь отдаёт d1_return, а AdsGram её пропускает как неизвестное назначение", async () => {
    const code = await adsgramLink("launch");
    const player = await playerFromClick(code);
    const row = await insertRow(player, code, { goal: 4 });

    const queued = (await conversions.due(new Date(), 500)).find((item) => item.conversionId === row.conversionId);
    expect(queued).toMatchObject({ destination: "adsgram", event: "d1_return", purchase: null });

    const service = new AdConversionsService(
      loadAppConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv),
      new OnlyThese(prisma, [row.conversionId]),
      [new AdsgramDestination({ get: () => "tok_integration" })],
      FREE_LOCK as never,
    );
    const urls: string[] = [];
    const fetchImpl = (async (input: URL | string) => {
      urls.push(String(input));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    expect(await service.tick(new Date(), fetchImpl)).toMatchObject({ skipped: 1, sent: 0 });
    expect(urls).toEqual([]);
    expect(await prisma.adConversion.findUniqueOrThrow({ where: { conversionId: row.conversionId } })).toMatchObject({ status: "skipped", reason: "unknown_network", attempts: 0 });
  });

  it("очередь отдаёт оплату: сумма — списанные звёзды (не цена), валюта — XTR; у регистрации оплаты нет", async () => {
    const code = await adsgramLink("launch");
    const player = await playerFromClick(code);
    const paid = await purchase(player.accountId, 40, { chargedStars: 35 });
    await conversions.sweep(new Date());
    const rows = await ofAccount(player.accountId);
    const ids = new Map(rows.map((row) => [row.goal, row.conversionId]));

    const queue = await conversions.due(new Date(), 500);
    const registration = queue.find((item) => item.conversionId === ids.get(1));
    const firstPurchase = queue.find((item) => item.conversionId === ids.get(2));
    expect(registration).toMatchObject({ event: "registration", purchase: null });
    expect(firstPurchase).toMatchObject({ event: "purchase_first", purchase: { amount: 35, currency: "XTR" } });
    expect(rows.find((row) => row.goal === 2)?.purchaseId).toBe(paid);
  });

  it("весь путь на живой базе: регистрация и покупки уходят в AdsGram целями 1, 2, 3 и помечаются отправленными", async () => {
    const code = await adsgramLink("launch");
    const player = await playerFromClick(code);
    await purchase(player.accountId, 40);
    await purchase(player.accountId, 30);
    await conversions.sweep(new Date());
    const ids = (await ofAccount(player.accountId)).map((row) => row.conversionId);

    const service = new AdConversionsService(
      loadAppConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv),
      new OnlyThese(prisma, ids),
      [new AdsgramDestination({ get: () => "tok_integration" })],
      FREE_LOCK as never,
    );
    const urls: string[] = [];
    const fetchImpl = (async (input: URL | string) => {
      urls.push(String(input));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    expect(await service.tick(new Date(), fetchImpl)).toMatchObject({ sent: 3, failed: 0, skipped: 0 });
    expect(urls.map((url) => new URL(url).searchParams.get("goaltype")).sort()).toEqual(["1", "2", "3"]);
    expect(urls.every((url) => new URL(url).searchParams.get("record") === "rec123")).toBe(true);
    expect(await ofAccount(player.accountId)).toMatchObject([
      { goal: 1, status: "sent", httpStatus: 200, attempts: 1 },
      { goal: 2, status: "sent", httpStatus: 200, attempts: 1 },
      { goal: 3, status: "sent", httpStatus: 200, attempts: 1 },
    ]);
  });

  it("счёт по ссылке считает только строки своего назначения", async () => {
    const code = await adsgramLink("launch");
    const player = await playerFromClick(code);
    await conversions.sweep(new Date());
    await insertRow(player, code, { goal: 1, destination: "s2s" });
    await insertRow(player, code, { goal: 1, destination: "partner" });
    await insertRow(player, code, { goal: 4 });

    const adsgram = (await conversions.summaries([code], "adsgram")).get(code);
    expect(adsgram?.[1]).toEqual({ pending: 1, sent: 0, failed: 0, skipped: 0 });
    expect(adsgram?.[2]).toEqual({ pending: 0, sent: 0, failed: 0, skipped: 0 });
    // По умолчанию — AdsGram, как у списка ссылок в панели.
    expect((await conversions.summaries([code])).get(code)).toEqual(adsgram);
    expect((await conversions.summaries([code], "s2s")).get(code)?.[1]).toEqual({ pending: 1, sent: 0, failed: 0, skipped: 0 });
  });

  it("журнал отдаёт событие и назначение рядом с целью", async () => {
    const code = await adsgramLink("launch");
    const player = await playerFromClick(code);
    await purchase(player.accountId, 40);
    await conversions.sweep(new Date());
    await insertRow(player, code, { goal: 1, destination: "s2s" });
    const rows = await conversions.journal(code, null, 50);
    expect(rows.map((row) => [row.goal, row.event, row.destination]).sort()).toEqual([
      [1, "registration", "adsgram"],
      [1, "registration", "s2s"],
      [2, "purchase_first", "adsgram"],
    ]);
  });

  it("новое назначение подключается веткой набора: события по списку, окно по since, нумерация покупок общая", async () => {
    const code = await adsgramLink("launch");
    const player = await playerFromClick(code);
    const first = await purchase(player.accountId, 40);
    await purchase(player.accountId, 30);

    // S2S получает регистрацию и первую покупку, повторные — нет.
    await new CustomTargets(prisma, targetsWithS2s(code, ["registration", "purchase_first"])).sweep(new Date());
    await new CustomTargets(prisma, targetsWithS2s(code, ["registration", "purchase_first"])).sweep(new Date());
    const rows = await ofAccount(player.accountId);
    expect(rows.map((row) => [row.goal, row.destination, row.network])).toEqual([
      [1, "adsgram", "adsgram"],
      [1, "s2s", "s2s"],
      [2, "adsgram", "adsgram"],
      [2, "s2s", "s2s"],
      [3, "adsgram", "adsgram"],
    ]);
    // Вторая оплата не становится «первой» для назначения, которому повторные не нужны.
    expect(rows.filter((row) => row.destination === "s2s" && row.goal === 2).map((row) => row.purchaseId)).toEqual([first]);
  });

  it("набор назначений: клик раньше since отсекается, событие вне списка не уходит, ссылке без сети хватает набора", async () => {
    const plain = await plainLink();
    const player = await playerFromClick(plain);
    await purchase(player.accountId, 40);

    // Клик был пять минут назад: назначение, подключённое «с часа вперёд», его не получает.
    await new CustomTargets(prisma, targetsWithS2s(plain, ["registration", "purchase_first"], new Date(Date.now() + 60 * MINUTE))).sweep(new Date());
    expect(await ofAccount(player.accountId)).toEqual([]);

    // Подключённое час назад получает покупку, а регистрацию — нет: её нет в списке событий.
    await new CustomTargets(prisma, targetsWithS2s(plain, ["purchase_first"], new Date(Date.now() - 60 * MINUTE))).sweep(new Date());
    const rows = await ofAccount(player.accountId);
    expect(rows.map((row) => [row.goal, row.destination, row.network])).toEqual([[2, "s2s", "s2s"]]);
  });
});
