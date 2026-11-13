import { randomUUID } from "node:crypto";
import { Decimal, rateOf, type CurrencyCode, type Rate } from "@bh/fx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import type { FxService } from "../src/modules/fx/fx.service.js";
import { PrismaLedgerChartRepository } from "../src/modules/ledger/ledger-chart.repository.js";
import { LedgerChartService } from "../src/modules/ledger/ledger-chart.service.js";
import { PrismaLedgerRepository } from "../src/modules/ledger/ledger.repository.js";
import { LedgerService } from "../src/modules/ledger/ledger.service.js";
import { PrismaOperationsRepository } from "../src/modules/ledger/operations/operations.repository.js";
import { OperationsService, type OperationActor } from "../src/modules/ledger/operations/operations.service.js";
import { PrismaTemplatesRepository } from "../src/modules/ledger/templates/templates.repository.js";
import { TemplatesService } from "../src/modules/ledger/templates/templates.service.js";
import type { AuditEntry } from "../src/modules/roles/roles.repository.js";
import type { RolesService } from "../src/modules/roles/roles.service.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Шаблоны повторяющихся расходов на живом Postgres (docs/17-testing-strategy.md §4.2; адрес — TEST_DATABASE_URL,
 * без него пропуск; Р220, tasks/T-0463): «Расходы месяца» создаёт по черновику на шаблон, две одновременные
 * команды на один период не плодят дублей, архивный шаблон черновика не даёт, период вне окна — 400, правила
 * таблицы шаблонов (месяц годового, сумма больше нуля) держит база.
 *
 * Журнал не стирается, а счета с проводками не удалить, поэтому каждый прогон берёт свои названия (`… <прогон>`)
 * и в конце убирает только свои операции, шаблоны, счета и статьи без проводок. Шаблоны никогда не проводятся:
 * проводок в этом файле нет вовсе.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("ожидалась доменная ошибка, а вызов прошёл");
}

