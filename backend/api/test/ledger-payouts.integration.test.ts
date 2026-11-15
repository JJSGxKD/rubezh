import { randomUUID } from "node:crypto";
import { Decimal, type CurrencyCode } from "@bh/fx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError, ForbiddenError } from "../src/common/domain-error.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import type { FxService } from "../src/modules/fx/fx.service.js";
import { PrismaLedgerChartRepository } from "../src/modules/ledger/ledger-chart.repository.js";
import { LedgerChartService } from "../src/modules/ledger/ledger-chart.service.js";
import { PrismaLedgerRepository } from "../src/modules/ledger/ledger.repository.js";
import { LedgerService } from "../src/modules/ledger/ledger.service.js";
import { needsApproval, type OperationApprovals } from "../src/modules/ledger/operations/approval.js";
import type { OperationInput, OperationKind } from "../src/modules/ledger/operations/operation-input.js";
import type { OperationView } from "../src/modules/ledger/operations/operation-view.js";
import { PrismaOperationsRepository } from "../src/modules/ledger/operations/operations.repository.js";
import { OperationsService } from "../src/modules/ledger/operations/operations.service.js";
import { PayoutLock } from "../src/modules/ledger/payouts/payout-lock.js";
import { PayoutNotices } from "../src/modules/ledger/payouts/payout-notices.js";
import { PayoutPeriodHooks } from "../src/modules/ledger/payouts/payout-hooks.js";
import { PayoutSupportService } from "../src/modules/ledger/payouts/payout-support.js";
import { PrismaPayoutsRepository } from "../src/modules/ledger/payouts/payouts.repository.js";
import { PayoutsService } from "../src/modules/ledger/payouts/payouts.service.js";
import type { SourceShare } from "../src/modules/ledger/periods/period-types.js";
import { PrismaPeriodsRepository } from "../src/modules/ledger/periods/periods.repository.js";
import { PeriodsService } from "../src/modules/ledger/periods/periods.service.js";
import type { MediaService } from "../src/modules/media/media.service.js";
import { NotificationsService } from "../src/modules/notifications/notifications.service.js";
import { PrismaNotificationsRepository } from "../src/modules/notifications/notifications.repository.js";
import type { Permission } from "../src/modules/roles/permissions.js";
import type { AuditEntry } from "../src/modules/roles/roles.repository.js";
import type { AccountRef, RolesService } from "../src/modules/roles/roles.service.js";
import { uniquePlatformUserId } from "./helpers/player-ids.js";
import { panelSettings } from "./helpers/settings.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Подтверждение отчёта, выплаты и сообщения на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск; Р222, tasks/T-0469): выплата участнику проводится только после подтверждения,
 * после первой выплаты закрытие не снять, снятие до выплат сбрасывает подтверждения, повтор и гонка не задваивают
 * деньги, а сообщения уходят один раз.
 *
 * Журнал не стирается, поэтому каждый тест берёт свой месяц в прошлом веке (`19ГГ-ММ`): другие файлы пишут в 2026 и
 * позже. Закрытие идёт по настоящим часам (`closeAt`): «сейчас» выплат читается из часов, и месяц, закрытый в
 * будущем, подтверждения участника не принял бы. Проводки выплат ложатся в текущий месяц по часам — он открыт.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const DAY_MS = 86_400_000;
const RATES: Record<string, string> = { USD: "1", XTR: "0.013", RUB: "0.0125" };

/** Выручка 10 000 ⭐ × 0,013 = 130 $; доля 25 % = 32,50 $ = 2 600 ₽ по курсу 0,0125; на владельца 97,50 $. */
const SALE_STARS = 10_000n;

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

/** Исход вызова без ожидания: тест смотрит, застрял ли вызов на замке. */
function observe<T>(promise: Promise<T>) {
  const state = { settled: false };
  const outcome = promise.then(
    (value) => ({ value, error: null as unknown }),
    (error: unknown) => ({ value: null, error }),
  );
  void outcome.then(() => void (state.settled = true));
  return { state, outcome };
}

class TestPeriods extends PrismaPeriodsRepository {
  readonly sharesByPeriod = new Map<string, SourceShare[]>();

