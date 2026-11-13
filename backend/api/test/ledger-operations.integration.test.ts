import { randomUUID } from "node:crypto";
import { Decimal, rateOf, type CurrencyCode, type Rate } from "@bh/fx";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import type { FxService } from "../src/modules/fx/fx.service.js";
import { PrismaLedgerChartRepository } from "../src/modules/ledger/ledger-chart.repository.js";
import { LedgerChartService } from "../src/modules/ledger/ledger-chart.service.js";
import { PrismaLedgerRepository } from "../src/modules/ledger/ledger.repository.js";
import { LedgerService } from "../src/modules/ledger/ledger.service.js";
import type { OperationInput } from "../src/modules/ledger/operations/operation-input.js";
import type { OperationView } from "../src/modules/ledger/operations/operation-view.js";
import { PrismaOperationsRepository } from "../src/modules/ledger/operations/operations.repository.js";
import { OperationsService, type OperationActor } from "../src/modules/ledger/operations/operations.service.js";
import type { AuditEntry } from "../src/modules/roles/roles.repository.js";
import type { RolesService } from "../src/modules/roles/roles.service.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Ручные операции учёта на живом Postgres (docs/17-testing-strategy.md §4.2; адрес — TEST_DATABASE_URL, без него
 * пропуск; Р220, tasks/T-0461): черновик → проводка и остатки мест, повтор и гонка проведения, правка проведённой,
 * заём (счёт-обязательство и строка условий), сторно, обмен в двух валютах, правила базы (CHECK, уникальность
 * шаблона и периода).
 *
 * Журнал не стирается, а счета с проводками не удалить, поэтому каждый прогон берёт свои названия (`… <прогон>`)
 * и по окончании убирает только операции, условия займов, счета и статьи без проводок. Остатки проверяются по
 * собственным местам прогона — они начинают с нуля и никем больше не трогаются.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

const AT = "2026-11-10";

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("ожидалась доменная ошибка, а вызов прошёл");
}

