import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { LedgerChartService } from "../src/modules/ledger/ledger-chart.service.js";
import { PrismaLedgerChartRepository } from "../src/modules/ledger/ledger-chart.repository.js";
import { PrismaLedgerRepository } from "../src/modules/ledger/ledger.repository.js";
import { LedgerService } from "../src/modules/ledger/ledger.service.js";
import type { RolesService } from "../src/modules/roles/roles.service.js";
import type { AuditEntry } from "../src/modules/roles/roles.repository.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Места хранения и статьи учёта на живом Postgres (docs/17-testing-strategy.md §4.2; адрес — TEST_DATABASE_URL,
 * без него пропуск; Р220, tasks/T-0460): статьи на старте вставляет миграция, счёт статьи в валюте создаётся один
 * раз даже под гонкой, место с остатком и служебная статья не архивируются.
 *
 * Журнал не стирается, а счета с проводками не удалить, поэтому каждый прогон берёт свои названия
 * (`… <прогон>`) и по окончании убирает только счета и статьи без проводок.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

/** Статьи на старте — таблица решения Р220: id, вид, название, служебная ли. */
const START_ARTICLES = [
  ["vps", "expense", "Сервер (VPS)", false],
  ["cdn", "expense", "CDN Bunny", false],
  ["ai", "expense", "ИИ-инструменты", false],
  ["domains", "expense", "Домены", false],
  ["ads_purchase", "expense", "Закупка рекламы", false],
  ["fee_withdrawal", "expense", "Комиссия вывода", true],
  ["fee_exchange", "expense", "Комиссия обмена", true],
  ["fx_difference", "expense", "Курсовая разница", true],
  ["tax", "expense", "Налог (уплата)", true],
  ["other", "expense", "Прочее", false],
  ["ads_adsgram", "income", "Реклама: AdsGram", false],
  ["ads_richads", "income", "Реклама: RichAds", false],
  ["ads_taddy", "income", "Реклама: Taddy", false],
  ["other_income", "income", "Прочие поступления", false],
] as const;

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("ожидалась доменная ошибка, а вызов прошёл");
}

