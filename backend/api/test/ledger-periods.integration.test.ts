import { randomUUID } from "node:crypto";
import { Decimal, type CurrencyCode } from "@bh/fx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import type { Prisma, PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import type { FxService } from "../src/modules/fx/fx.service.js";
import { PrismaLedgerRepository, type InsertResult, type NewLedgerEntry, type StoredLedgerLine } from "../src/modules/ledger/ledger.repository.js";
import { LedgerService } from "../src/modules/ledger/ledger.service.js";
import { periodRange } from "../src/modules/ledger/periods/period-rules.js";
import { parseSnapshot } from "../src/modules/ledger/periods/period-snapshot.js";
import type { CloseOutcome, ClosePlan, SourceShare } from "../src/modules/ledger/periods/period-types.js";
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
 * Доли участников в основных сценариях подменены (`TestRepository.sharesByPeriod`): таблицу `stakeholder_share` другие
 * файлы чистят целиком, и настоящая строка пропадала бы посреди теста; чтение долей из базы проверяет отдельный короткий тест.
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Всё как у настоящего репозитория, кроме долей: их тест задаёт сам. */
class TestRepository extends PrismaPeriodsRepository {
  readonly sharesByPeriod = new Map<string, SourceShare[]>();
  /** Зовётся, когда расчёт закрытия окончен и остаётся транзакция: первым в ней идёт блокировка строки месяца. */
  onCommitClose: (() => void) | null = null;

  protected override async shares(period: string): Promise<SourceShare[]> {
    return this.sharesByPeriod.get(period) ?? [];
  }

  override async commitClose(plan: ClosePlan): Promise<CloseOutcome> {
    this.onCommitClose?.();
    return await super.commitClose(plan);
  }
}

/**
 * Журнал, у которого вставка проводки стоит у ворот: к воротам проводка приходит уже проверенной и с прочитанным
 * ключом, а войти в базу может только когда тест откроет ворота. Так воспроизводится окно между проверкой и вставкой.
 */
class GatedJournal extends PrismaLedgerRepository {
  private open: () => void = () => undefined;
  private readonly gate = new Promise<void>((resolve) => (this.open = resolve));
  private arrive: () => void = () => undefined;
  readonly arrived = new Promise<void>((resolve) => (this.arrive = resolve));

  release(): void {
    this.open();
  }

  override async insertEntry(entry: NewLedgerEntry, lines: readonly StoredLedgerLine[]): Promise<InsertResult> {
    this.arrive();
    await this.gate;
    return await super.insertEntry(entry, lines);
  }
}