describe.skipIf(DATABASE_URL === "")("ручные операции учёта на живом Postgres", () => {
  let prisma: PrismaClient;
  let ledger: LedgerService;
  let chart: LedgerChartService;
  let operations: OperationsService;
  let operationsRepository: PrismaOperationsRepository;
  const audit: AuditEntry[] = [];
  const run = randomUUID().slice(0, 8);
  const owner: OperationActor = { accountId: randomUUID(), platform: "telegram", platformUserId: "9001" };
  const finance: OperationActor = { accountId: randomUUID(), platform: "telegram", platformUserId: "9002" };
  const otherFinance: OperationActor = { accountId: randomUUID(), platform: "telegram", platformUserId: "9003" };
  const createdAccounts: string[] = [];
  const createdArticles: string[] = [];
  const createdOperations: string[] = [];

  // Места и статьи прогона; заводятся один раз в `beforeAll`.
  let bank = "";
  let bank2 = "";
  let stars = "";
  let ton = "";
  let expenseArticle = "";
  let incomeArticle = "";

  const rates = (source: Partial<Record<CurrencyCode, string>>): Map<CurrencyCode, Rate> =>
    new Map((Object.entries(source) as [CurrencyCode, string][]).map(([code, usd]) => [code, rateOf(code, new Decimal(usd), ["test"], new Date())]));

  async function create(actor: OperationActor, input: OperationInput, template?: { templateId: string; period: string }): Promise<OperationView> {
    const view = await operations.create(actor, input, template);
    createdOperations.push(view.operationId);
    return view;
  }

  async function balanceOf(accountId: string): Promise<bigint> {
    const row = await prisma.ledgerLine.aggregate({ where: { accountId }, _sum: { amount: true } });
    return row._sum.amount ?? 0n;
  }

  async function entriesWithKey(sourceKey: string): Promise<number> {
    return await prisma.ledgerEntry.count({ where: { sourceKey } });
  }

  const expense = (amount: string, overrides: Partial<Extract<OperationInput, { kind: "expense" }>> = {}): OperationInput => ({
    kind: "expense",
    note: `Оплата сервера ${run}`,
    at: AT,
    from: bank,
    article: expenseArticle,
    amount,
    ...overrides,
  });

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 12);
    ledger = new LedgerService(new PrismaLedgerRepository(prisma));
    const roles = {
      audit: async (entry: AuditEntry) => void audit.push(entry),
      rolesFor: async (actor: OperationActor) => (actor.accountId === owner.accountId ? ["owner"] : ["finance"]),
    } as unknown as RolesService;
    chart = new LedgerChartService(new PrismaLedgerChartRepository(prisma), ledger, roles);
    const fx = { peek: async () => ({ takenAt: new Date(), rates: rates({ RUB: "0.0125", GRAM: "5" }), payout: rates({ XTR: "0.013" }) }) } as unknown as FxService;
    operationsRepository = new PrismaOperationsRepository(prisma);
    operations = new OperationsService(operationsRepository, ledger, chart, fx, roles);

    // У звёзд — шаблон «1 % + 5 звёзд»: обе части в валюте места, поэтому плательщик фиксы однозначен и на общей базе.
    const created = [
      await chart.createPlace(owner, { name: `Банк ${run}`, currency: "RUB" }),
      await chart.createPlace(owner, { name: `Карта ${run}`, currency: "RUB", fee: { percentBp: 150, fixed: null, fixedCurrency: null } }),
      await chart.createPlace(owner, { name: `Звёзды ${run}`, currency: "XTR", fee: { percentBp: 100, fixed: "5", fixedCurrency: "XTR" } }),
      await chart.createPlace(owner, { name: `Кошелёк ${run}`, currency: "GRAM" }),
    ];
    [bank, bank2, stars, ton] = created.map((place) => place.placeId) as [string, string, string, string];
    createdAccounts.push(...created.map((place) => place.placeId));
    const spend = await chart.createArticle(owner, { name: `Серверы ${run}`, kind: "expense" });
    const earn = await chart.createArticle(owner, { name: `Реклама ${run}`, kind: "income" });
    expenseArticle = spend.articleId;
    incomeArticle = earn.articleId;
    createdArticles.push(spend.articleId, earn.articleId);
  });

  afterAll(async () => {
    // Условия займов и операции — первыми: на них ссылаются внешние ключи. Счета с проводками остаются.
    await prisma.ledgerLoan.deleteMany({ where: { operationId: { in: createdOperations } } });
    await prisma.ledgerOperation.deleteMany({ where: { operationId: { in: createdOperations } } });
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

  it("черновик не двигает деньги, проведение — двигает: проводка `op:<id>`, остатки мест, оценка в долларах и ввод хранятся в базе", async () => {
    const draft = await create(finance, expense("1500"));

    expect(draft).toMatchObject({ status: "draft", entry: null, amountUsd: "18.75" });
    expect(await balanceOf(bank)).toBe(0n);
    expect(await entriesWithKey(`op:${draft.operationId}`)).toBe(0);
    const row = await prisma.ledgerOperation.findUniqueOrThrow({ where: { operationId: draft.operationId } });
    expect(row).toMatchObject({ kind: "expense", status: "draft", note: `Оплата сервера ${run}`, link: null, sourceKey: null, createdBy: finance.accountId });
    expect(row.amountUsd?.toFixed(2)).toBe("18.75");
    expect(row.input).toEqual({ kind: "expense", at: AT, from: bank, article: expenseArticle, amount: "1500" });

    const posted = await operations.submit(finance, draft.operationId);

    expect(posted.status).toBe("posted");
    expect(posted.entry).toMatchObject({ sourceKey: `op:${draft.operationId}`, memo: `Оплата сервера ${run}`, period: "2026-11", createdBy: finance.accountId });
    expect(posted.entry?.lines.map((line) => [line.accountId, line.amount])).toEqual([
      [`expense.${expenseArticle}.RUB`, "1500.00"],
      [bank, "-1500.00"],
    ]);
    expect(await balanceOf(bank)).toBe(-150_000n);
    expect((await chart.places()).find((place) => place.placeId === bank)?.balance).toBe("-1500.00");
    const after = await prisma.ledgerOperation.findUniqueOrThrow({ where: { operationId: draft.operationId } });
    expect(after).toMatchObject({ status: "posted", sourceKey: `op:${draft.operationId}` });
    expect(audit.filter((entry) => entry.target === draft.operationId).map((entry) => entry.action)).toEqual(["ledger.operation.create", "ledger.operation.submit"]);
  });

  it("повторный submit — та же проводка; три параллельных submit — одна проводка и одна отметка", async () => {
    const draft = await create(owner, expense("100"));
    const first = await operations.submit(owner, draft.operationId);
    const again = await operations.submit(owner, draft.operationId);

    expect(again.entry?.entryId).toBe(first.entry?.entryId);
    expect(await entriesWithKey(`op:${draft.operationId}`)).toBe(1);

    const racing = await create(owner, expense("200"));
    const results = await Promise.all([operations.submit(owner, racing.operationId), operations.submit(owner, racing.operationId), operations.submit(owner, racing.operationId)]);

    expect(results.every((result) => result.status === "posted")).toBe(true);
    expect(new Set(results.map((result) => result.entry?.entryId)).size).toBe(1);
    expect(await entriesWithKey(`op:${racing.operationId}`)).toBe(1);
    expect(audit.filter((entry) => entry.target === racing.operationId && entry.action === "ledger.operation.submit")).toHaveLength(1);
  });

  it("правка проведённой — 409 ledger_operation_not_draft, ввод в базе не меняется; черновик автор и владелец правят, чужой финансист — нет", async () => {
    const posted = await create(finance, expense("300"));
    await operations.submit(finance, posted.operationId);

    expect(await domainError(operations.update(owner, posted.operationId, expense("1")))).toMatchObject({ code: "ledger_operation_not_draft", status: 409 });
    expect((await prisma.ledgerOperation.findUniqueOrThrow({ where: { operationId: posted.operationId } })).input).toMatchObject({ amount: "300" });

    const draft = await create(finance, expense("400"));
    expect((await domainError(operations.update(otherFinance, draft.operationId, expense("1")))).status).toBe(403);
    expect((await operations.update(finance, draft.operationId, expense("450"))).input).toMatchObject({ amount: "450" });
    const byOwner = await operations.update(owner, draft.operationId, expense("500"));
    expect(byOwner).toMatchObject({ amountUsd: "6.25", createdBy: finance.accountId });
    expect((await prisma.ledgerOperation.findUniqueOrThrow({ where: { operationId: draft.operationId } })).input).toMatchObject({ amount: "500" });
  });

  it("discard убирает черновик из базы, проведённую операцию — нет", async () => {
    const draft = await create(owner, expense("10"));
    await operations.discard(owner, draft.operationId);
    expect(await prisma.ledgerOperation.count({ where: { operationId: draft.operationId } })).toBe(0);
    expect((await domainError(operations.get(draft.operationId))).status).toBe(404);

    const posted = await create(owner, expense("20"));
    await operations.submit(owner, posted.operationId);
    expect((await domainError(operations.discard(owner, posted.operationId))).code).toBe("ledger_operation_not_draft");
    expect(await prisma.ledgerOperation.count({ where: { operationId: posted.operationId } })).toBe(1);
  });

  it("сбой между проводкой и отметкой: черновик с записанной проводкой не правится и не удаляется, повторный submit доводит его до «проведена»", async () => {
    const draft = await create(owner, expense("700"));
    const balanceBefore = await balanceOf(bank);
    const failure = vi.spyOn(operationsRepository, "markPosted").mockRejectedValueOnce(new Error("соединение с базой потеряно"));
    try {
      await expect(operations.submit(owner, draft.operationId)).rejects.toThrow("соединение с базой потеряно");
    } finally {
      failure.mockRestore();
    }
    expect(await entriesWithKey(`op:${draft.operationId}`)).toBe(1);

    // Правка поменяла бы ввод, а проводка в журнале осталась бы по старому: повтор упёрся бы в «ключ занят другими строками».
    expect(await domainError(operations.update(owner, draft.operationId, expense("1")))).toMatchObject({ code: "ledger_operation_not_draft", status: 409 });
    expect((await domainError(operations.discard(owner, draft.operationId))).code).toBe("ledger_operation_not_draft");
    const stored = await prisma.ledgerOperation.findUniqueOrThrow({ where: { operationId: draft.operationId } });
    expect(stored).toMatchObject({ status: "draft", input: expect.objectContaining({ amount: "700" }) });

    const retry = await operations.submit(owner, draft.operationId);

    expect(retry.status).toBe("posted");
    expect(await entriesWithKey(`op:${draft.operationId}`)).toBe(1);
    expect(await balanceOf(bank)).toBe(balanceBefore - 70_000n);
  });

  it("перевод с комиссией по шаблону места списания: процент округлён вверх, комиссия — в статью «Комиссия вывода»", async () => {
    // Шаблон места «Карта» — 1,5 %; перевод идёт С неё: 1,5 % от 333.33 = 4,99995 → 5,00 ₽
    const draft = await create(finance, { kind: "transfer", note: `Перевод ${run}`, at: AT, from: bank2, to: bank, amount: "333.33" });

    expect(draft.input).toMatchObject({ fee: { amount: "5.00" } });
    const posted = await operations.submit(finance, draft.operationId);

    expect(posted.entry?.meta).toMatchObject({ kind: "transfer", fee: "5.00 RUB", feeTemplate: "1.5%" });
    expect(await balanceOf(bank2)).toBe(-33_833n);
    expect(posted.entry?.lines.find((line) => line.accountId === bank)?.amount).toBe("333.33");
    expect(posted.entry?.lines.find((line) => line.accountId === "expense.fee_withdrawal.RUB")?.amount).toBe("5.00");
  });

  it("обмен звёзд на Gram: проводка в двух валютах сходится в каждой, транзит обмена заведён, курс в проводке", async () => {
    const draft = await create(owner, { kind: "exchange", note: `Вывод звёзд ${run}`, at: AT, from: stars, to: ton, given: "10000", received: "52.3" });

    // «1 % + 5 звёзд» от 10 000 — 105 звёзд комиссии обмена, обе части в валюте звёзд
    expect(draft.input).toMatchObject({ fee: { amount: "100", fixed: { amount: "5", currency: "XTR" } } });
    const posted = await operations.submit(owner, draft.operationId);

    expect(posted.entry?.meta).toMatchObject({ kind: "exchange", rate: "0.00523", ratePair: "XTR→GRAM" });
    expect(await balanceOf(stars)).toBe(-10_105n);
    expect(await balanceOf(ton)).toBe(52_300_000_000n);
    const lines = await prisma.ledgerLine.findMany({ where: { entry: { sourceKey: `op:${draft.operationId}` } }, include: { account: true } });
    const sums = new Map<string, bigint>();
    for (const line of lines) sums.set(line.account.currency, (sums.get(line.account.currency) ?? 0n) + line.amount);
    expect(Object.fromEntries(sums)).toEqual({ XTR: 0n, GRAM: 0n });
    const transit = await prisma.ledgerAccount.findMany({ where: { accountId: { in: ["exchange.transit.XTR", "exchange.transit.GRAM"] } }, orderBy: { accountId: "asc" } });
    expect(transit.map((account) => [account.accountId, account.type, account.currency, account.place])).toEqual([
      ["exchange.transit.GRAM", "asset", "GRAM", null],
      ["exchange.transit.XTR", "asset", "XTR", null],
    ]);
  });

  it("заём: счёт-обязательство и строка условий появляются вместе с проводкой; второй заём того же кредитора идёт на тот же счёт", async () => {
    const lender = `Кредитор ${run}`;
    const accountId = `loan.kreditor-${run}.RUB`;
    const draft = await create(owner, { kind: "loan", note: `Заём на рекламу ${run}`, at: AT, to: bank, lender, amount: "100000", premium: "10000", repaymentBp: 2500 });

    expect(draft.loan).toBeNull();
    expect(await prisma.ledgerLoan.count({ where: { operationId: draft.operationId } })).toBe(0);
    expect(await prisma.ledgerAccount.count({ where: { accountId } })).toBe(0);

    const posted = await operations.submit(owner, draft.operationId);
    createdAccounts.push(accountId);

    expect(posted.loan).toMatchObject({ lender, accountId, currency: "RUB", principal: "100000.00", premium: "10000.00", repaymentBp: 2500 });
    const account = await prisma.ledgerAccount.findUniqueOrThrow({ where: { accountId } });
    expect(account).toMatchObject({ type: "liability", currency: "RUB", name: `Заём: ${lender}`, place: null });
    const loan = await prisma.ledgerLoan.findUniqueOrThrow({ where: { operationId: draft.operationId } });
    expect(loan).toMatchObject({ lender, accountId, currency: "RUB", principal: 10_000_000n, premium: 1_000_000n, repaymentBp: 2500 });
    expect(await balanceOf(accountId)).toBe(-10_000_000n);

    const second = await create(owner, { kind: "loan", note: `Ещё заём ${run}`, at: AT, to: bank, lender, amount: "50000", premium: "0", repaymentBp: 1000 });
    await operations.submit(owner, second.operationId);

    expect(await prisma.ledgerLoan.count({ where: { accountId } })).toBe(2);
    expect(await prisma.ledgerAccount.count({ where: { accountId } })).toBe(1);
    expect(await balanceOf(accountId)).toBe(-15_000_000n);
  });

  it("исправление — сторно исходной проводки: остатки возвращаются, второе исправление той же проводки — 409", async () => {
    const original = await create(owner, expense("700"));
    const posted = await operations.submit(owner, original.operationId);
    const before = await balanceOf(`expense.${expenseArticle}.RUB`);
    const key = posted.entry?.sourceKey ?? "";

    const fix = await create(owner, { kind: "reversal", note: `Оплатили иначе ${run}`, at: AT, sourceKey: key });
    expect(fix).toMatchObject({ status: "draft", amountUsd: null });
    const fixed = await operations.submit(owner, fix.operationId);

    expect(fixed.entry).toMatchObject({ reversalOf: key, memo: `Оплатили иначе ${run}` });
    expect(await balanceOf(`expense.${expenseArticle}.RUB`)).toBe(before - 70_000n);
    expect(fixed.entry?.lines.map((line) => line.amount).sort()).toEqual(["-700.00", "700.00"]);

    const again = await create(owner, { kind: "reversal", note: `Ещё раз ${run}`, at: AT, sourceKey: key });
    expect((await domainError(operations.submit(owner, again.operationId))).code).toBe("ledger_already_reversed");
    expect(await entriesWithKey(`op:${again.operationId}`)).toBe(0);
    expect((await domainError(create(owner, { kind: "reversal", note: `Нет такой ${run}`, at: AT, sourceKey: `op:${randomUUID()}` }))).code).toBe("ledger_operation_invalid");
  });

  it("поступление в рубли: без чека — receiptMissing, «за какой месяц» и чек НПД лежат в проводке", async () => {
    const base = { kind: "income", at: AT, to: bank, article: incomeArticle, amount: "5000.50", forMonth: "2026-10" } as const;

    const withoutReceipt = await create(finance, { ...base, note: `Выплата сети ${run}` });
    const postedWithout = await operations.submit(finance, withoutReceipt.operationId);
    expect(withoutReceipt.receiptMissing).toBe(true);
    expect(postedWithout).toMatchObject({ status: "posted", receiptMissing: true });
    expect(postedWithout.entry?.meta).toMatchObject({ forMonth: "2026-10" });

    const withReceipt = await create(finance, { ...base, note: `Выплата сети с чеком ${run}`, receipt: { payer: "legal", number: "2026-11-ab12", link: "https://lknpd.nalog.ru/check/1" } });
    const postedWith = await operations.submit(finance, withReceipt.operationId);
    expect(postedWith.receiptMissing).toBe(false);
    expect(postedWith.entry?.meta).toMatchObject({ forMonth: "2026-10", receiptPayer: "legal", receiptNumber: "2026-11-ab12", receiptLink: "https://lknpd.nalog.ru/check/1" });
    expect(await balanceOf(`income.${incomeArticle}.RUB`)).toBe(-1_000_100n);
  });

  it("список: новые сверху, страницы по курсору без повторов, фильтры по статусу и виду; у проведённой — проводка", async () => {
    const ids: string[] = [];
    for (const amount of ["11", "12", "13"]) {
      ids.push((await create(owner, expense(amount, { note: `Список ${run} ${amount}` }))).operationId);
      // Время создания — с точностью до миллисекунды: порядок страниц без паузы зависел бы от случайных id.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await operations.submit(owner, ids[0] ?? "");

    const first = await operations.list({}, null, 2);
    const second = await operations.list({}, first.next, 2);

    expect(first.operations.map((operation) => operation.operationId)).toEqual([ids[2], ids[1]]);
    expect(first.next).not.toBeNull();
    expect(second.operations[0]?.operationId).toBe(ids[0]);
    expect(second.operations[0]?.entry).not.toBeNull();
    const drafts = await operations.list({ status: "draft", kind: "expense" }, null, 100);
    expect(drafts.operations.every((operation) => operation.status === "draft" && operation.kind === "expense")).toBe(true);
    expect(drafts.operations.map((operation) => operation.operationId)).toEqual(expect.arrayContaining([ids[2], ids[1]]));
    expect(drafts.operations.map((operation) => operation.operationId)).not.toContain(ids[0]);
  });

  it("черновик по шаблону на период один: повтор — 409, а в базе — одна строка; другой период и обычные черновики не мешают", async () => {
    const template = { templateId: `it-${run}`, period: "2026-11" };

    const first = await create(owner, expense("999"), template);
    const error = await domainError(operations.create(owner, expense("999"), template));
    const otherPeriod = await create(owner, expense("999"), { templateId: template.templateId, period: "2026-10" });

    expect(first).toMatchObject({ templateId: template.templateId, templatePeriod: "2026-11" });
    expect(error).toMatchObject({ code: "ledger_operation_template_taken", status: 409 });
    expect(otherPeriod.templatePeriod).toBe("2026-10");
    expect(await prisma.ledgerOperation.count({ where: { templateId: template.templateId } })).toBe(2);
  });

  it("правила базы: период шаблона «ГГГГ-ММ» и только вместе с шаблоном, проведённая несёт ключ, условия займа в границах", async () => {
    const base = { kind: "expense", input: {}, note: "проверка правил базы", createdBy: randomUUID() } as const;
    const row = async (extra: object) => {
      const operationId = randomUUID();
      createdOperations.push(operationId);
      return await prisma.ledgerOperation.create({ data: { operationId, ...base, ...extra } });
    };

    await expect(row({ templateId: `it-${run}-x`, templatePeriod: "2026-13" })).rejects.toThrow();
    await expect(row({ templateId: `it-${run}-y` })).rejects.toThrow();
    await expect(row({ templatePeriod: "2026-11" })).rejects.toThrow();
    await expect(row({ status: "posted" })).rejects.toThrow();
    await expect(row({ amountUsd: "-1" })).rejects.toThrow();
    const valid = await row({});
    expect(valid.status).toBe("draft");

    const loan = (extra: object) => prisma.ledgerLoan.create({ data: { loanId: randomUUID(), lender: "Тест", accountId: bank, currency: "RUB", principal: 100n, premium: 0n, repaymentBp: 0, operationId: valid.operationId, ...extra } });
    await expect(loan({ repaymentBp: 10_001 })).rejects.toThrow();
    await expect(loan({ repaymentBp: -1 })).rejects.toThrow();
    await expect(loan({ premium: -1n })).rejects.toThrow();
    await expect(loan({ principal: 0n })).rejects.toThrow();
    await expect(loan({ operationId: randomUUID() })).rejects.toThrow();
    await expect(loan({ accountId: `net.takogo.${run}` })).rejects.toThrow();
    expect(await prisma.ledgerLoan.count({ where: { operationId: valid.operationId } })).toBe(0);
  });
});