describe.skipIf(DATABASE_URL === "")("места хранения и статьи учёта на живом Postgres", () => {
  let prisma: PrismaClient;
  let ledger: LedgerService;
  let chart: LedgerChartService;
  const audit: AuditEntry[] = [];
  const run = randomUUID().slice(0, 8);
  const actor = { accountId: randomUUID() };
  const createdAccounts: string[] = [];
  const createdArticles: string[] = [];

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 12);
    ledger = new LedgerService(new PrismaLedgerRepository(prisma));
    const roles = { audit: async (entry: AuditEntry) => void audit.push(entry) } as unknown as RolesService;
    chart = new LedgerChartService(new PrismaLedgerChartRepository(prisma), ledger, roles);
  });

  afterAll(async () => {
    // Счета с проводками остаются (внешний ключ), пустые и статьи без счетов уходят.
    for (const accountId of createdAccounts) {
      const used = await prisma.ledgerLine.count({ where: { accountId } });
      if (used === 0) await prisma.ledgerAccount.deleteMany({ where: { accountId } });
    }
    for (const articleId of createdArticles) {
      const left = await prisma.ledgerAccount.count({ where: { articleId } });
      if (left === 0) await prisma.ledgerArticle.deleteMany({ where: { articleId } });
    }
    await prisma.$disconnect();
  });

  it("статьи на старте на месте: вид, название и служебные флаги — как в решении Р220", async () => {
    const rows = await prisma.ledgerArticle.findMany({ where: { articleId: { in: START_ARTICLES.map((row) => row[0]) } } });

    expect(rows).toHaveLength(START_ARTICLES.length);
    for (const [articleId, kind, name, system] of START_ARTICLES) {
      expect(rows.find((row) => row.articleId === articleId)).toMatchObject({ kind, name, system, archivedAt: null });
    }
  });

  it("места на старте получили группу: звёзды бота — одно место в двух состояниях, остальные — каждое своё", async () => {
    const accounts = await prisma.ledgerAccount.findMany({ where: { accountId: { in: ["stars.bot.hold", "stars.bot.available", "wallet.ton", "exchange.usdt", "bank.rub", "revenue.shop.telegram"] } } });
    const placeOf = Object.fromEntries(accounts.map((row) => [row.accountId, row.place]));

    expect(placeOf).toEqual({
      "stars.bot.hold": "stars.bot",
      "stars.bot.available": "stars.bot",
      "wallet.ton": "wallet.ton",
      "exchange.usdt": "exchange.usdt",
      "bank.rub": "bank.rub",
      "revenue.shop.telegram": null,
    });

    const places = await chart.places();
    const stars = places.find((place) => place.placeId === "stars.bot");
    expect(stars).toMatchObject({ name: "Звёзды бота", currency: "XTR", archived: false });
    expect(stars?.accounts.map((account) => account.accountId).sort()).toEqual(["stars.bot.available", "stars.bot.hold"]);
    expect(places.map((place) => place.placeId)).toEqual(expect.arrayContaining(["wallet.ton", "exchange.usdt", "bank.rub"]));
  });

  it("новое место: идентификатор из названия по виду валюты, шаблон комиссии сохраняется, аудит записан", async () => {
    const created = await chart.createPlace(actor, { name: `Карта ${run}`, currency: "RUB", fee: { percentBp: 150, fixed: "10.50", fixedCurrency: "RUB" } });
    createdAccounts.push(created.placeId);

    expect(created.placeId).toBe(`bank.karta-${run}`);
    expect(created).toMatchObject({ name: `Карта ${run}`, currency: "RUB", balance: "0.00", archived: false, fee: { percentBp: 150, fixed: "10.50", fixedCurrency: "RUB" } });
    const row = await prisma.ledgerAccount.findUniqueOrThrow({ where: { accountId: created.placeId } });
    expect(row).toMatchObject({ type: "asset", currency: "RUB", place: created.placeId, feePercentBp: 150, feeFixed: 1050n, feeFixedCurrency: "RUB" });
    expect(audit.some((entry) => entry.action === "ledger.place.create" && entry.target === created.placeId && entry.actorAccountId === actor.accountId)).toBe(true);
  });

  it("два места с одним названием получают разные идентификаторы: второе — с суффиксом", async () => {
    const first = await chart.createPlace(actor, { name: `Копилка ${run}`, currency: "USD" });
    const second = await chart.createPlace(actor, { name: `Копилка ${run}`, currency: "USD" });
    createdAccounts.push(first.placeId, second.placeId);

    expect(first.placeId).toBe(`bank.kopilka-${run}`);
    expect(second.placeId).toBe(`bank.kopilka-${run}-2`);
  });

  it("правка места: переименование и шаблон; null снимает шаблон; в аудит — до и после", async () => {
    const place = await chart.createPlace(actor, { name: `Касса ${run}`, currency: "GRAM", fee: { percentBp: 100, fixed: null, fixedCurrency: null } });
    createdAccounts.push(place.placeId);

    const renamed = await chart.updatePlace(actor, place.placeId, { name: `Касса новая ${run}` });
    expect(renamed.name).toBe(`Касса новая ${run}`);
    expect(renamed.fee).toEqual({ percentBp: 100, fixed: null, fixedCurrency: null });

    const cleared = await chart.updatePlace(actor, place.placeId, { fee: null });
    expect(cleared.fee).toBeNull();

    expect(audit.filter((entry) => entry.action === "ledger.place.update" && entry.target === place.placeId)).toHaveLength(2);
    expect((await domainError(chart.updatePlace(actor, `bank.net-takogo-${run}`, { name: "Нет" }))).status).toBe(404);
  });

  it("архив места с остатком — 409 ledger_place_not_empty; после сторно остаток ноль, архив проходит", async () => {
    const place = await chart.createPlace(actor, { name: `Остаток ${run}`, currency: "RUB" });
    const counter = `it.${run}.counter`;
    await prisma.ledgerAccount.create({ data: { accountId: counter, type: "revenue", currency: "RUB", name: "Тест: встречный счёт" } });
    createdAccounts.push(place.placeId, counter);
    const at = new Date("2026-11-13T12:00:00Z");
    await ledger.post({
      sourceKey: `it:${run}:fund`,
      at,
      memo: "пополнение для проверки архива",
      lines: [
        { accountId: place.placeId, amount: 10_000n },
        { accountId: counter, amount: -10_000n },
      ],
    });

    const refusal = await domainError(chart.archivePlace(actor, place.placeId));
    expect(refusal).toMatchObject({ code: "ledger_place_not_empty", status: 409 });
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { accountId: place.placeId } })).archivedAt).toBeNull();
    expect((await chart.places()).find((candidate) => candidate.placeId === place.placeId)?.balance).toBe("100.00");

    await ledger.reverse(`it:${run}:fund`, `it:${run}:fund:reversal`, at, "сторно пополнения");
    await chart.archivePlace(actor, place.placeId);

    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { accountId: place.placeId } })).archivedAt).not.toBeNull();
    expect(audit.some((entry) => entry.action === "ledger.place.archive" && entry.target === place.placeId)).toBe(true);
    // повтор архива — не ошибка и не второй аудит
    await chart.archivePlace(actor, place.placeId);
    expect(audit.filter((entry) => entry.action === "ledger.place.archive" && entry.target === place.placeId)).toHaveLength(1);
  });

  it("новая статья: идентификатор из названия, повтор названия — с суффиксом; переименование меняет и названия её счетов", async () => {
    const first = await chart.createArticle(actor, { name: `Хостинг ${run}`, kind: "expense" });
    const second = await chart.createArticle(actor, { name: `Хостинг ${run}`, kind: "income" });
    createdArticles.push(first.articleId, second.articleId);

    expect(first).toMatchObject({ articleId: `hosting-${run}`, kind: "expense", system: false, archived: false });
    expect(second.articleId).toBe(`hosting-${run}-2`);

    const accountId = await chart.ensureArticleAccount(first.articleId, "USD");
    createdAccounts.push(accountId);
    await chart.renameArticle(actor, first.articleId, `Хостинг новый ${run}`);

    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { accountId } })).name).toBe(`Хостинг новый ${run}, USD`);
    expect(audit.some((entry) => entry.action === "ledger.article.create" && entry.target === first.articleId)).toBe(true);
    expect(audit.some((entry) => entry.action === "ledger.article.rename" && entry.target === first.articleId)).toBe(true);
  });

  it("счёт статьи в валюте создаётся один раз при двух параллельных вызовах, и одна статья принимает разные валюты", async () => {
    const article = await chart.createArticle(actor, { name: `Серверы ${run}`, kind: "expense" });
    createdArticles.push(article.articleId);

    const ids = await Promise.all([chart.ensureArticleAccount(article.articleId, "USD"), chart.ensureArticleAccount(article.articleId, "USD"), chart.ensureArticleAccount(article.articleId, "USD")]);
    const rub = await chart.ensureArticleAccount(article.articleId, "RUB");
    createdAccounts.push(...ids, rub);

    expect(new Set(ids)).toEqual(new Set([`expense.servery-${run}.USD`]));
    expect(rub).toBe(`expense.servery-${run}.RUB`);
    const rows = await prisma.ledgerAccount.findMany({ where: { articleId: article.articleId }, orderBy: { currency: "asc" } });
    expect(rows.map((row) => [row.accountId, row.type, row.currency])).toEqual([
      [`expense.servery-${run}.RUB`, "expense", "RUB"],
      [`expense.servery-${run}.USD`, "expense", "USD"],
    ]);
  });

  it("счёт поступления — выручка в валюте, и проводка по нему сразу проходит", async () => {
    const income = await chart.createArticle(actor, { name: `Партнёр ${run}`, kind: "income" });
    createdArticles.push(income.articleId);
    const accountId = await chart.ensureArticleAccount(income.articleId, "USDT");
    createdAccounts.push(accountId);
    const place = await chart.createPlace(actor, { name: `Приёмная ${run}`, currency: "USDT" });
    createdAccounts.push(place.placeId);

    const result = await ledger.post({
      sourceKey: `it:${run}:income`,
      at: new Date("2026-11-13T12:00:00Z"),
      memo: "поступление",
      lines: [
        { accountId: place.placeId, amount: 5_000_000n },
        { accountId, amount: -5_000_000n },
      ],
    });

    expect(accountId).toBe(`income.partner-${run}.USDT`);
    expect(result.created).toBe(true);
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { accountId } })).type).toBe("revenue");
  });

  it("счёт статьи: неизвестная статья — 404, архивная — 409, валюта вне справочника — 400", async () => {
    const article = await chart.createArticle(actor, { name: `Старая ${run}`, kind: "expense" });
    createdArticles.push(article.articleId);
    await chart.archiveArticle(actor, article.articleId);

    expect((await domainError(chart.ensureArticleAccount(`net-takoy-${run}`, "USD"))).status).toBe(404);
    expect(await domainError(chart.ensureArticleAccount(article.articleId, "USD"))).toMatchObject({ code: "ledger_article_archived", status: 409 });
    expect((await domainError(chart.ensureArticleAccount("vps", "ABC"))).status).toBe(400);
  });

  it("служебную статью архивировать нельзя — 409 ledger_article_system, статья остаётся; обычная архивируется один раз", async () => {
    for (const articleId of ["fee_withdrawal", "fee_exchange", "fx_difference", "tax"]) {
      expect(await domainError(chart.archiveArticle(actor, articleId))).toMatchObject({ code: "ledger_article_system", status: 409 });
      expect((await prisma.ledgerArticle.findUniqueOrThrow({ where: { articleId } })).archivedAt).toBeNull();
    }

    const article = await chart.createArticle(actor, { name: `Разовая ${run}`, kind: "expense" });
    createdArticles.push(article.articleId);
    await chart.archiveArticle(actor, article.articleId);
    await chart.archiveArticle(actor, article.articleId);

    expect((await prisma.ledgerArticle.findUniqueOrThrow({ where: { articleId: article.articleId } })).archivedAt).not.toBeNull();
    expect(audit.filter((entry) => entry.action === "ledger.article.archive" && entry.target === article.articleId)).toHaveLength(1);
    expect((await domainError(chart.archiveArticle(actor, `net-takoy-${run}`))).status).toBe(404);
  });
});
