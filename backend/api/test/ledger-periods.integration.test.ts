import { randomUUID } from "node:crypto";
import { Decimal, type CurrencyCode } from "@bh/fx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import type { FxService } from "../src/modules/fx/fx.service.js";
import { PrismaLedgerRepository } from "../src/modules/ledger/ledger.repository.js";
import { LedgerService } from "../src/modules/ledger/ledger.service.js";
import { PrismaPeriodLock } from "../src/modules/ledger/periods/period-lock.js";
import { periodRange } from "../src/modules/ledger/periods/period-rules.js";
import { PrismaPeriodsRepository } from "../src/modules/ledger/periods/periods.repository.js";
import { PeriodsService } from "../src/modules/ledger/periods/periods.service.js";
import type { AuditEntry } from "../src/modules/roles/roles.repository.js";
import type { AccountRef, RolesService } from "../src/modules/roles/roles.service.js";
import type { SettingsReader } from "../src/modules/settings/settings.service.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Месяцы учёта на живом Postgres (docs/17-testing-strategy.md §4.2; адрес — TEST_DATABASE_URL, без него пропуск;
 * Р222, tasks/T-0468): закрытие пишет проводки налога и долгов под ключами месяца и раза, в закрытый месяц ничего
 * не проводится, два одновременных закрытия — одно, снятие закрытия сторнирует проводки закрытия, повторное
 * закрытие не конфликтует с первым, блокеры находятся запросами к операциям и покупкам.
 *
 * Журнал не стирается, поэтому каждый тест берёт свой месяц в прошлом веке (`19ГГ-ММ`): другие файлы пишут в 2026
 * и позже, и месяц теста никому больше не принадлежит. Счета теста — со своим суффиксом прогона. По окончании
 * убираются строки месяцев, доли, операции и покупки теста — проводки остаются.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
/** День закрытия: все месяцы теста давно кончились. */
const NOW = new Date("2026-12-02T10:00:00.000Z");

const RATES: Record<string, string> = { USD: "1", XTR: "0.013", RUB: "0.0125" };

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("ожидалась доменная ошибка, а вызов прошёл");
}