describe.skipIf(DATABASE_URL === "")("месяцы учёта на живом Postgres", () => {
  let prisma: PrismaClient;
  let ledger: LedgerService;
  let periods: PeriodsService;
  let repository: TestRepository;
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

  /** Аккаунт для строк, у которых есть внешний ключ на аккаунт (покупка, доля). */
  async function person(name: string): Promise<string> {
    const account = await people.upsert({ platform: "telegram", platformUserId: String(940_000_000 + Math.floor(Math.random() * 50_000_000)), displayName: name, username: null, photoUrl: null }, NOW.getTime());
    createdAccounts.push(account.accountId);
    return account.accountId;
  }

  /** Участник месяца: доля подменена в тестовом репозитории, настоящая строка не нужна. */
  function stakeholder(period: string, name: string, bp: number): string {
    const accountId = randomUUID();
    repository.sharesByPeriod.set(period, [...(repository.sharesByPeriod.get(period) ?? []), { accountId, name, bp }]);
    return accountId;
  }

  async function entryKeys(prefix: string): Promise<string[]> {
    const rows = await prisma.ledgerEntry.findMany({ where: { sourceKey: { startsWith: prefix } }, select: { sourceKey: true } });
    // порядок по кодам знаков, а не по правилам сортировки базы: у каждой локали он свой
    return rows.map((row) => row.sourceKey).sort();
  }

  const lineSum = async (accountId: string, period: string) => (await prisma.ledgerLine.aggregate({ where: { accountId, entry: { period } }, _sum: { amount: true } }))._sum.amount ?? 0n;

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 12);
    ledger = new LedgerService(new PrismaLedgerRepository(prisma));
    people = new PrismaAccountRepository(prisma);
    const fx = {
      ratesAt: async (queries: readonly { currency: CurrencyCode; at: Date }[]) =>
        queries.map((query) => (RATES[query.currency] === undefined ? null : { usdPerUnit: new Decimal(RATES[query.currency] ?? "0"), at: new Date(0), stale: false, source: "market" as const })),
    } as unknown as FxService;
    const settings: SettingsReader = { get: (setting) => setting.fallback, onChange: () => undefined };
    const roles = { audit: async (entry: AuditEntry) => void audit.push(entry) } as unknown as RolesService;
    repository = new TestRepository(prisma);
    periods = new PeriodsService(
      repository,
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
    const alice = stakeholder(period, "Алиса", 2_500);
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

  /**
   * «Чужая» транзакция, которая берёт строку месяца и держит её, пока тест не отпустит: так воспроизводится закрытие
   * или проводка, застрявшие посреди своей транзакции. `finish` идёт под блокировкой перед коммитом.
   */
  function holdPeriodRow(period: string, mode: "update" | "share", finish: (tx: Prisma.TransactionClient) => Promise<void>) {
    let signalReady: () => void = () => undefined;
    let letGo: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => (signalReady = resolve));
    const go = new Promise<void>((resolve) => (letGo = resolve));
    const done = prisma.$transaction(
      async (tx) => {
        if (mode === "update") await tx.$queryRaw`SELECT period FROM ledger_period WHERE period = ${period} FOR UPDATE`;
        else await tx.$queryRaw`SELECT period FROM ledger_period WHERE period = ${period} FOR SHARE`;
        signalReady();
        await go;
        await finish(tx);
      },
      { maxWait: 5_000, timeout: 20_000 },
    );
    return {
      /** Блокировка взята (или транзакция упала раньше — тогда тест увидит её ошибку). */
      held: Promise.race([ready, done]),
      release: async () => {
        letGo();
        await done;
      },
    };
  }

  /** Исход вызова без ожидания: тест смотрит, застрял ли вызов на блокировке. */
  function observe<T>(promise: Promise<T>) {
    const state = { settled: false };
    const outcome = promise.then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );
    void outcome.then(() => void (state.settled = true));
    return { state, outcome };
  }

  it("вставка, пришедшая после коммита закрытия, отклоняется самой вставкой: проводки в закрытом месяце вне снимка не остаётся", async () => {
    const period = await freshPeriod();
    await sale(period, `${period}:s1`, 1_000n);
    await periods.startReview(owner, period, NOW);
    await periods.close(owner, period, NOW);

    const key = `it:${run}:${period}:after-commit`;
    const outcome = await new PrismaLedgerRepository(prisma).insertEntry(
      { entryId: randomUUID(), sourceKey: key, at: at(period, "25"), period, memo: "Запоздавшая оплата", reversalOfId: null, meta: null, createdBy: null },
      [
        { accountId: ACCOUNT.stars, amount: 500n },
        { accountId: ACCOUNT.revenue, amount: -500n },
      ],
    );

    expect(outcome).toBe("period_closed");
    expect(await entryKeys(key)).toEqual([]);
  });

  it("проводка проверена, месяц закрылся до её вставки: 409 `ledger_period_closed`, а не проводка в закрытом месяце мимо снимка", async () => {
    const period = await freshPeriod();
    await sale(period, `${period}:s1`, 1_000n);
    await periods.startReview(owner, period, NOW);
    const gated = new GatedJournal(prisma);
    const late = observe(
      new LedgerService(gated).post({
        sourceKey: `it:${run}:${period}:between`,
        at: at(period, "26"),
        memo: "Запоздавшая оплата",
        lines: [
          { accountId: ACCOUNT.stars, amount: 700n },
          { accountId: ACCOUNT.revenue, amount: -700n },
        ],
      }),
    );
    await gated.arrived;

    // проводка стоит у самой вставки, а месяц закрывается: в снимок она не попадает, потому что её ещё нет
    await periods.close(owner, period, NOW);
    gated.release();
    const { error } = await late.outcome;

    expect(error instanceof DomainError ? [error.code, error.status] : error).toEqual(["ledger_period_closed", 409]);
    expect(await entryKeys(`it:${run}:${period}:between`)).toEqual([]);
    expect(await lineSum(ACCOUNT.revenue, period)).toBe(-1_000n);
  });

  it("проводка, пришедшая во время закрытия, ждёт его коммита и читает `closed`: 409, в закрытый месяц не ложится", async () => {
    const period = await freshPeriod();
    await sale(period, `${period}:s1`, 1_000n);
    await periods.startReview(owner, period, NOW);
    // закрытие в пути: строка месяца под `FOR UPDATE`, статус меняется перед коммитом
    const closing = holdPeriodRow(period, "update", async (tx) => {
      // снимок нужен проверке таблицы: закрытый месяц без него она не пропустит; его содержимое тесту не важно
      await tx.ledgerPeriod.update({ where: { period }, data: { status: "closed", closedAt: NOW, closedBy: owner.accountId, snapshot: {} } });
    });
    await closing.held;

    const late = observe(sale(period, `${period}:during-close`, 500n, "20"));
    await sleep(400);
    expect(late.state.settled).toBe(false);

    await closing.release();
    const { error } = await late.outcome;

    expect(error instanceof DomainError ? [error.code, error.status] : error).toEqual(["ledger_period_closed", 409]);
    expect(await entryKeys(`it:${run}:${period}:during-close`)).toEqual([]);
  });

  it("закрытие ждёт проводку, взявшую замок раньше, и видит её в отпечатке: 409 `ledger_period_changed`, месяц остаётся на сверке", async () => {
    const period = await freshPeriod();
    await sale(period, `${period}:s1`, 1_000n);
    await periods.startReview(owner, period, NOW);
    // проводка в пути: замок месяца взят, сама проводка записана, но не закоммичена
    const key = `it:${run}:${period}:in-flight`;
    const inFlight = holdPeriodRow(period, "share", async (tx) => {
      await tx.ledgerEntry.create({
        data: {
          entryId: randomUUID(),
          sourceKey: key,
          at: at(period, "27"),
          period,
          memo: "Проводка в пути",
          lines: {
            create: [
              { lineId: randomUUID(), accountId: ACCOUNT.stars, amount: 800n },
              { lineId: randomUUID(), accountId: ACCOUNT.revenue, amount: -800n },
            ],
          },
        },
      });
    });
    await inFlight.held;
    const reachedCommit = new Promise<void>((resolve) => (repository.onCommitClose = resolve));
    const closing = observe(periods.close(owner, period, NOW));
    await reachedCommit;
    repository.onCommitClose = null;

    // расчёт закрытия окончен, до отпечатка остаётся блокировка строки: она ждёт проводку, а не обходит её
    await sleep(400);
    expect(closing.state.settled).toBe(false);
    await inFlight.release();
    const { error } = await closing.outcome;

    expect(error instanceof DomainError ? error.code : error).toBe("ledger_period_changed");
    expect((await prisma.ledgerPeriod.findUniqueOrThrow({ where: { period } })).status).toBe("review");
    expect(await entryKeys(`close:${period}:`)).toEqual([]);
    expect(await entryKeys(key)).toHaveLength(1);
  });

  it("проводки и закрытие одновременно, в разные моменты: месяц либо закрыт со всеми проводками в снимке, либо не закрыт; в закрытый месяц мимо снимка ничего не ложится", async () => {
    // Закрытие идёт сотни миллисекунд; проводки стартуют через разные промежутки и попадают в разные его участки.
    for (const delay of [0, 10, 25, 40, 60, 90, 130, 180]) {
      const period = await freshPeriod();
      await sale(period, `${period}:s1`, 10_000n);
      await periods.startReview(owner, period, NOW);

      const closing = periods.close(owner, period, NOW);
      const posts = [0, 5].map((extra, index) => sleep(delay + extra).then(() => sale(period, `${period}:race${String(index)}`, BigInt(100 + index), "22")));
      const results = await Promise.allSettled([closing, ...posts]);

      const row = await prisma.ledgerPeriod.findUniqueOrThrow({ where: { period } });
      const stored = await entryKeys(`it:${run}:${period}:race`);
      // каждая проводка либо записана, либо отклонена замком; ничего третьего
      results.slice(1).forEach((result, index) => {
        const key = `it:${run}:${period}:race${String(index)}`;
        if (result.status === "fulfilled") expect(stored).toContain(key);
        else {
          expect(result.reason instanceof DomainError ? result.reason.code : String(result.reason)).toBe("ledger_period_closed");
          expect(stored).not.toContain(key);
        }
      });
      if (row.status === "closed") {
        // всё, что лежит в закрытом месяце, учтено снимком: сумма выручки в снимке равна сумме строк журнала
        const snapshot = parseSnapshot(row.snapshot);
        const inSnapshot = snapshot.buckets.filter((bucket) => bucket.accountId === ACCOUNT.revenue).reduce((sum, bucket) => sum + BigInt(bucket.minor), 0n);
        expect(inSnapshot).toBe(-(await lineSum(ACCOUNT.revenue, period)));
      } else {
        // закрытие проиграло проводке: она попала в отпечаток, и закрывать по старым цифрам нельзя
        const failed = results[0];
        expect(failed?.status === "rejected" && failed.reason instanceof DomainError ? failed.reason.code : failed).toBe("ledger_period_changed");
        expect(await entryKeys(`close:${period}:`)).toEqual([]);
      }
    }
  });

  it("два одновременных закрытия — одно: второе получает 409, проводок закрытия ровно столько, сколько у одного", async () => {
    const period = await freshPeriod();
    const alice = stakeholder(period, "Алиса", 1_000);
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
    const alice = stakeholder(period, "Алиса", 2_500);
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

  it("доли читаются из stakeholder_share: последняя запись истории не позже месяца, ноль — конец участия", async () => {
    const period = await freshPeriod();
    const reader = new PrismaPeriodsRepository(prisma);
    const anna = await person("Анна");
    const boris = await person("Борис");
    const at = (month: string) => new Date(`${month}-01T00:00:00.000Z`);
    // у Анны две записи — до месяца и в нём; у Бориса запись «0 %» до месяца: участие кончилось
    await prisma.stakeholderShare.createMany({
      data: [
        { shareId: randomUUID(), accountId: anna, fromMonth: at("1900-01"), shareBp: 1_000, note: "доля теста", setBy: anna },
        { shareId: randomUUID(), accountId: anna, fromMonth: at(period), shareBp: 3_000, note: "доля теста", setBy: anna },
        { shareId: randomUUID(), accountId: boris, fromMonth: at("1900-01"), shareBp: 2_000, note: "доля теста", setBy: boris },
        { shareId: randomUUID(), accountId: boris, fromMonth: at("1900-02"), shareBp: 0, note: "доля теста", setBy: boris },
      ],
    });
    try {
      const shares = (await reader.loadMonth(period)).shares.filter((share) => share.accountId === anna || share.accountId === boris);
      expect(shares).toEqual([{ accountId: anna, name: "Анна", bp: 3_000 }]);
    } finally {
      await prisma.stakeholderShare.deleteMany({ where: { accountId: { in: [anna, boris] } } });
    }
  });
});