  protected override async shares(period: string): Promise<SourceShare[]> {
    return this.sharesByPeriod.get(period) ?? [];
  }
}

describe.skipIf(DATABASE_URL === "")("выплаты участникам на живом Postgres", () => {
  let prisma: PrismaClient;
  let ledger: LedgerService;
  let chart: LedgerChartService;
  let operations: OperationsService;
  let periods: PeriodsService;
  let payouts: PayoutsService;
  let payoutsRepository: PrismaPayoutsRepository;
  let periodsRepository: TestPeriods;
  let lock: PayoutLock;
  let hooks: PayoutPeriodHooks;
  let people: PrismaAccountRepository;
  let notifications: NotificationsService;
  const run = randomUUID().slice(0, 8);
  const audit: AuditEntry[] = [];
  const owner: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: "9201" };
  const finance: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: "9202" };
  const usedPeriods: string[] = [];
  const createdAccounts: string[] = [];
  const createdOperations: string[] = [];
  const granted = new Map<string, readonly Permission[]>();
  /** «Сегодня» по настоящим часам: дата события выплаты не может быть в будущем. */
  const today = new Date().toISOString().slice(0, 10);

  let bank = "";
  const ACCOUNT = { stars: `stars.pay${run}`, revenue: `revenue.pay${run}` };

  async function freshPeriod(): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const year = 1910 + Math.floor(Math.random() * 89);
      const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, "0");
      const period = `${String(year)}-${month}`;
      if (usedPeriods.includes(period)) continue;
      const busy = (await prisma.ledgerPeriod.count({ where: { period } })) + (await prisma.ledgerEntry.count({ where: { period } })) + (await prisma.ledgerConfirmation.count({ where: { period } }));
      if (busy === 0) {
        usedPeriods.push(period);
        return period;
      }
    }
    throw new Error("не нашёлся свободный месяц для теста");
  }

  async function person(name: string): Promise<AccountRef> {
    const account = await people.upsert({ platform: "telegram", platformUserId: uniquePlatformUserId(), displayName: name, username: null, photoUrl: null }, Date.now());
    createdAccounts.push(account.accountId);
    granted.set(account.accountId, ["revenue.split.own.view"]);
    return { accountId: account.accountId, platform: "telegram", platformUserId: account.platformUserId };
  }

  /**
   * Закрытый месяц: оплата на 10 000 ⭐, доля участника 25 %. `closedDaysAgo` — сколько суток назад «закрыли»:
   * срок подтверждения (5 суток) читается от времени закрытия.
   */
  async function closedMonth(options: { closedDaysAgo?: number } = {}): Promise<{ period: string; alice: AccountRef; closeAt: Date }> {
    const period = await freshPeriod();
    const alice = await person("Алиса");
    periodsRepository.sharesByPeriod.set(period, [{ accountId: alice.accountId, name: "Алиса", bp: 2_500 }]);
    await ledger.post({
      sourceKey: `it:${run}:${period}:sale`,
      at: new Date(`${period}-10T12:00:00.000Z`),
      memo: "Оплата набора",
      lines: [
        { accountId: ACCOUNT.stars, amount: SALE_STARS },
        { accountId: ACCOUNT.revenue, amount: -SALE_STARS },
      ],
    });
    const closeAt = new Date(Date.now() - (options.closedDaysAgo ?? 0) * DAY_MS);
    await periods.startReview(owner, period, closeAt);
    await periods.close(owner, period, closeAt);
    return { period, alice, closeAt };
  }

  const payoutInput = (period: string, payee: string, amount: string, extra: Record<string, unknown> = {}): OperationInput =>
    ({ kind: "payout", note: `Выплата за месяц ${run}`, at: today, payee, period, from: bank, amount, ...extra }) as OperationInput;

  async function draft(actor: AccountRef, input: OperationInput): Promise<OperationView> {
    const view = await operations.create(actor, input);
    createdOperations.push(view.operationId);
    return view;
  }

  /** Подтвердить и выплатить участнику сразу всё или `amount`. */
  async function pay(period: string, alice: AccountRef, amount = "2600.00", extra: Record<string, unknown> = {}): Promise<OperationView> {
    const view = await draft(owner, payoutInput(period, `stakeholder:${alice.accountId}`, amount, extra));
    return await operations.submit(owner, view.operationId);
  }

  const entriesWithKey = async (sourceKey: string) => await prisma.ledgerEntry.count({ where: { sourceKey } });
  const debtSum = async (accountId: string) => (await prisma.ledgerLine.aggregate({ where: { accountId: `liability.stakeholder.${accountId}.RUB` }, _sum: { amount: true } }))._sum.amount ?? 0n;
  const messagesOf = async (accountId: string, kind: string) => await prisma.notification.findMany({ where: { accountId, kind }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 16);
    ledger = new LedgerService(new PrismaLedgerRepository(prisma));
    people = new PrismaAccountRepository(prisma);
    const roles = {
      audit: async (entry: AuditEntry) => void audit.push(entry),
      rolesFor: async (actor: AccountRef) => (actor.accountId === owner.accountId ? ["owner"] : ["finance"]),
      permissions: async (actor: AccountRef) => new Set(granted.get(actor.accountId) ?? []),
    } as unknown as RolesService;
    chart = new LedgerChartService(new PrismaLedgerChartRepository(prisma), ledger, roles);
    const rate = (code: CurrencyCode) => ({ currency: code, usdPerUnit: new Decimal(RATES[code] ?? "0"), sources: ["test"], observedAt: new Date() });
    const fx = {
      ratesAt: async (queries: readonly { currency: CurrencyCode; at: Date }[]) =>
        queries.map((query) => (RATES[query.currency] === undefined ? null : { usdPerUnit: new Decimal(RATES[query.currency] ?? "0"), at: new Date(0), stale: false, source: "market" as const })),
      peek: async () => ({ takenAt: new Date(), rates: new Map([["RUB" as CurrencyCode, rate("RUB")]]), payout: new Map([["XTR" as CurrencyCode, rate("XTR")]]) }),
    } as unknown as FxService;
    // Второй ключ — как у настоящего: финансы ждут владельца, владелец проводит сразу; выплата — всегда (T-0469).
    const approvals = {
      required: async (actor: AccountRef, kind: OperationKind, amountUsd: string | null) => needsApproval({ kind, amountUsd, actorCanApprove: actor.accountId === owner.accountId, thresholdUsd: 200 }),
      requireApprover: async (actor: AccountRef) => {
        if (actor.accountId !== owner.accountId) throw new ForbiddenError("Подтверждать и отклонять операции учёта может только владелец");
      },
      announcePending: () => undefined,
      announceDecision: () => undefined,
    } as unknown as OperationApprovals;

    payoutsRepository = new PrismaPayoutsRepository(prisma);
    notifications = new NotificationsService(new PrismaNotificationsRepository(prisma));
    lock = new PayoutLock(prisma);
    const settings = panelSettings();
    const notices = new PayoutNotices(notifications, payoutsRepository, { send: async () => undefined });
    hooks = new PayoutPeriodHooks(payoutsRepository, notices, lock);
    periodsRepository = new TestPeriods(prisma);
    periods = new PeriodsService(periodsRepository, fx, settings, roles, hooks);
    payouts = new PayoutsService(payoutsRepository, roles, settings, notices, lock);
    operations = new OperationsService(
      new PrismaOperationsRepository(prisma),
      ledger,
      chart,
      fx,
      roles,
      approvals,
      { require: async () => undefined } as unknown as MediaService,
      new PayoutSupportService(payoutsRepository, settings, lock, notices),
    );

    await prisma.ledgerAccount.createMany({
      data: [
        { accountId: ACCOUNT.stars, type: "asset", currency: "XTR", name: `Звёзды теста ${run}` },
        { accountId: ACCOUNT.revenue, type: "revenue", currency: "XTR", name: `Выручка теста ${run}` },
      ],
      skipDuplicates: true,
    });
    bank = (await chart.createPlace(owner, { name: `Банк выплат ${run}`, currency: "RUB" })).placeId;
  });

  afterAll(async () => {
    await prisma.ledgerOperation.deleteMany({ where: { operationId: { in: createdOperations } } });
    await prisma.ledgerConfirmation.deleteMany({ where: { period: { in: usedPeriods } } });
    await prisma.notification.deleteMany({ where: { accountId: { in: createdAccounts } } });
    await prisma.ledgerPeriod.deleteMany({ where: { period: { in: usedPeriods } } });
    await prisma.$disconnect();
  });

  it("закрытие месяца: участнику с долгом — одно сообщение «отчёт готов» с суммой; повторный вызов хука его не удваивает", async () => {
    const { period, alice } = await closedMonth();

    const first = await messagesOf(alice.accountId, "finance_report");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ dedupeKey: `finance:report:${period}:${alice.accountId}:0`, payload: { period, state: "ready", amountRub: "2600.00", reason: null } });

    await hooks.closed?.(period, 0);

    expect(await messagesOf(alice.accountId, "finance_report")).toHaveLength(1);
  });

  it("выплата участнику: без подтверждения отказ, после подтверждения — проводка `op:<id>`, колонки операции, сообщение «выплачено» один раз", async () => {
    const { period, alice } = await closedMonth();
    const refused = await domainError(draft(owner, payoutInput(period, `stakeholder:${alice.accountId}`, "2600.00")));
    expect([refused.code, refused.status]).toEqual(["ledger_operation_invalid", 400]);
    expect(refused.message).toContain("не подтвердил");

    await payouts.confirm(alice, period, { decision: "confirmed" });
    const posted = await pay(period, alice);

    expect(posted.status).toBe("posted");
    expect(posted.entry).toMatchObject({ sourceKey: `op:${posted.operationId}`, createdBy: owner.accountId });
    expect(posted.entry?.lines.map((line) => [line.accountId, line.amount]).sort()).toEqual([
      [bank, "-2600.00"],
      [`liability.stakeholder.${alice.accountId}.RUB`, "2600.00"],
    ]);
    // обязательство перед участником погашено, месяц ему больше ничего не должен
    expect(await debtSum(alice.accountId)).toBe(0n);
    const row = await prisma.ledgerOperation.findUniqueOrThrow({ where: { operationId: posted.operationId } });
    expect(row).toMatchObject({ kind: "payout", status: "posted", payee: `stakeholder:${alice.accountId}`, payoutPeriod: period, overrideReason: null });

    const paid = await messagesOf(alice.accountId, "finance_payout");
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ dedupeKey: `finance:payout:${posted.operationId}`, payload: { period, amountRub: "2600.00" } });
  });

  it("повторный submit и три параллельных — одна проводка, одна отметка, одно сообщение", async () => {
    const { period, alice } = await closedMonth();
    await payouts.confirm(alice, period, { decision: "confirmed" });
    const made = await draft(owner, payoutInput(period, `stakeholder:${alice.accountId}`, "2600.00"));

    const results = await Promise.allSettled([operations.submit(owner, made.operationId), operations.submit(owner, made.operationId), operations.submit(owner, made.operationId)]);
    const again = await operations.submit(owner, made.operationId);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(again.status).toBe("posted");
    expect(await entriesWithKey(`op:${made.operationId}`)).toBe(1);
    expect(await debtSum(alice.accountId)).toBe(0n);
    expect(await messagesOf(alice.accountId, "finance_payout")).toHaveLength(1);
  });

  it("сбой между проводкой и отметкой «проведена»: деньги уже записаны — их видят и остаток, и запрет снятия, и решение участника; повтор доводит операцию, а не упирается в остаток", async () => {
    const { period, alice } = await closedMonth();
    await payouts.confirm(alice, period, { decision: "confirmed" });
    const stuck = await draft(owner, payoutInput(period, `stakeholder:${alice.accountId}`, "1000.00"));
    // проводка записана, отметки нет: так выглядит сбой между ними
    await ledger.post({
      sourceKey: `op:${stuck.operationId}`,
      at: new Date(),
      memo: "Выплата за месяц",
      lines: [
        { accountId: bank, amount: -100_000n },
        { accountId: `liability.stakeholder.${alice.accountId}.RUB`, amount: 100_000n },
      ],
    });

    expect(await payoutsRepository.hasPayouts(period)).toBe(true);
    expect((await domainError(periods.reopen(owner, period, "Ошибка в курсе рубля"))).code).toBe("ledger_period_has_payouts");
    expect((await domainError(payouts.confirm(alice, period, { decision: "disputed", comment: "Передумал, не сходится" }))).code).toBe("ledger_confirmation_paid");
    // записанная тысяча уже считается выплаченной: остаток — 1 600 ₽, и платёж на 1 600,01 отказан
    expect((await domainError(draft(owner, payoutInput(period, `stakeholder:${alice.accountId}`, "1600.01")))).message).toContain("остатка долга");
    await pay(period, alice, "1600.00");

    const done = await operations.submit(owner, stuck.operationId);

    expect(done.status).toBe("posted");
    expect(await entriesWithKey(`op:${stuck.operationId}`)).toBe(1);
    expect(await debtSum(alice.accountId)).toBe(0n);
  });

  it("выплата больше остатка долга — отказ; частями — можно, пока не выйдет весь долг", async () => {
    const { period, alice } = await closedMonth();
    await payouts.confirm(alice, period, { decision: "confirmed" });

    const tooMuch = await domainError(draft(owner, payoutInput(period, `stakeholder:${alice.accountId}`, "2600.01")));
    expect(tooMuch.message).toContain("остатка долга");

    await pay(period, alice, "1000.00");
    await pay(period, alice, "1600.00");
    const extra = await domainError(draft(owner, payoutInput(period, `stakeholder:${alice.accountId}`, "0.01")));
    expect(extra.message).toContain("остатка долга");
    expect(await debtSum(alice.accountId)).toBe(0n);
  });

  it("два параллельных платежа на весь долг: проходит один, второй получает отказ, долг не уходит в минус", async () => {
    const { period, alice } = await closedMonth();
    await payouts.confirm(alice, period, { decision: "confirmed" });
    const first = await draft(owner, payoutInput(period, `stakeholder:${alice.accountId}`, "2600.00"));
    const second = await draft(owner, payoutInput(period, `stakeholder:${alice.accountId}`, "2600.00"));

    const results = await Promise.allSettled([operations.submit(owner, first.operationId), operations.submit(owner, second.operationId)]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason instanceof DomainError ? failed.reason.code : null).toBe("ledger_operation_invalid");
    expect(await debtSum(alice.accountId)).toBe(0n);
    expect((await entriesWithKey(`op:${first.operationId}`)) + (await entriesWithKey(`op:${second.operationId}`))).toBe(1);
  });

  it("выплата финансов ждёт владельца: проводки нет, пока он не подтвердит; подтверждение проводит и сообщает участнику", async () => {
    const { period, alice } = await closedMonth();
    await payouts.confirm(alice, period, { decision: "confirmed" });
    const made = await draft(finance, payoutInput(period, `stakeholder:${alice.accountId}`, "100.00"));

    const waiting = await operations.submit(finance, made.operationId);

    expect(waiting.status).toBe("pending");
    expect(await entriesWithKey(`op:${made.operationId}`)).toBe(0);
    expect(await messagesOf(alice.accountId, "finance_payout")).toHaveLength(0);

    const approved = await operations.approve(owner, made.operationId);
    expect(approved.status).toBe("posted");
    expect(await messagesOf(alice.accountId, "finance_payout")).toHaveLength(1);
  });

  it("молчит дольше срока — владелец платит с причиной, причина лежит в операции и в проводке; без причины — отказ", async () => {
    const { period, alice } = await closedMonth({ closedDaysAgo: 6 });
    const noReason = await domainError(draft(owner, payoutInput(period, `stakeholder:${alice.accountId}`, "2600.00")));
    expect(noReason.message).toContain("причин");

    const posted = await pay(period, alice, "2600.00", { overrideReason: "уехал, договорились устно" });

    const row = await prisma.ledgerOperation.findUniqueOrThrow({ where: { operationId: posted.operationId } });
    expect(row.overrideReason).toBe("уехал, договорились устно");
    expect(posted.entry?.meta).toMatchObject({ overrideReason: "уехал, договорились устно" });
  });

  it("молчит меньше срока — платить нельзя даже с причиной владельца", async () => {
    const { period, alice } = await closedMonth({ closedDaysAgo: 2 });
    const refused = await domainError(draft(owner, payoutInput(period, `stakeholder:${alice.accountId}`, "2600.00", { overrideReason: "очень нужно" })));
    expect(refused.message).toContain("не подтвердил");
  });

  it("оспорил — только с причиной владельца; спор попадает в аудит `ledger.period.dispute`", async () => {
    const { period, alice } = await closedMonth();
    await payouts.confirm(alice, period, { decision: "disputed", comment: "В расходах лишняя строка" });
    expect(audit.some((entry) => entry.action === "ledger.period.dispute" && entry.target === period && entry.actorAccountId === alice.accountId)).toBe(true);

    const refused = await domainError(draft(owner, payoutInput(period, `stakeholder:${alice.accountId}`, "2600.00")));
    expect(refused.message).toContain("оспорил");

    const posted = await pay(period, alice, "2600.00", { overrideReason: "разобрались, расход верный" });
    expect(posted.status).toBe("posted");
  });

  it("подтверждение, данное до закрытия (хвост сбоя после снятия), не считается: выплата требует нового", async () => {
    const period = await freshPeriod();
    const alice = await person("Алиса");
    periodsRepository.sharesByPeriod.set(period, [{ accountId: alice.accountId, name: "Алиса", bp: 2_500 }]);
    await ledger.post({
      sourceKey: `it:${run}:${period}:sale`,
      at: new Date(`${period}-10T12:00:00.000Z`),
      memo: "Оплата набора",
      lines: [
        { accountId: ACCOUNT.stars, amount: SALE_STARS },
        { accountId: ACCOUNT.revenue, amount: -SALE_STARS },
      ],
    });
    // подтверждение осталось в базе от прежнего закрытия: сброс после снятия не дошёл до базы
    await prisma.ledgerConfirmation.create({ data: { period, accountId: alice.accountId, status: "confirmed", comment: null, decidedAt: new Date(Date.now() - DAY_MS) } });
    await periods.startReview(owner, period, new Date());
    await periods.close(owner, period, new Date());

    const refused = await domainError(draft(owner, payoutInput(period, `stakeholder:${alice.accountId}`, "2600.00")));
    expect(refused.message).toContain("не подтвердил");

    await payouts.confirm(alice, period, { decision: "confirmed" });
    expect((await pay(period, alice)).status).toBe("posted");
  });

  it("после первой выплаты закрытие не снять — 409 `ledger_period_has_payouts`, месяц остаётся закрытым, подтверждение — на месте", async () => {
    const { period, alice } = await closedMonth();
    await payouts.confirm(alice, period, { decision: "confirmed" });
    await pay(period, alice, "100.00");

    const refused = await domainError(periods.reopen(owner, period, "Ошибка в курсе рубля"));

    expect([refused.code, refused.status]).toEqual(["ledger_period_has_payouts", 409]);
    expect((await prisma.ledgerPeriod.findUniqueOrThrow({ where: { period } })).status).toBe("closed");
    expect(await prisma.ledgerConfirmation.count({ where: { period } })).toBe(1);
    expect(await payoutsRepository.hasPayouts(period)).toBe(true);
  });

  it("выплата владельцу — тоже выплата: без подтверждений, на счёт «Выплаты владельцу», и после неё закрытие не снять", async () => {
    const { period } = await closedMonth();

    const posted = await operations.submit(owner, (await draft(owner, payoutInput(period, "owner", "500.00"))).operationId);

    expect(posted.entry?.lines.map((line) => [line.accountId, line.amount]).sort()).toEqual([
      [bank, "-500.00"],
      ["equity.owner_draw.RUB", "500.00"],
    ]);
    const refused = await domainError(periods.reopen(owner, period, "Ошибка в курсе рубля"));
    expect(refused.code).toBe("ledger_period_has_payouts");
  });

  it("после выплаты подтверждение не поменять — 409 `ledger_confirmation_paid`", async () => {
    const { period, alice } = await closedMonth();
    await payouts.confirm(alice, period, { decision: "confirmed" });
    await pay(period, alice, "100.00");

    const change = await domainError(payouts.confirm(alice, period, { decision: "disputed", comment: "Передумал, не сходится" }));
    const repeat = await domainError(payouts.confirm(alice, period, { decision: "confirmed" }));

    expect([change.code, change.status]).toEqual(["ledger_confirmation_paid", 409]);
    expect(repeat.code).toBe("ledger_confirmation_paid");
    expect((await prisma.ledgerConfirmation.findUniqueOrThrow({ where: { period_accountId: { period, accountId: alice.accountId } } })).status).toBe("confirmed");
  });

  it("снятие закрытия до выплат: подтверждения стёрты, участнику «отчёт отозван», месяц на сверке; повторное закрытие — новый раз и новое сообщение", async () => {
    const { period, alice } = await closedMonth();
    await payouts.confirm(alice, period, { decision: "confirmed" });
    expect(await prisma.ledgerConfirmation.count({ where: { period } })).toBe(1);

    await periods.reopen(owner, period, "Ошибка в курсе рубля");

    expect(await prisma.ledgerConfirmation.count({ where: { period } })).toBe(0);
    expect((await prisma.ledgerPeriod.findUniqueOrThrow({ where: { period } })).status).toBe("review");
    const recalled = (await messagesOf(alice.accountId, "finance_report")).filter((row) => (row.payload as { state?: string }).state === "recalled");
    expect(recalled).toHaveLength(1);
    expect(recalled[0]).toMatchObject({ dedupeKey: `finance:report:${period}:${alice.accountId}:0:recalled`, payload: { state: "recalled", reason: "Ошибка в курсе рубля" } });

    await periods.close(owner, period, new Date());
    const ready = (await messagesOf(alice.accountId, "finance_report")).filter((row) => (row.payload as { state?: string }).state === "ready");
    expect(ready.map((row) => row.dedupeKey)).toEqual([`finance:report:${period}:${alice.accountId}:0`, `finance:report:${period}:${alice.accountId}:1`]);
    // старого подтверждения нет: платить снова нельзя, пока участник не подтвердит заново
    expect((await domainError(draft(owner, payoutInput(period, `stakeholder:${alice.accountId}`, "100.00")))).message).toContain("не подтвердил");
  });

  it("месяц, снятый с закрытия, выплаты не принимает: платёж, ждавший владельца, при подтверждении получает отказ, а не проводку", async () => {
    const { period, alice } = await closedMonth();
    await payouts.confirm(alice, period, { decision: "confirmed" });
    const made = await draft(finance, payoutInput(period, `stakeholder:${alice.accountId}`, "100.00"));
    await operations.submit(finance, made.operationId);

    await periods.reopen(owner, period, "Ошибка в курсе рубля");
    const refused = await domainError(operations.approve(owner, made.operationId));

    expect(refused.code).toBe("ledger_operation_invalid");
    expect(refused.message).toContain("не закрыт");
    expect(await entriesWithKey(`op:${made.operationId}`)).toBe(0);
  });

  it("выплата и снятие закрытия берут один замок месяца: пока он занят, оба ждут, а после — проходит ровно одно", async () => {
    const { period, alice } = await closedMonth();
    await payouts.confirm(alice, period, { decision: "confirmed" });
    const made = await draft(owner, payoutInput(period, `stakeholder:${alice.accountId}`, "100.00"));

    let letGo: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (letGo = resolve));
    let signalHeld: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (signalHeld = resolve));
    const holding = lock.run(period, async () => {
      signalHeld();
      await gate;
    });
    await held;

    const payment = observe(operations.submit(owner, made.operationId));
    const reopening = observe(periods.reopen(owner, period, "Ошибка в курсе рубля"));
    await sleep(500);
    expect(payment.state.settled).toBe(false);
    expect(reopening.state.settled).toBe(false);

    letGo();
    await holding;
    const [paid, reopened] = await Promise.all([payment.outcome, reopening.outcome]);

    // ровно одно из двух; и состояние согласовано: выплата есть — месяц закрыт, нет — месяц снят и проводки нет
    const paidOk = paid.error === null;
    const reopenedOk = reopened.error === null;
    expect(paidOk !== reopenedOk).toBe(true);
    const status = (await prisma.ledgerPeriod.findUniqueOrThrow({ where: { period } })).status;
    if (paidOk) {
      expect(status).toBe("closed");
      expect(reopened.error instanceof DomainError ? reopened.error.code : null).toBe("ledger_period_has_payouts");
      expect(await entriesWithKey(`op:${made.operationId}`)).toBe(1);
    } else {
      expect(status).toBe("review");
      expect(paid.error instanceof DomainError ? paid.error.code : null).toBe("ledger_operation_invalid");
      expect(await entriesWithKey(`op:${made.operationId}`)).toBe(0);
    }
  });

  it("участник оспаривает, пока владелец платит: выигрывает один — либо выплата проведена (спор 409), либо спор записан (выплата отказана)", async () => {
    const { period, alice } = await closedMonth();
    await payouts.confirm(alice, period, { decision: "confirmed" });
    const made = await draft(owner, payoutInput(period, `stakeholder:${alice.accountId}`, "100.00"));

    const [payment, dispute] = await Promise.allSettled([operations.submit(owner, made.operationId), payouts.confirm(alice, period, { decision: "disputed", comment: "Не сходится курс" })]);

    const stored = await prisma.ledgerConfirmation.findUniqueOrThrow({ where: { period_accountId: { period, accountId: alice.accountId } } });
    if (payment.status === "fulfilled") {
      expect(dispute.status).toBe("rejected");
      expect(stored.status).toBe("confirmed");
      expect(await entriesWithKey(`op:${made.operationId}`)).toBe(1);
    } else {
      expect(dispute.status).toBe("fulfilled");
      expect(stored.status).toBe("disputed");
      expect(await entriesWithKey(`op:${made.operationId}`)).toBe(0);
    }
  });

  it("статус месяца: по участнику — долг, подтверждение, выплачено; после выплаты остаток уменьшается", async () => {
    const { period, alice, closeAt } = await closedMonth();
    await payouts.confirm(alice, period, { decision: "confirmed" });
    await pay(period, alice, "1000.00");

    const status = await payouts.status(period);

    expect(status.confirmDeadlineAt).toBe(new Date(closeAt.getTime() + 5 * DAY_MS).toISOString());
    expect(status.participants).toEqual([
      expect.objectContaining({ accountId: alice.accountId, name: "Алиса", owedRub: "2600.00", paidRub: "1000.00", remainingRub: "1600.00", confirmation: expect.objectContaining({ status: "confirmed" }), canPay: true, needsReason: false }),
    ]);
  });

  it("правила базы: спор без комментария, кривой месяц и получатель без месяца выплаты не записываются", async () => {
    const period = await freshPeriod();
    const alice = await person("Алиса");
    const base = { period, accountId: alice.accountId, decidedAt: new Date() };

    await expect(prisma.ledgerConfirmation.create({ data: { ...base, status: "disputed", comment: null } })).rejects.toThrow();
    await expect(prisma.ledgerConfirmation.create({ data: { ...base, status: "disputed", comment: "не" } })).rejects.toThrow();
    await expect(prisma.ledgerConfirmation.create({ data: { ...base, period: "2026-13", status: "confirmed" } })).rejects.toThrow();
    await prisma.ledgerConfirmation.create({ data: { ...base, status: "confirmed" } });
    await expect(prisma.ledgerConfirmation.create({ data: { ...base, status: "confirmed" } })).rejects.toThrow();

    // получатель и месяц выплаты — парой; причина решения владельца не бывает у операции без получателя
    const operationId = randomUUID();
    const row = { operationId, kind: "payout" as const, input: {}, note: "Выплата", createdBy: owner.accountId };
    createdOperations.push(operationId);
    await expect(prisma.ledgerOperation.create({ data: { ...row, payee: "owner" } })).rejects.toThrow();
    await expect(prisma.ledgerOperation.create({ data: { ...row, payoutPeriod: period } })).rejects.toThrow();
    await expect(prisma.ledgerOperation.create({ data: { ...row, overrideReason: "причина" } })).rejects.toThrow();
    await expect(prisma.ledgerOperation.create({ data: { ...row, payee: "owner", payoutPeriod: "2026-13" } })).rejects.toThrow();
    await prisma.ledgerOperation.create({ data: { ...row, payee: "owner", payoutPeriod: period } });
  });
});