describe.skipIf(DATABASE_URL === "")("месяцы учёта на живом Postgres", () => {
  let prisma: PrismaClient;
  let ledger: LedgerService;
  let periods: PeriodsService;
  let people: PrismaAccountRepository;
  const run = randomUUID().slice(0, 8);
  const audit: AuditEntry[] = [];
  const resets: string[] = [];
  const hooks = { payouts: false };
  const owner: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: "9101" };
  const usedPeriods: string[] = [];
  const createdAccounts: string[] = [];
  const createdOperations: string[] = [];
  const createdPurchases: string[] = [];

  const ACCOUNT = {
    stars: `stars.it${run}`,
    revenue: `revenue.it${run}`,
    bank: `bank.it${run}`,
    income: `income.it${run}.RUB`,
    expense: `expense.it${run}.RUB`,
  };

  /** Месяц 19ГГ-ММ, в котором нет ни строки месяца, ни проводок: каждый тест — в своём. */
  async function freshPeriod(): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const year = 1910 + Math.floor(Math.random() * 89);
      const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, "0");
      const period = `${String(year)}-${month}`;
      if (usedPeriods.includes(period)) continue;
      const busy = (await prisma.ledgerPeriod.count({ where: { period } })) + (await prisma.ledgerEntry.count({ where: { period } }));
      if (busy === 0) {
        usedPeriods.push(period);
        return period;
      }
    }
    throw new Error("не нашёлся свободный месяц для теста");
  }

  const at = (period: string, day: string, time = "12:00:00.000Z") => new Date(`${period}-${day}T${time}`);

  /** Оплата звёздами: холд растёт, выручка — тоже; в звёздах. */
  async function sale(period: string, key: string, stars: bigint, day = "10") {
    return await ledger.post({
      sourceKey: `it:${run}:${key}`,
      at: at(period, day),
      memo: "Оплата набора",
      lines: [
        { accountId: ACCOUNT.stars, amount: stars },
        { accountId: ACCOUNT.revenue, amount: -stars },
      ],
    });
  }

  /** Поступление в рублях в банк: с чеком или без — как у операции «поступление». */
  async function income(period: string, key: string, kopecks: bigint, receipt: "individual" | "legal" | null, day = "12") {
    return await ledger.post({
      sourceKey: `it:${run}:${key}`,
      at: at(period, day),
      memo: "Поступление от сети",
      lines: [
        { accountId: ACCOUNT.bank, amount: kopecks },
        { accountId: ACCOUNT.income, amount: -kopecks },
      ],
      meta: { kind: "income", operation: randomUUID(), ...(receipt === null ? {} : { receiptPayer: receipt }) },
    });
  }

  async function person(name: string): Promise<string> {
    const account = await people.upsert({ platform: "telegram", platformUserId: String(940_000_000 + Math.floor(Math.random() * 50_000_000)), displayName: name, username: null, photoUrl: null }, NOW.getTime());
    createdAccounts.push(account.accountId);
    return account.accountId;
  }

  /** Доля участника с месяца: строка пишется напрямую — проверка предела здесь не предмет теста. */
  async function share(accountId: string, period: string, bp: number) {
    await prisma.stakeholderShare.upsert({
      where: { accountId_fromMonth: { accountId, fromMonth: new Date(`${period}-01T00:00:00.000Z`) } },
      create: { shareId: randomUUID(), accountId, fromMonth: new Date(`${period}-01T00:00:00.000Z`), shareBp: bp, note: "доля теста", setBy: accountId },
      update: { shareBp: bp },
    });
  }

  async function entryKeys(prefix: string): Promise<string[]> {
    const rows = await prisma.ledgerEntry.findMany({ where: { sourceKey: { startsWith: prefix } }, select: { sourceKey: true }, orderBy: { sourceKey: "asc" } });
    return rows.map((row) => row.sourceKey);
  }

  const lineSum = async (accountId: string, period: string) => (await prisma.ledgerLine.aggregate({ where: { accountId, entry: { period } }, _sum: { amount: true } }))._sum.amount ?? 0n;

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 12);
    ledger = new LedgerService(new PrismaLedgerRepository(prisma), new PrismaPeriodLock(prisma));
    people = new PrismaAccountRepository(prisma);
    const fx = {
      ratesAt: async (queries: readonly { currency: CurrencyCode; at: Date }[]) =>
        queries.map((query) => (RATES[query.currency] === undefined ? null : { usdPerUnit: new Decimal(RATES[query.currency] ?? "0"), at: new Date(0), stale: false, source: "market" as const })),
    } as unknown as FxService;
    const settings: SettingsReader = { get: (setting) => setting.fallback, onChange: () => undefined };
    const roles = { audit: async (entry: AuditEntry) => void audit.push(entry) } as unknown as RolesService;
    periods = new PeriodsService(
      new PrismaPeriodsRepository(prisma),
      fx,
      settings,
      roles,
      {
        hasPayouts: async () => hooks.payouts,
        resetConfirmations: async (period: string) => void resets.push(period),
      },
    );
    await prisma.ledgerAccount.createMany({
      data: [
        { accountId: ACCOUNT.stars, type: "asset", currency: "XTR", name: `Звёзды теста ${run}` },
        { accountId: ACCOUNT.revenue, type: "revenue", currency: "XTR", name: `Выручка теста ${run}` },
        { accountId: ACCOUNT.bank, type: "asset", currency: "RUB", name: `Банк теста ${run}` },
        { accountId: ACCOUNT.income, type: "revenue", currency: "RUB", name: `Поступления теста ${run}` },
        { accountId: ACCOUNT.expense, type: "expense", currency: "RUB", name: `Расходы теста ${run}` },
      ],
      skipDuplicates: true,
    });
  });

  afterAll(async () => {
    await prisma.ledgerOperation.deleteMany({ where: { operationId: { in: createdOperations } } });
    await prisma.purchase.deleteMany({ where: { purchaseId: { in: createdPurchases } } });
    await prisma.stakeholderShare.deleteMany({ where: { accountId: { in: createdAccounts } } });
    await prisma.ledgerPeriod.deleteMany({ where: { period: { in: usedPeriods } } });
    await prisma.$disconnect();
  });

  it("закрытие: налог с чека и долг участнику — проводками `close:<м>:r0:…`, месяц закрыт, снимок и аудит на месте", async () => {
    const period = await freshPeriod();
    const alice = await person("Алиса");
    await share(alice, period, 2_500);
    await sale(period, `${period}:s1`, 10_000n);
    await income(period, `${period}:i1`, 400_000n, "individual");
    await periods.startReview(owner, period, NOW);

    await periods.close(owner, period, NOW);

    // выручка 10 000 ⭐ × 0,013 = 130 $, поступление 4 000 ₽ × 0,0125 = 50 $; налог 4 % от 4 000 ₽ = 160 ₽ = 2 $
    // прибыль 178 $, доля 25 % = 44,50 $ = 3 560 ₽ по курсу рубля 0,0125
    expect(await entryKeys(`close:${period}:`)).toEqual([`close:${period}:r0:payout:${alice}`, `close:${period}:r0:tax`]);
    const tax = await prisma.ledgerEntry.findUniqueOrThrow({ where: { sourceKey: `close:${period}:r0:tax` }, include: { lines: true } });
    expect(tax.period).toBe(period);
    expect(tax.at.toISOString()).toBe(NOW.toISOString());
    expect(tax.lines.map((entryLine) => [entryLine.accountId, entryLine.amount]).sort()).toEqual([
      ["expense.tax_accrued.RUB", 16_000n],
      ["liability.tax.RUB", -16_000n],
    ]);
    expect(await lineSum(`liability.stakeholder.${alice}.RUB`, period)).toBe(-356_000n);
    expect(await lineSum("equity.distribution.RUB", period)).toBe(356_000n);

    const row = await prisma.ledgerPeriod.findUniqueOrThrow({ where: { period } });
    expect(row).toMatchObject({ status: "closed", reopenedCount: 0, closedBy: owner.accountId });
    expect(row.closedAt).not.toBeNull();
    expect(row.snapshot).toMatchObject({ version: 1, period, round: 0 });
    expect(audit.filter((entry) => entry.target === period).map((entry) => entry.action)).toEqual(["ledger.period.review", "ledger.period.close"]);

    const report = await periods.report(period, NOW);
    expect(report).toMatchObject({ status: "closed", reportIsDraft: false });
    expect(report.report?.payouts).toEqual([expect.objectContaining({ accountId: alice, rub: "3560.00" })]);
  });

  it("в закрытый месяц ничего не проводится: 409 `ledger_period_closed`, и по дате, и по «за какой месяц»", async () => {
    const period = await freshPeriod();
    await sale(period, `${period}:s1`, 1_000n);
    await periods.startReview(owner, period, NOW);
    await periods.close(owner, period, NOW);

    const byDate = await domainError(sale(period, `${period}:late`, 500n, "20"));
    const byMonth = await domainError(
      ledger.post({
        sourceKey: `it:${run}:${period}:for-month`,
        at: NOW,
        period,
        memo: "Расход за прошлый месяц",
        lines: [
          { accountId: ACCOUNT.bank, amount: -1_000n },
          { accountId: ACCOUNT.expense, amount: 1_000n },
        ],
      }),
    );
    expect([byDate.code, byDate.status, byMonth.code]).toEqual(["ledger_period_closed", 409, "ledger_period_closed"]);
    expect(await entryKeys(`it:${run}:${period}:late`)).toEqual([]);
    // следующий месяц открыт: расход, внесённый сегодня, проходит
    await ledger.post({
      sourceKey: `it:${run}:${period}:today`,
      at: NOW,
      memo: "Расход за сегодня",
      lines: [
        { accountId: ACCOUNT.bank, amount: -1_000n },
        { accountId: ACCOUNT.expense, amount: 1_000n },
      ],
    });
  });

  it("месяц на сверке проводки принимает: блокер снимается именно проводкой, а не запретом", async () => {
    const period = await freshPeriod();
    await periods.startReview(owner, period, NOW);

    await sale(period, `${period}:during-review`, 300n);

    expect(await entryKeys(`it:${run}:${period}:during-review`)).toHaveLength(1);
  });

  it("два одновременных закрытия — одно: второе получает 409, проводок закрытия ровно столько, сколько у одного", async () => {
    const period = await freshPeriod();
    const alice = await person("Алиса");
    await share(alice, period, 1_000);
    await sale(period, `${period}:s1`, 10_000n);
    await periods.startReview(owner, period, NOW);

    const results = await Promise.allSettled([periods.close(owner, period, NOW), periods.close(owner, period, NOW)]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason instanceof DomainError ? failed.reason.code : "").toMatch(/^ledger_period_(status|changed)$/u);
    expect(await entryKeys(`close:${period}:`)).toEqual([`close:${period}:r0:payout:${alice}`]);
    expect(audit.filter((entry) => entry.target === period && entry.action === "ledger.period.close")).toHaveLength(1);
  });

  it("снятие закрытия сторнирует все проводки закрытия, месяц снова «на сверке»; повторное закрытие — ключи r1 без конфликта", async () => {
    const period = await freshPeriod();
    const alice = await person("Алиса");
    await share(alice, period, 2_500);
    await sale(period, `${period}:s1`, 10_000n);
    await income(period, `${period}:i1`, 400_000n, "legal");
    await periods.startReview(owner, period, NOW);
    await periods.close(owner, period, NOW);
    const taxBefore = await lineSum("expense.tax_accrued.RUB", period);
    expect(taxBefore).toBeGreaterThan(0n);

    await periods.reopen(owner, period, "Участник оспорил отчёт", NOW);

    expect(await entryKeys(`reopen:${period}:`)).toEqual([`reopen:${period}:r0:payout:${alice}`, `reopen:${period}:r0:tax`]);
    const reversals = await prisma.ledgerEntry.findMany({ where: { sourceKey: { startsWith: `reopen:${period}:` } }, include: { original: { select: { sourceKey: true } } } });
    expect(reversals.map((entry) => entry.original?.sourceKey).sort()).toEqual([`close:${period}:r0:payout:${alice}`, `close:${period}:r0:tax`]);
    expect(reversals.every((entry) => entry.period === period)).toBe(true);
    // начисления взаимно уничтожились: налог и долг участнику по месяцу — ноль
    expect(await lineSum("expense.tax_accrued.RUB", period)).toBe(0n);
    expect(await lineSum(`liability.stakeholder.${alice}.RUB`, period)).toBe(0n);
    const row = await prisma.ledgerPeriod.findUniqueOrThrow({ where: { period } });
    expect(row).toMatchObject({ status: "review", reopenedCount: 1, closedAt: null, snapshot: null });
    expect(resets).toContain(period);
    expect(audit.filter((entry) => entry.target === period && entry.action === "ledger.period.reopen")).toHaveLength(1);

    // месяц снова принимает проводки — и закрывается заново под новым номером раза
    await sale(period, `${period}:s2`, 2_000n, "21");
    await periods.close(owner, period, NOW);

    expect(await entryKeys(`close:${period}:`)).toEqual([`close:${period}:r0:payout:${alice}`, `close:${period}:r0:tax`, `close:${period}:r1:payout:${alice}`, `close:${period}:r1:tax`]);
    const again = await prisma.ledgerPeriod.findUniqueOrThrow({ where: { period } });
    expect(again).toMatchObject({ status: "closed", reopenedCount: 1 });
    expect(again.snapshot).toMatchObject({ round: 1 });
  });

  it("снять закрытие нельзя, если по месяцу уже платили: 409, проводки закрытия на месте", async () => {
    const period = await freshPeriod();
    await sale(period, `${period}:s1`, 10_000n);
    await periods.startReview(owner, period, NOW);
    await periods.close(owner, period, NOW);
    hooks.payouts = true;
    try {
      expect((await domainError(periods.reopen(owner, period, "ошибка в расходах", NOW))).code).toBe("ledger_period_has_payouts");
    } finally {
      hooks.payouts = false;
    }
    expect((await prisma.ledgerPeriod.findUniqueOrThrow({ where: { period } })).status).toBe("closed");
    expect(await entryKeys(`reopen:${period}:`)).toEqual([]);
  });

  it("блокеры: черновик и операция на подтверждении по дате или «за какой месяц», оплата без проводки — закрыть нельзя", async () => {
    const period = await freshPeriod();
    const next = periodRange(period).to.toISOString().slice(0, 7);
    const mine = (kind: string, status: "draft" | "pending", input: Record<string, string>) => {
      const operationId = randomUUID();
      createdOperations.push(operationId);
      return prisma.ledgerOperation.create({ data: { operationId, kind: kind as "expense", status, input: { kind, ...input }, note: "операция теста", createdBy: owner.accountId } }).then(() => operationId);
    };
    const draft = await mine("expense", "draft", { at: `${period}-10`, from: ACCOUNT.bank, article: "vps", amount: "1" });
    // поступление датой следующего месяца, но «за» наш — месяц решает «за какой»
    const pending = await mine("income", "pending", { at: `${next}-02`, to: ACCOUNT.bank, article: "ads_adsgram", amount: "1", forMonth: period });
    // и обратный случай: дата в нашем месяце, а «за» — другой: нашему месяцу не мешает
    await mine("income", "draft", { at: `${period}-15`, to: ACCOUNT.bank, article: "ads_adsgram", amount: "1", forMonth: "1901-01" });
    const buyer = await person("Покупатель");
    const purchaseId = randomUUID();
    createdPurchases.push(purchaseId);
    const paidAt = at(period, "11");
    await prisma.purchase.create({ data: { purchaseId, accountId: buyer, product: "shop_item", sku: "gems_small", priceStars: 50, chargedStars: 50, mode: "live", status: "paid", invoicedAt: paidAt, paidAt } });
    // тестовая оплата и оплата другого месяца в блокеры не идут
    const testId = randomUUID();
    createdPurchases.push(testId);
    await prisma.purchase.create({ data: { purchaseId: testId, accountId: buyer, product: "shop_item", sku: "gems_small", priceStars: 50, chargedStars: 1, mode: "test", status: "paid", invoicedAt: paidAt, paidAt } });
    await periods.startReview(owner, period, NOW);

    const report = await periods.report(period, NOW);
    const byCode = new Map(report.checklist.map((item) => [item.code, item]));
    expect(byCode.get("operations_draft")?.refs).toEqual([{ kind: "operation", id: draft }]);
    expect(byCode.get("operations_pending")?.refs).toEqual([{ kind: "operation", id: pending }]);
    expect(byCode.get("payments_unposted")?.refs).toEqual([{ kind: "purchase", id: purchaseId }]);
    expect(report.canClose).toBe(false);
    const refused = await domainError(periods.close(owner, period, NOW));
    expect(refused.code).toBe("ledger_period_blocked");
    expect(await entryKeys(`close:${period}:`)).toEqual([]);

    // сверка платежей догнала: проводка оплаты появилась — блокер ушёл
    await ledger.post({
      sourceKey: `purchase:${purchaseId}:paid`,
      at: paidAt,
      memo: "Оплата набора",
      lines: [
        { accountId: ACCOUNT.stars, amount: 50n },
        { accountId: ACCOUNT.revenue, amount: -50n },
      ],
    });
    expect((await periods.report(period, NOW)).checklist.some((item) => item.code === "payments_unposted")).toBe(false);
  });

  it("предупреждения: рублёвое поступление без чека — не блокер, закрытие проходит и помнит предупреждение в снимке", async () => {
    const period = await freshPeriod();
    await income(period, `${period}:no-receipt`, 100_000n, null);
    await income(period, `${period}:with-receipt`, 100_000n, "individual", "13");
    await periods.startReview(owner, period, NOW);

    const report = await periods.report(period, NOW);
    expect(report.checklist.map((item) => [item.code, item.severity, item.count])).toEqual([["receipts_missing", "warning", 1]]);
    expect(report.canClose).toBe(true);

    await periods.close(owner, period, NOW);

    const row = await prisma.ledgerPeriod.findUniqueOrThrow({ where: { period } });
    expect((row.snapshot as { warnings: { code: string }[] }).warnings.map((warning) => warning.code)).toEqual(["receipts_missing"]);
    // налог — только с чека: 1 000 ₽ × 4 % = 40 ₽
    expect(await lineSum("expense.tax_accrued.RUB", period)).toBe(4_000n);
  });

  it("закрыть можно только месяц на сверке, а на сверку — только кончившийся месяц", async () => {
    const period = await freshPeriod();

    expect((await domainError(periods.close(owner, period, NOW))).code).toBe("ledger_period_status");
    expect((await domainError(periods.startReview(owner, "2026-12", NOW))).code).toBe("ledger_period_not_ended");
    await periods.startReview(owner, period, NOW);
    // повтор безопасен
    await periods.startReview(owner, period, NOW);
    expect(audit.filter((entry) => entry.target === period && entry.action === "ledger.period.review")).toHaveLength(1);
    await periods.close(owner, period, NOW);
    expect((await domainError(periods.startReview(owner, period, NOW))).code).toBe("ledger_period_status");
  });

  it("два одновременных снятия закрытия — одно: месяц не остаётся в промежуточном виде", async () => {
    const period = await freshPeriod();
    await sale(period, `${period}:s1`, 10_000n);
    await periods.startReview(owner, period, NOW);
    await periods.close(owner, period, NOW);

    const results = await Promise.allSettled([periods.reopen(owner, period, "ошибка в расходах", NOW), periods.reopen(owner, period, "ошибка в расходах", NOW)]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const row = await prisma.ledgerPeriod.findUniqueOrThrow({ where: { period } });
    expect(row).toMatchObject({ status: "review", reopenedCount: 1 });
  });
});