describe.skipIf(DATABASE_URL === "")("шаблоны расходов на живом Postgres", () => {
  let prisma: PrismaClient;
  let chart: LedgerChartService;
  let operations: OperationsService;
  let templates: TemplatesService;
  const audit: AuditEntry[] = [];
  const run = randomUUID().slice(0, 8);
  const actor: OperationActor = { accountId: randomUUID(), platform: "telegram", platformUserId: "9101" };
  const createdAccounts: string[] = [];
  const createdArticles: string[] = [];
  const createdTemplates: string[] = [];

  let bank = "";
  let articleServers = "";
  let articleCdn = "";
  let articleDomains = "";

  /** Нынешний месяц по UTC: окно периода считается от настоящего времени, а оно у теста настоящее. */
  const now = new Date();
  const period = now.toISOString().slice(0, 7);

  const rates = (source: Partial<Record<CurrencyCode, string>>): Map<CurrencyCode, Rate> =>
    new Map((Object.entries(source) as [CurrencyCode, string][]).map(([code, usd]) => [code, rateOf(code, new Decimal(usd), ["test"], new Date())]));

  async function createTemplate(name: string, articleId: string, schedule: "monthly" | "yearly" = "monthly", month?: number): Promise<string> {
    const view = await templates.create(actor, { name: `${name} ${run}`, articleId, placeAccountId: bank, amount: "1500", schedule, ...(month === undefined ? {} : { month }) });
    createdTemplates.push(view.templateId);
    return view.templateId;
  }

  /** Операции прогона по шаблонам за период: других на этом месяце у тестовых шаблонов не бывает. */
  async function operationsOf(templateIds: readonly string[], forPeriod: string): Promise<{ operationId: string; templateId: string | null; status: string }[]> {
    return await prisma.ledgerOperation.findMany({ where: { templateId: { in: [...templateIds] }, templatePeriod: forPeriod }, select: { operationId: true, templateId: true, status: true } });
  }

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 12);
    const ledger = new LedgerService(new PrismaLedgerRepository(prisma));
    const roles = {
      audit: async (entry: AuditEntry) => void audit.push(entry),
      rolesFor: async () => ["finance"],
    } as unknown as RolesService;
    chart = new LedgerChartService(new PrismaLedgerChartRepository(prisma), ledger, roles);
    const fx = { peek: async () => ({ takenAt: new Date(), rates: rates({ RUB: "0.0125" }), payout: rates({ XTR: "0.013" }) }) } as unknown as FxService;
    operations = new OperationsService(new PrismaOperationsRepository(prisma), ledger, chart, fx, roles);
    templates = new TemplatesService(new PrismaTemplatesRepository(prisma), operations, chart, roles);

    const place = await chart.createPlace(actor, { name: `Карта ${run}`, currency: "RUB" });
    bank = place.placeId;
    createdAccounts.push(place.placeId);
    for (const name of ["Серверы", "CDN", "Домены"]) {
      const article = await chart.createArticle(actor, { name: `${name} ${run}`, kind: "expense" });
      createdArticles.push(article.articleId);
    }
    [articleServers, articleCdn, articleDomains] = createdArticles as [string, string, string];
  });

  afterAll(async () => {
    // Операции — первыми (на них ссылаются только по ключу, но так проще), затем шаблоны на статьи и места.
    await prisma.ledgerOperation.deleteMany({ where: { templateId: { in: createdTemplates } } });
    await prisma.ledgerTemplate.deleteMany({ where: { templateId: { in: createdTemplates } } });
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

  it("шаблон хранится: сумма в минимальных единицах, идентификатор из названия, создатель и аудит", async () => {
    const templateId = await createTemplate("Тариф", articleServers);
    const row = await prisma.ledgerTemplate.findUniqueOrThrow({ where: { templateId } });
    expect(row).toMatchObject({ name: `Тариф ${run}`, articleId: articleServers, placeAccountId: bank, amount: 150_000n, schedule: "monthly", month: null, archivedAt: null, createdBy: actor.accountId });
    expect(audit.some((entry) => entry.action === "ledger.template.create" && entry.target === templateId)).toBe(true);
  });

  it("«Расходы месяца» создаёт по черновику на шаблон, повтор — «создано 0, уже было N», сумма и место берутся из шаблона", async () => {
    const vps = await createTemplate("VPS", articleServers);
    const cdn = await createTemplate("CDN-тариф", articleCdn);

    const first = await templates.draftPeriod(actor, period, now);
    // Шаблоны других прогонов на общей базе тоже наступили — считаем только свои.
    expect(first.created).toBeGreaterThanOrEqual(2);
    const mine = await operationsOf([vps, cdn], period);
    expect(mine).toHaveLength(2);
    expect(mine.every((operation) => operation.status === "draft")).toBe(true);

    const operation = await prisma.ledgerOperation.findFirstOrThrow({ where: { templateId: vps, templatePeriod: period } });
    expect(operation).toMatchObject({ kind: "expense", note: expect.stringContaining(`VPS ${run} за `) });
    expect(operation.input).toMatchObject({ from: bank, article: articleServers, amount: "1500.00" });

    const second = await templates.draftPeriod(actor, period, now);
    expect(second.created).toBe(0);
    expect(second.existing).toBeGreaterThanOrEqual(2);
    expect(await operationsOf([vps, cdn], period)).toHaveLength(2);
  });

  it("два одновременных «Расходы месяца» на один период: черновиков столько же, сколько шаблонов, суммы «создано» сходятся", async () => {
    // Свежий период: предыдущий месяц, на который тесты выше черновиков не создавали.
    const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const ids = [await createTemplate("Гонка-1", articleServers), await createTemplate("Гонка-2", articleCdn), await createTemplate("Гонка-3", articleDomains)];

    const results = await Promise.all([templates.draftPeriod(actor, previous, now), templates.draftPeriod(actor, previous, now), templates.draftPeriod(actor, previous, now)]);

    expect(await operationsOf(ids, previous)).toHaveLength(ids.length);
    // Каждый черновик создал ровно один из вызовов: «создано» не меньше числа моих шаблонов (чужие тоже наступили).
    const createdTotal = results.reduce((sum, result) => sum + result.created, 0);
    expect(createdTotal).toBeGreaterThanOrEqual(ids.length);
    for (const result of results) expect(result.failed).toEqual([]);
    // Всего на период по общей базе: сумма «создано» и «уже было» в каждом вызове — все наступившие шаблоны.
    const totals = new Set(results.map((result) => result.created + result.existing));
    expect(totals.size).toBe(1);
  });

  it("убранный черновик освобождает период: «Расходы месяца» создаёт его снова", async () => {
    const id = await createTemplate("Убранный", articleDomains);
    await templates.draftPeriod(actor, period, now);
    const [draft] = await operationsOf([id], period);
    if (draft === undefined) throw new Error("черновик не создан");
    await operations.discard(actor, draft.operationId);

    const again = await templates.draftPeriod(actor, period, now);
    expect(again.created).toBeGreaterThanOrEqual(1);
    expect(await operationsOf([id], period)).toHaveLength(1);
  });

  it("архивный шаблон черновика не даёт; архив с аудитом, повтор архива — без второго аудита", async () => {
    const id = await createTemplate("Архивный", articleServers);
    await templates.archive(actor, id);
    await templates.archive(actor, id);
    expect(audit.filter((entry) => entry.action === "ledger.template.archive" && entry.target === id)).toHaveLength(1);

    await templates.draftPeriod(actor, period, now);
    expect(await operationsOf([id], period)).toHaveLength(0);
    expect((await prisma.ledgerTemplate.findUniqueOrThrow({ where: { templateId: id } })).archivedAt).not.toBeNull();
  });

  it("годовой шаблон наступает только в своём месяце", async () => {
    const otherMonth = ((now.getUTCMonth() + 1) % 12) + 1;
    const thisMonth = now.getUTCMonth() + 1;
    const off = await createTemplate("Годовой-мимо", articleDomains, "yearly", otherMonth);
    const on = await createTemplate("Годовой-в-срок", articleDomains, "yearly", thisMonth);

    await templates.draftPeriod(actor, period, now);
    expect(await operationsOf([off], period)).toHaveLength(0);
    expect(await operationsOf([on], period)).toHaveLength(1);
  });

  it("период вне окна или не в формате — 400, черновиков не прибавилось", async () => {
    const id = await createTemplate("Окно", articleServers);
    const tooOld = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)).toISOString().slice(0, 7);
    const tooFar = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1)).toISOString().slice(0, 7);
    for (const bad of [tooOld, tooFar, "2026-13", "ноябрь"]) {
      const error = await domainError(templates.draftPeriod(actor, bad, now));
      expect(error.status).toBe(400);
    }
    expect(await prisma.ledgerOperation.count({ where: { templateId: id } })).toBe(0);
  });

  it("сбой одного шаблона (статью архивировали) назван в ответе, остальные созданы", async () => {
    const spoiled = await chart.createArticle(actor, { name: `Закроют ${run}`, kind: "expense" });
    createdArticles.push(spoiled.articleId);
    const bad = await createTemplate("Сломанный", spoiled.articleId);
    const good = await createTemplate("Целый", articleServers);
    await chart.archiveArticle(actor, spoiled.articleId);

    const result = await templates.draftPeriod(actor, period, now);
    expect(result.failed.map((entry) => entry.templateId)).toContain(bad);
    expect(await operationsOf([bad], period)).toHaveLength(0);
    expect(await operationsOf([good], period)).toHaveLength(1);
  });

  it("база держит правила таблицы: годовой без месяца, месячный с месяцем, месяц вне 1…12 и сумма не больше нуля не записываются", async () => {
    const base = { templateId: `proverka-${run}`, name: "Проверка", articleId: articleServers, placeAccountId: bank, amount: 100n, createdBy: actor.accountId };
    createdTemplates.push(base.templateId);
    await expect(prisma.ledgerTemplate.create({ data: { ...base, schedule: "yearly", month: null } })).rejects.toThrow();
    await expect(prisma.ledgerTemplate.create({ data: { ...base, schedule: "monthly", month: 3 } })).rejects.toThrow();
    await expect(prisma.ledgerTemplate.create({ data: { ...base, schedule: "yearly", month: 13 } })).rejects.toThrow();
    await expect(prisma.ledgerTemplate.create({ data: { ...base, schedule: "monthly", month: null, amount: 0n } })).rejects.toThrow();
    await prisma.ledgerTemplate.create({ data: { ...base, schedule: "monthly", month: null } });
    expect(await prisma.ledgerTemplate.count({ where: { templateId: base.templateId } })).toBe(1);
  });

  it("шаблон не провёл ничего: в журнале нет проводок по ключам операций прогона", async () => {
    const ops = await prisma.ledgerOperation.findMany({ where: { templateId: { in: createdTemplates } }, select: { operationId: true, status: true, sourceKey: true } });
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((operation) => operation.status === "draft" && operation.sourceKey === null)).toBe(true);
    expect(await prisma.ledgerLine.count({ where: { accountId: bank } })).toBe(0);
  });
});
