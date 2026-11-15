import { findEntryProblems, type LedgerAccount } from "@bh/ledger";
import { describe, expect, it } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import { botMessageOf } from "../src/modules/notifications-bot/bot-notify-texts.js";
import { botRuleOf } from "../src/modules/notifications-bot/bot-notify-rules.js";
import { NOTIFICATION_KINDS } from "../src/modules/notifications/notification-kinds.js";
import { buildOperation, type BuildResult, type BuiltOperation, type ChartPlace, type OperationsChart } from "../src/modules/ledger/operations/builders.js";
import { needsApproval } from "../src/modules/ledger/operations/approval.js";
import { OPERATION_KINDS, operationInputSchema, type OperationInputOf } from "../src/modules/ledger/operations/operation-input.js";
import { operationSummary } from "../src/modules/ledger/operations/operations-notify.js";
import { parsePayee, payeeKey } from "../src/modules/ledger/payouts/payee.js";
import { loadPayoutFacts } from "../src/modules/ledger/payouts/payout-facts.js";
import { PayoutPeriodHooks } from "../src/modules/ledger/payouts/payout-hooks.js";
import { PayoutNotices } from "../src/modules/ledger/payouts/payout-notices.js";
import { payGate, type PayoutFacts } from "../src/modules/ledger/payouts/payout-rules.js";
import { PayoutSupportService } from "../src/modules/ledger/payouts/payout-support.js";
import type { StoredConfirmation } from "../src/modules/ledger/payouts/payouts.repository.js";
import { PayoutsService } from "../src/modules/ledger/payouts/payouts.service.js";
import type { PeriodSnapshot } from "../src/modules/ledger/periods/period-snapshot.js";
import type { AuditEntry } from "../src/modules/roles/roles.repository.js";
import type { Permission } from "../src/modules/roles/permissions.js";
import type { AccountRef, RolesService } from "../src/modules/roles/roles.service.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { MemoryPayoutsRepository, closedSnapshot, type SnapshotInput } from "./helpers/memory-payouts.js";
import { memoryNotifications } from "./helpers/memory-notifications.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Подтверждение отчёта участниками, выплаты и сообщения (docs/37-accounting.md §13, Р222, tasks/T-0469). Слои:
 * правила «можно ли платить» и сборщик проводки «выплата» — чистые функции; сервисы — на данных месяца в памяти и
 * настоящей ленте уведомлений в памяти (повтор события не заводит второй строки). Как это ложится на таблицы и
 * гонки базы — `ledger-payouts.integration.test.ts`.
 */

const PERIOD = "2026-11";
const CLOSED_AT = new Date("2026-12-02T10:00:00.000Z");
/** Два дня после закрытия: срок подтверждения (5 дней) ещё идёт. */
const DAY_2 = new Date("2026-12-04T12:00:00.000Z");
/** Ровно пять суток после закрытия: «дольше срока» ещё не наступило. */
const DAY_5 = new Date("2026-12-07T10:00:00.000Z");
/** Больше пяти суток: молчание участника — повод для решения владельца. */
const DAY_6 = new Date("2026-12-08T12:00:00.000Z");

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BORIS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOAN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OP_ID = "6f1d3c52-5a0e-4a8e-9d57-0c6f0a2d9b11";

const NO_FEE = { percentBp: null, fixed: null, fixedCurrency: null };

function place(accountId: string, name: string, currency: string, archived = false): [string, ChartPlace] {
  return [accountId, { accountId, name, currency, place: accountId, archived, fee: NO_FEE }];
}

const CHART: OperationsChart = {
  places: new Map([place("bank.rub", "Банк, ₽", "RUB"), place("exchange.usdt", "Биржа или USDT", "USDT"), place("bank.old", "Старый счёт", "RUB", true)]),
  articles: new Map(),
};

const aliceDebt = `liability.stakeholder.${ALICE}.RUB`;
/** Долг Алисе за ноябрь: 15 980,40 ₽. */
const ALICE_OWED = 1_598_040n;

function confirmation(status: "confirmed" | "disputed", decidedAt = new Date("2026-12-03T09:00:00.000Z"), comment: string | null = null): StoredConfirmation {
  return { period: PERIOD, accountId: ALICE, status, comment, decidedAt };
}

/** Факты месяца для выплаты Алисе: закрыт два дня назад, подтверждено, ничего ещё не выплачено. */
function facts(overrides: Partial<PayoutFacts> = {}): PayoutFacts {
  return {
    now: DAY_2,
    confirmDays: 5,
    periodStatus: "closed",
    closedAt: CLOSED_AT,
    inReport: true,
    owed: ALICE_OWED,
    currency: "RUB",
    debtAccountId: aliceDebt,
    debtBalance: ALICE_OWED,
    paid: 0n,
    confirmation: confirmation("confirmed"),
    label: "Алиса",
    ...overrides,
  };
}

type PayoutInput = OperationInputOf<"payout">;

const PAYOUT: PayoutInput = { kind: "payout", note: "Выплата за ноябрь", at: "2026-12-04", payee: `stakeholder:${ALICE}`, period: PERIOD, from: "bank.rub", amount: "15980.40" };

/** `null` вместо фактов — месяц не прочитан: сборщик получает «нет данных», а не умолчание теста. */
function result(input: PayoutInput, payoutFacts: PayoutFacts | null, chart: OperationsChart = CHART, now: Date = DAY_2): BuildResult {
  return buildOperation(OP_ID, input, chart, now, payoutFacts ?? undefined);
}

function built(input: PayoutInput, payoutFacts: PayoutFacts = facts(), chart?: OperationsChart): BuiltOperation {
  const outcome = result(input, payoutFacts, chart);
  if (!outcome.ok) throw new Error(`ожидалась проводка, а сборка отказала: ${outcome.problems.map((problem) => problem.message).join("; ")}`);
  return outcome.built;
}

function problemsOf(input: PayoutInput, payoutFacts: PayoutFacts | null = facts(), now?: Date): string[] {
  const outcome = result(input, payoutFacts, CHART, now);
  if (outcome.ok) throw new Error("ожидались проблемы, а сборка прошла");
  return outcome.problems.map((problem) => problem.message);
}

function linesOf(operation: BuiltOperation): Record<string, bigint> {
  return Object.fromEntries(operation.draft.lines.map((line) => [line.accountId, line.amount]));
}

/** Счета проводки для проверки ядром: места плана и служебные счета сборки. */
function accountsOf(operation: BuiltOperation, debtType: "liability" | "equity" = "liability"): Map<string, LedgerAccount> {
  const accounts = new Map<string, LedgerAccount>();
  for (const [, item] of CHART.places) accounts.set(item.accountId, { id: item.accountId, type: "asset", currency: item.currency, name: item.name });
  for (const line of operation.draft.lines) {
    if (!accounts.has(line.accountId)) accounts.set(line.accountId, { id: line.accountId, type: debtType, currency: line.accountId.endsWith(".USDT") ? "USDT" : "RUB", name: line.accountId });
  }
  for (const service of operation.serviceAccounts) accounts.set(service.accountId, { id: service.accountId, type: service.type, currency: service.currency, name: service.name });
  return accounts;
}

// ---- Снимок закрытого месяца ----

type SnapshotOptions = Omit<SnapshotInput, "period" | "closedAt">;

/** Снимок ноября: по умолчанию долг один — Алисе. */
function snapshotOf(options: SnapshotOptions = {}): PeriodSnapshot {
  return closedSnapshot({ period: PERIOD, closedAt: CLOSED_AT, payouts: [{ accountId: ALICE, rubMinor: ALICE_OWED, name: "Алиса" }], ...options });
}

// ---- Схема и получатели ----

describe("выплата: схема тела и получатели", () => {
  it("вид «выплата» — в списке видов, тело строгое: лишнее поле, чужой получатель и кривой месяц отклоняются", () => {
    expect(OPERATION_KINDS).toContain("payout");
    expect(operationInputSchema.safeParse(PAYOUT).success).toBe(true);
    expect(operationInputSchema.safeParse({ ...PAYOUT, extra: 1 }).success).toBe(false);
    expect(operationInputSchema.safeParse({ ...PAYOUT, payee: "partner:1" }).success).toBe(false);
    expect(operationInputSchema.safeParse({ ...PAYOUT, payee: "stakeholder:не-uuid" }).success).toBe(false);
    expect(operationInputSchema.safeParse({ ...PAYOUT, period: "2026-13" }).success).toBe(false);
    expect(operationInputSchema.safeParse({ ...PAYOUT, amount: "-5" }).success).toBe(false);
    expect(operationInputSchema.safeParse({ ...PAYOUT, amount: "1e3" }).success).toBe(false);
    expect(operationInputSchema.safeParse({ ...PAYOUT, period: undefined }).success).toBe(false);
  });

  it("причина решения владельца — от трёх до пятисот знаков, пустая строка не причина", () => {
    expect(operationInputSchema.safeParse({ ...PAYOUT, overrideReason: "уехал, договорились устно" }).success).toBe(true);
    expect(operationInputSchema.safeParse({ ...PAYOUT, overrideReason: "ок" }).success).toBe(false);
    expect(operationInputSchema.safeParse({ ...PAYOUT, overrideReason: "   " }).success).toBe(false);
    expect(operationInputSchema.safeParse({ ...PAYOUT, overrideReason: "я".repeat(501) }).success).toBe(false);
    expect(operationInputSchema.safeParse({ ...PAYOUT, overrideReason: "я".repeat(500) }).success).toBe(true);
  });

  it("получатель разбирается в вид и обратно: участник, владелец, налог, заём", () => {
    expect(parsePayee(`stakeholder:${ALICE}`)).toEqual({ kind: "stakeholder", accountId: ALICE });
    expect(parsePayee("owner")).toEqual({ kind: "owner" });
    expect(parsePayee("tax")).toEqual({ kind: "tax" });
    expect(parsePayee(`loan:${LOAN_ID}`)).toEqual({ kind: "loan", loanId: LOAN_ID });
    for (const raw of [`stakeholder:${ALICE}`, "owner", "tax", `loan:${LOAN_ID}`]) {
      const payee = parsePayee(raw);
      expect(payee === null ? null : payeeKey(payee)).toBe(raw);
    }
    for (const raw of ["", "owner:1", "stakeholder:", "stakeholder:123", "Tax", "loan:xx", ` stakeholder:${ALICE}`]) expect(parsePayee(raw), raw).toBeNull();
  });
});

// ---- Можно ли платить ----

describe("можно ли платить участнику: подтверждение, срок, спор", () => {
  const gate = (confirmationRow: StoredConfirmation | null, now: Date, options: { kind?: "stakeholder" | "owner" | "tax" | "loan"; days?: number; closedAt?: Date } = {}) =>
    payGate(options.kind ?? "stakeholder", { closedAt: options.closedAt ?? CLOSED_AT, confirmation: confirmationRow, now, confirmDays: options.days ?? 5 });

  it("подтвердил — платить можно сразу, без причины", () => {
    expect(gate(confirmation("confirmed"), DAY_2)).toEqual({ state: "free" });
  });

  it("молчит меньше срока — ждём: платить нельзя даже с причиной; говорит, сколько осталось", () => {
    const outcome = gate(null, DAY_2);
    expect(outcome.state).toBe("wait");
    expect(outcome).toMatchObject({ until: new Date("2026-12-07T10:00:00.000Z") });
  });

  it("ровно пять суток — ещё ждём («дольше срока»), через минуту — решение владельца с причиной", () => {
    expect(gate(null, DAY_5).state).toBe("wait");
    expect(gate(null, new Date(DAY_5.getTime() + 60_000)).state).toBe("override");
    expect(gate(null, DAY_6).state).toBe("override");
  });

  it("срок — из настройки: при трёх сутках через четверо суток владелец уже решает, при семи — ещё ждём", () => {
    const fourDays = new Date("2026-12-06T10:00:00.000Z");
    expect(gate(null, fourDays, { days: 3 }).state).toBe("override");
    expect(gate(null, fourDays, { days: 7 }).state).toBe("wait");
  });

  it("оспорил — только решение владельца с причиной, в любой день и в первую же минуту", () => {
    const disputed = confirmation("disputed", new Date("2026-12-02T10:01:00.000Z"), "Не сходится курс");
    const outcome = gate(disputed, new Date("2026-12-02T10:02:00.000Z"));
    expect(outcome.state).toBe("override");
    expect(outcome).toMatchObject({ reason: expect.stringContaining("оспорил") });
    expect(gate(disputed, DAY_6).state).toBe("override");
  });

  it("подтверждение, данное до закрытия (до последнего снятия), не считается: месяц закрыт заново", () => {
    const stale = confirmation("confirmed", new Date("2026-12-01T10:00:00.000Z"));
    expect(gate(stale, DAY_2).state).toBe("wait");
    expect(gate(stale, DAY_6).state).toBe("override");
    // и спор до закрытия — тоже старый: он не заставляет владельца решать заново
    expect(gate(confirmation("disputed", new Date("2026-12-01T10:00:00.000Z"), "старый спор"), DAY_2).state).toBe("wait");
  });

  it("владельцу, налогу и займу подтверждения не нужны", () => {
    for (const kind of ["owner", "tax", "loan"] as const) expect(gate(null, DAY_2, { kind }), kind).toEqual({ state: "free" });
  });
});

// ---- Сборщик проводки «выплата» ----

describe("сборщик «выплата»: каждому получателю — место −, долг +", () => {
  it("участнику: деньги уходят с места, обязательство перед ним гасится; проводка проходит ядро учёта", () => {
    const operation = built(PAYOUT);

    expect(linesOf(operation)).toEqual({ "bank.rub": -ALICE_OWED, [aliceDebt]: ALICE_OWED });
    expect(findEntryProblems(operation.draft, accountsOf(operation))).toEqual([]);
    expect(operation.draft.sourceKey).toBe(`op:${OP_ID}`);
    expect(operation.draft.memo).toBe("Выплата за ноябрь");
    expect(operation.draft.meta).toMatchObject({ operation: OP_ID, kind: "payout", payee: `stakeholder:${ALICE}`, payoutPeriod: PERIOD });
    expect(operation.estimate).toEqual([{ currency: "RUB", minor: ALICE_OWED }]);
    expect(operation.serviceAccounts).toEqual([]);
    expect(operation.loan).toBeNull();
  });

  it("часть долга — можно: остаток уменьшается, а повторная выплата того же остатка уже нет", () => {
    const first = built({ ...PAYOUT, amount: "10000" }, facts());
    expect(linesOf(first)[aliceDebt]).toBe(1_000_000n);

    // выплачено 10 000 ₽: остаётся 5 980,40
    const rest = facts({ paid: 1_000_000n, debtBalance: 598_040n });
    expect(built({ ...PAYOUT, amount: "5980.40" }, rest).draft.lines).toHaveLength(2);
    expect(problemsOf({ ...PAYOUT, amount: "5980.41" }, rest).join(" ")).toContain("остатка долга");
  });

  it("налог — со счёта обязательства по налогу, в рублях", () => {
    const operation = built({ ...PAYOUT, payee: "tax", amount: "160" }, facts({ owed: 16_000n, debtAccountId: "liability.tax.RUB", debtBalance: 16_000n, confirmation: null }));
    expect(linesOf(operation)).toEqual({ "bank.rub": -16_000n, "liability.tax.RUB": 16_000n });
    expect(findEntryProblems(operation.draft, accountsOf(operation))).toEqual([]);
    expect(operation.draft.meta).toMatchObject({ payee: "tax" });
  });

  it("транш займа — в валюте займа, на счёт обязательства по займу", () => {
    const loanFacts = facts({ owed: 5_000_000n, currency: "USDT", debtAccountId: "loan.ivan.USDT", debtBalance: 20_000_000n, confirmation: null, label: "Иван" });
    const operation = built({ ...PAYOUT, payee: `loan:${LOAN_ID}`, from: "exchange.usdt", amount: "5" }, loanFacts);
    expect(linesOf(operation)).toEqual({ "exchange.usdt": -5_000_000n, "loan.ivan.USDT": 5_000_000n });
    expect(findEntryProblems(operation.draft, accountsOf(operation))).toEqual([]);
  });

  it("владельцу — на счёт «Выплаты владельцу» в валюте места; счёт заводится сборкой, подтверждения не нужны", () => {
    const ownerFacts = facts({ owed: null, currency: null, debtAccountId: null, debtBalance: 0n, confirmation: null, label: "Владелец" });
    const operation = built({ ...PAYOUT, payee: "owner", from: "exchange.usdt", amount: "120.5" }, ownerFacts);

    expect(linesOf(operation)).toEqual({ "exchange.usdt": -120_500_000n, "equity.owner_draw.USDT": 120_500_000n });
    expect(operation.serviceAccounts).toEqual([{ accountId: "equity.owner_draw.USDT", type: "equity", currency: "USDT", name: expect.stringContaining("USDT") }]);
    expect(findEntryProblems(operation.draft, accountsOf(operation, "equity"))).toEqual([]);
  });

  it("владельцу можно в любой валюте места, а участнику и налогу — только в рублях", () => {
    expect(problemsOf({ ...PAYOUT, from: "exchange.usdt", amount: "10" }).join(" ")).toContain("в рублях");
    expect(problemsOf({ ...PAYOUT, payee: "tax", from: "exchange.usdt", amount: "1" }, facts({ owed: 100n, debtAccountId: "liability.tax.RUB", debtBalance: 100n, confirmation: null })).join(" ")).toContain("в рублях");
  });

  it("заём — только в валюте займа", () => {
    const loanFacts = facts({ owed: 5_000_000n, currency: "USDT", debtAccountId: "loan.ivan.USDT", debtBalance: 20_000_000n, confirmation: null, label: "Иван" });
    expect(problemsOf({ ...PAYOUT, payee: `loan:${LOAN_ID}`, from: "bank.rub", amount: "5" }, loanFacts).join(" ")).toContain("USDT");
  });

  it("больше остатка долга за месяц — проблема сборки, с цифрами", () => {
    const messages = problemsOf({ ...PAYOUT, amount: "15980.41" });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("остатка долга");
    expect(messages[0]).toContain("15980.40");
  });

  it("больше сальдо счёта обязательства — тоже проблема, даже если месяц позволяет", () => {
    // в отчёте месяца 15 980,40, а на счёте обязательства только 100 — например, часть уже сторнирована
    expect(problemsOf(PAYOUT, facts({ debtBalance: 10_000n })).join(" ")).toContain("остатка долга");
  });

  it("месяц не закрыт, на сверке или открыт — выплаты нет", () => {
    for (const periodStatus of ["open", "review"] as const) {
      expect(problemsOf(PAYOUT, facts({ periodStatus, closedAt: null })).join(" "), periodStatus).toContain("не закрыт");
    }
  });

  it("получателя нет в отчёте месяца: участник без доли, налога нет, займ не гасился, у владельца нечего делить", () => {
    expect(problemsOf(PAYOUT, facts({ inReport: false, owed: null })).join(" ")).toContain("нет в отчёте");
    expect(problemsOf({ ...PAYOUT, payee: "owner", from: "exchange.usdt" }, facts({ inReport: false, owed: null, currency: null, debtAccountId: null, confirmation: null })).join(" ")).toContain("нет в отчёте");
  });

  it("нет данных месяца — отказ, а не выплата вслепую", () => {
    expect(problemsOf(PAYOUT, null).join(" ")).toContain("данных месяца");
  });

  it("не подтвердил, срок не вышел — нельзя, даже с причиной владельца", () => {
    const silent = facts({ confirmation: null });
    expect(problemsOf(PAYOUT, silent).join(" ")).toContain("не подтвердил");
    expect(problemsOf({ ...PAYOUT, overrideReason: "уехал, договорились устно" }, silent).join(" ")).toContain("не подтвердил");
  });

  it("не подтвердил, срок вышел — только с причиной владельца; причина попадает в проводку", () => {
    const silent = facts({ confirmation: null, now: DAY_6 });
    expect(problemsOf(PAYOUT, silent, DAY_6).join(" ")).toContain("причин");

    const operation = built({ ...PAYOUT, overrideReason: "уехал, договорились устно" }, silent);
    expect(operation.draft.meta).toMatchObject({ overrideReason: "уехал, договорились устно" });
  });

  it("оспорил — только с причиной владельца, в любой день", () => {
    const disputed = facts({ confirmation: confirmation("disputed", new Date("2026-12-03T09:00:00.000Z"), "Не сходится курс") });
    expect(problemsOf(PAYOUT, disputed).join(" ")).toContain("оспорил");
    expect(built({ ...PAYOUT, overrideReason: "разобрались, курс верный" }, disputed).draft.meta).toMatchObject({ overrideReason: "разобрались, курс верный" });
  });

  it("подтвердил — причина не нужна, но и не мешает", () => {
    expect(built({ ...PAYOUT, overrideReason: "лишняя причина" }).draft.meta).toMatchObject({ overrideReason: "лишняя причина" });
  });

  it("нулевая сумма и место в архиве — отдельные проблемы, а не молчаливая проводка", () => {
    expect(problemsOf({ ...PAYOUT, amount: "0" }).join(" ")).toContain("больше нуля");
    expect(problemsOf({ ...PAYOUT, from: "bank.old" }).join(" ")).toContain("в архиве");
    expect(problemsOf({ ...PAYOUT, from: "нет-такого" }).join(" ")).toContain("нет");
  });

  it("получатель не из допустимых видов — проблема, а не исключение", () => {
    expect(problemsOf({ ...PAYOUT, payee: "stakeholder:123" }).join(" ")).toContain("получатель");
  });
});

describe("второй ключ: выплата финансов всегда ждёт владельца", () => {
  it("мелкая выплата финансов ждёт при любом пороге, у владельца — проводится сразу", () => {
    const small = { kind: "payout" as const, amountUsd: "0.01", thresholdUsd: 200 };
    expect(needsApproval({ ...small, actorCanApprove: false })).toBe(true);
    expect(needsApproval({ ...small, actorCanApprove: true })).toBe(false);
    // нулевой порог и известная оценка не отменяют правило: деньги участнику — решение владельца
    expect(needsApproval({ kind: "payout", amountUsd: "5.00", thresholdUsd: 100_000, actorCanApprove: false })).toBe(true);
  });

  it("карточка операции называет получателя и причину владельца словами, а не строками проводки", () => {
    const summary = operationSummary({ ...PAYOUT, overrideReason: "уехал, договорились устно" }, CHART);
    expect(summary).toContain("15980.40 RUB");
    expect(summary).toContain("уехал, договорились устно");
  });
});

// ---- Факты месяца из хранилища ----

describe("факты месяца для выплаты", () => {
  const settings = panelSettings();

  function repoWithClosedMonth(options: SnapshotOptions = {}): MemoryPayoutsRepository {
    const repository = new MemoryPayoutsRepository();
    repository.close(PERIOD, snapshotOf(options), CLOSED_AT);
    repository.balances.set(aliceDebt, ALICE_OWED);
    repository.accountNames.set(ALICE, "Алиса");
    return repository;
  }

  it("участник: долг месяца из снимка, сальдо счёта, подтверждение и уже выплаченное", async () => {
    const repository = repoWithClosedMonth();
    await repository.saveConfirmation(confirmation("confirmed"));
    repository.payoutRows.push({ operationId: "op-1", period: PERIOD, payee: `stakeholder:${ALICE}`, accountId: aliceDebt, currency: "RUB", minor: 100_000n, overrideReason: null, at: DAY_2 });
    repository.payoutRows.push({ operationId: "op-2", period: PERIOD, payee: `stakeholder:${BORIS}`, accountId: `liability.stakeholder.${BORIS}.RUB`, currency: "RUB", minor: 7_000n, overrideReason: null, at: DAY_2 });

    const loaded = await loadPayoutFacts(repository, settings, { ...PAYOUT, amount: "1" }, DAY_2);

    expect(loaded).toMatchObject({
      periodStatus: "closed",
      closedAt: CLOSED_AT,
      inReport: true,
      owed: ALICE_OWED,
      currency: "RUB",
      debtAccountId: aliceDebt,
      debtBalance: ALICE_OWED,
      paid: 100_000n,
      confirmDays: 5,
      label: "Алиса",
    });
    expect(loaded.confirmation).toEqual(confirmation("confirmed"));
  });

  it("налог и транш займа берутся из снимка; владелец — без предела, но только если было что делить", async () => {
    const repository = repoWithClosedMonth({ taxMinor: 16_000n, loans: [{ loanId: LOAN_ID, lender: "Иван", currency: "USDT", trancheMinor: 5_000_000n }], ownerUsdCents: 12_000n });
    repository.balances.set("liability.tax.RUB", 16_000n);
    repository.loans.set(LOAN_ID, { loanId: LOAN_ID, accountId: "loan.ivan.USDT", currency: "USDT", lender: "Иван" });

    const tax = await loadPayoutFacts(repository, settings, { ...PAYOUT, payee: "tax" }, DAY_2);
    expect(tax).toMatchObject({ inReport: true, owed: 16_000n, currency: "RUB", debtAccountId: "liability.tax.RUB", debtBalance: 16_000n, confirmation: null });

    const loan = await loadPayoutFacts(repository, settings, { ...PAYOUT, payee: `loan:${LOAN_ID}`, from: "exchange.usdt" }, DAY_2);
    expect(loan).toMatchObject({ inReport: true, owed: 5_000_000n, currency: "USDT", debtAccountId: "loan.ivan.USDT" });

    const owner = await loadPayoutFacts(repository, settings, { ...PAYOUT, payee: "owner" }, DAY_2);
    expect(owner).toMatchObject({ inReport: true, owed: null, currency: null, debtAccountId: null });

    const none = repoWithClosedMonth({ ownerUsdCents: 0n });
    expect(await loadPayoutFacts(none, settings, { ...PAYOUT, payee: "owner" }, DAY_2)).toMatchObject({ inReport: false });
  });

  it("участника нет в снимке, налога и займа нет — «нет в отчёте»; месяца нет вовсе — открыт", async () => {
    const repository = repoWithClosedMonth({ payouts: [{ accountId: BORIS, rubMinor: 1_000n }] });
    expect(await loadPayoutFacts(repository, settings, PAYOUT, DAY_2)).toMatchObject({ inReport: false, owed: null });
    expect(await loadPayoutFacts(repository, settings, { ...PAYOUT, payee: "tax" }, DAY_2)).toMatchObject({ inReport: false });
    expect(await loadPayoutFacts(repository, settings, { ...PAYOUT, payee: `loan:${LOAN_ID}` }, DAY_2)).toMatchObject({ inReport: false });

    const empty = new MemoryPayoutsRepository();
    expect(await loadPayoutFacts(empty, settings, PAYOUT, DAY_2)).toMatchObject({ periodStatus: "open", closedAt: null, inReport: false });
  });

  it("срок подтверждения — настройка `finance.confirm-days`", async () => {
    const repository = repoWithClosedMonth();
    const custom = panelSettings({ [SETTINGS.financeConfirmDays.key]: 9 });
    expect((await loadPayoutFacts(repository, custom, PAYOUT, DAY_2)).confirmDays).toBe(9);
    expect(SETTINGS.financeConfirmDays.fallback).toBe(5);
  });
});

// ---- Подтверждение отчёта участником ----

describe("подтверждение отчёта участником", () => {
  const participant: AccountRef = { accountId: ALICE, platform: "telegram", platformUserId: "111" };
  const stranger: AccountRef = { accountId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", platform: "telegram", platformUserId: "444" };
  const OWN_VIEW: Permission = "revenue.split.own.view";

  function setup(now: Date = DAY_2) {
    const repository = new MemoryPayoutsRepository();
    repository.close(PERIOD, snapshotOf({ payouts: [{ accountId: ALICE, rubMinor: ALICE_OWED, name: "Алиса" }, { accountId: BORIS, rubMinor: 500_000n, name: "Борис" }] }), CLOSED_AT);
    repository.accountNames.set(ALICE, "Алиса");
    repository.accountNames.set(BORIS, "Борис");
    const audit: AuditEntry[] = [];
    const chat: string[] = [];
    const notifications = memoryNotifications();
    const granted = new Map<string, readonly Permission[]>([[ALICE, [OWN_VIEW]], [BORIS, [OWN_VIEW]]]);
    const roles = {
      permissions: async (actor: { accountId: string }) => new Set(granted.get(actor.accountId) ?? []),
      audit: async (entry: AuditEntry) => void audit.push(entry),
    } as unknown as RolesService;
    const lock = { run: async <T>(_period: string, work: () => Promise<T>) => await work() };
    const notices = new PayoutNotices(notifications.service, repository, { send: async (text: string) => void chat.push(text) });
    const service = new PayoutsService(repository, roles, panelSettings(), notices, lock);
    return { repository, audit, chat, notifications, service, now, granted };
  }

  async function failure(promise: Promise<unknown>): Promise<DomainError> {
    try {
      await promise;
    } catch (error: unknown) {
      if (error instanceof DomainError) return error;
      throw error;
    }
    throw new Error("ожидалась доменная ошибка, а вызов прошёл");
  }

  it("подтверждает свой отчёт: строка решения, аудит `ledger.period.confirm`, в ответе — свой статус", async () => {
    const { repository, audit, service, now } = setup();

    const view = await service.confirm(participant, PERIOD, { decision: "confirmed" }, now);

    expect(repository.confirmationRows.get(`${PERIOD}|${ALICE}`)).toEqual({ period: PERIOD, accountId: ALICE, status: "confirmed", comment: null, decidedAt: now });
    expect(audit.map((entry) => [entry.action, entry.target, entry.actorAccountId])).toEqual([["ledger.period.confirm", PERIOD, ALICE]]);
    expect(view.mine).toMatchObject({ accountId: ALICE, owedRub: "15980.40", paidRub: "0.00", remainingRub: "15980.40", confirmation: { status: "confirmed", comment: null } });
  });

  it("оспаривает с комментарием: аудит `ledger.period.dispute`, сообщение в поток «Бухгалтерия» с именем и текстом спора", async () => {
    const { repository, audit, chat, service, now } = setup();

    await service.confirm(participant, PERIOD, { decision: "disputed", comment: "  В расходах лишняя строка  " }, now);

    expect(repository.confirmationRows.get(`${PERIOD}|${ALICE}`)).toMatchObject({ status: "disputed", comment: "В расходах лишняя строка" });
    expect(audit.map((entry) => entry.action)).toEqual(["ledger.period.dispute"]);
    expect(chat).toHaveLength(1);
    expect(chat[0]).toContain("Алиса");
    expect(chat[0]).toContain("В расходах лишняя строка");
    expect(chat[0]).toContain("2026-11");
  });

  it("спор без комментария и с комментарием короче трёх знаков — отказ 400, ничего не записано", async () => {
    const { repository, audit, chat, service, now } = setup();
    for (const comment of [undefined, "", "  ", "не"]) {
      const error = await failure(service.confirm(participant, PERIOD, { decision: "disputed", ...(comment === undefined ? {} : { comment }) }, now));
      expect([error.code, error.status], String(comment)).toEqual(["validation_failed", 400]);
    }
    const tooLong = await failure(service.confirm(participant, PERIOD, { decision: "disputed", comment: "я".repeat(1_001) }, now));
    expect(tooLong.status).toBe(400);
    expect(repository.confirmationRows.size).toBe(0);
    expect(audit).toEqual([]);
    expect(chat).toEqual([]);
  });

  it("комментарий к подтверждению необязателен, но не длиннее тысячи знаков", async () => {
    const { repository, service, now } = setup();
    await service.confirm(participant, PERIOD, { decision: "confirmed", comment: "Всё сходится" }, now);
    expect(repository.confirmationRows.get(`${PERIOD}|${ALICE}`)?.comment).toBe("Всё сходится");
    expect((await failure(service.confirm(participant, PERIOD, { decision: "confirmed", comment: "я".repeat(1_001) }, now))).status).toBe(400);
  });

  it("чужой месяц: у участника нет доли в этом месяце — 403, подтверждение не записывается", async () => {
    const { repository, audit, granted, service, now } = setup();
    granted.set(stranger.accountId, [OWN_VIEW]);

    const error = await failure(service.confirm(stranger, PERIOD, { decision: "confirmed" }, now));

    expect([error.code, error.status]).toEqual(["forbidden", 403]);
    expect(repository.confirmationRows.size).toBe(0);
    expect(audit).toEqual([]);
  });

  it("без права «свой расчёт» (финансы, посторонний) — 403, даже если аккаунт есть в снимке", async () => {
    const { granted, service, now } = setup();
    granted.set(ALICE, []);
    expect((await failure(service.confirm(participant, PERIOD, { decision: "confirmed" }, now))).status).toBe(403);
    expect((await failure(service.reportFor(participant, PERIOD))).status).toBe(403);
  });

  it("месяц не закрыт — 409 `ledger_period_status`: подтверждать нечего", async () => {
    const { repository, service, now } = setup();
    repository.setStatus(PERIOD, "review");
    const error = await failure(service.confirm(participant, PERIOD, { decision: "confirmed" }, now));
    expect([error.code, error.status]).toEqual(["ledger_period_status", 409]);

    const never = await failure(service.confirm(participant, "2026-10", { decision: "confirmed" }, now));
    expect(never.status).toBe(409);
    expect(repository.confirmationRows.size).toBe(0);
  });

  it("решение можно поменять, пока участнику не выплачено: спор → подтверждение; аудит каждого шага", async () => {
    const { repository, audit, service, now } = setup();
    await service.confirm(participant, PERIOD, { decision: "disputed", comment: "Не сходится курс" }, now);
    await service.confirm(participant, PERIOD, { decision: "confirmed" }, new Date(now.getTime() + 60_000));

    expect(repository.confirmationRows.get(`${PERIOD}|${ALICE}`)).toMatchObject({ status: "confirmed", comment: null });
    expect(audit.map((entry) => entry.action)).toEqual(["ledger.period.dispute", "ledger.period.confirm"]);
  });

  it("повтор того же решения — безопасен: ни второй записи, ни второго аудита, ни второго сообщения команде", async () => {
    const { repository, audit, chat, service, now } = setup();
    await service.confirm(participant, PERIOD, { decision: "disputed", comment: "Не сходится курс" }, now);
    const decidedAt = repository.confirmationRows.get(`${PERIOD}|${ALICE}`)?.decidedAt;

    await service.confirm(participant, PERIOD, { decision: "disputed", comment: "Не сходится курс" }, new Date(now.getTime() + 5_000));

    expect(repository.confirmationRows.get(`${PERIOD}|${ALICE}`)?.decidedAt).toEqual(decidedAt);
    expect(audit).toHaveLength(1);
    expect(chat).toHaveLength(1);
  });

  it("после выплаты участнику решение не меняется — 409 `ledger_confirmation_paid`, в том числе повтор того же", async () => {
    const { repository, audit, service, now } = setup();
    await service.confirm(participant, PERIOD, { decision: "confirmed" }, now);
    repository.payoutRows.push({ operationId: "op-1", period: PERIOD, payee: `stakeholder:${ALICE}`, accountId: aliceDebt, currency: "RUB", minor: 100_000n, overrideReason: null, at: now });

    const change = await failure(service.confirm(participant, PERIOD, { decision: "disputed", comment: "Передумал, не сходится" }, now));
    const repeat = await failure(service.confirm(participant, PERIOD, { decision: "confirmed" }, now));

    expect([change.code, change.status]).toEqual(["ledger_confirmation_paid", 409]);
    expect(repeat.code).toBe("ledger_confirmation_paid");
    expect(repository.confirmationRows.get(`${PERIOD}|${ALICE}`)?.status).toBe("confirmed");
    expect(audit).toHaveLength(1);
  });

  it("выплата другому участнику решения Алисы не запирает", async () => {
    const { repository, service, now } = setup();
    repository.payoutRows.push({ operationId: "op-9", period: PERIOD, payee: `stakeholder:${BORIS}`, accountId: `liability.stakeholder.${BORIS}.RUB`, currency: "RUB", minor: 500_000n, overrideReason: null, at: now });
    await service.confirm(participant, PERIOD, { decision: "confirmed" }, now);
    expect(repository.confirmationRows.has(`${PERIOD}|${ALICE}`)).toBe(true);
  });

  it("отчёт участника: водопад из снимка и только его строка статуса; чужие подтверждения не видны", async () => {
    const { repository, service, now } = setup();
    await repository.saveConfirmation({ period: PERIOD, accountId: BORIS, status: "disputed", comment: "Не согласен", decidedAt: now });

    const view = await service.reportFor(participant, PERIOD);

    expect(view.period).toBe(PERIOD);
    expect(view.mine).toMatchObject({ accountId: ALICE, name: "Алиса", confirmation: null, canChange: true });
    expect(JSON.stringify(view)).not.toContain("Не согласен");
    expect(view.report.currency).toBe("USD");
    expect(view.deadlineAt).toBe("2026-12-07T10:00:00.000Z");
  });

  it("статус для владельца: по каждому участнику — долг, подтверждение, выплачено и можно ли платить с причиной отказа", async () => {
    const { repository, service } = setup();
    await repository.saveConfirmation(confirmation("confirmed"));
    await repository.saveConfirmation({ period: PERIOD, accountId: BORIS, status: "disputed", comment: "Не согласен", decidedAt: new Date("2026-12-03T10:00:00.000Z") });
    repository.balances.set(aliceDebt, ALICE_OWED);
    repository.payoutRows.push({ operationId: "op-1", period: PERIOD, payee: `stakeholder:${ALICE}`, accountId: aliceDebt, currency: "RUB", minor: 100_000n, overrideReason: null, at: DAY_2 });

    const status = await service.status(PERIOD, DAY_2);

    expect(status).toMatchObject({ period: PERIOD, confirmDays: 5, confirmDeadlineAt: "2026-12-07T10:00:00.000Z" });
    const alice = status.participants.find((row) => row.accountId === ALICE);
    const boris = status.participants.find((row) => row.accountId === BORIS);
    expect(alice).toMatchObject({ name: "Алиса", owedRub: "15980.40", paidRub: "1000.00", remainingRub: "14980.40", confirmation: { status: "confirmed" }, gate: { state: "free" }, canPay: true, needsReason: false });
    expect(boris).toMatchObject({ owedRub: "5000.00", paidRub: "0.00", confirmation: { status: "disputed", comment: "Не согласен" }, gate: { state: "override" }, canPay: true, needsReason: true });
    expect(boris?.reason).toContain("оспорил");
  });

  it("статус: молчит в срок — «ждём» и платить нельзя; после срока — можно, но с причиной; полностью выплаченному платить нечего", async () => {
    const { repository, service } = setup();
    repository.balances.set(aliceDebt, ALICE_OWED);

    const waiting = await service.status(PERIOD, DAY_2);
    expect(waiting.participants.find((row) => row.accountId === ALICE)).toMatchObject({ gate: { state: "wait" }, canPay: false, needsReason: false });

    const late = await service.status(PERIOD, DAY_6);
    expect(late.participants.find((row) => row.accountId === ALICE)).toMatchObject({ gate: { state: "override" }, canPay: true, needsReason: true });

    repository.payoutRows.push({ operationId: "op-1", period: PERIOD, payee: `stakeholder:${ALICE}`, accountId: aliceDebt, currency: "RUB", minor: ALICE_OWED, overrideReason: "уехал", at: DAY_6 });
    const done = await service.status(PERIOD, DAY_6);
    expect(done.participants.find((row) => row.accountId === ALICE)).toMatchObject({ remainingRub: "0.00", canPay: false });
  });

  it("статус не закрытого месяца — 409, а не пустая таблица", async () => {
    const { repository, service } = setup();
    repository.setStatus(PERIOD, "review");
    expect((await failure(service.status(PERIOD, DAY_2))).code).toBe("ledger_period_status");
  });
});

// ---- Сообщения участнику ----

describe("сообщения участнику: отчёт готов, выплачено, отчёт отозван", () => {
  function setup() {
    const repository = new MemoryPayoutsRepository();
    repository.close(PERIOD, snapshotOf({ payouts: [{ accountId: ALICE, rubMinor: ALICE_OWED }, { accountId: BORIS, rubMinor: 0n }] }), CLOSED_AT);
    const notifications = memoryNotifications();
    const chat: string[] = [];
    const notices = new PayoutNotices(notifications.service, repository, { send: async (text: string) => void chat.push(text) });
    return { repository, notifications, notices, chat };
  }

  it("отчёт готов: сообщение получает участник с долгом, а с нулём — нет; ключ — месяц, аккаунт и раз закрытия", async () => {
    const { notifications, notices } = setup();

    expect(await notices.reportReady(PERIOD, 0)).toBe(1);

    expect(notifications.repository.of(ALICE)).toEqual([{ kind: "finance_report", payload: { period: PERIOD, state: "ready", amountRub: "15980.40", reason: null } }]);
    expect(notifications.repository.of(BORIS)).toEqual([]);
    expect(notifications.repository.rows[0]?.dedupeKey).toBe(`finance:report:${PERIOD}:${ALICE}:0`);
  });

  it("повтор того же закрытия второго сообщения не заводит; закрытие после снятия (следующий раз) — заводит", async () => {
    const { repository, notifications, notices } = setup();
    await notices.reportReady(PERIOD, 0);

    expect(await notices.reportReady(PERIOD, 0)).toBe(0);
    expect(notifications.repository.rows).toHaveLength(1);

    repository.close(PERIOD, snapshotOf({ round: 1 }), CLOSED_AT, 1);
    expect(await notices.reportReady(PERIOD, 1)).toBe(1);
    expect(notifications.repository.rows.map((row) => row.dedupeKey)).toEqual([`finance:report:${PERIOD}:${ALICE}:0`, `finance:report:${PERIOD}:${ALICE}:1`]);
  });

  it("закрытие без долгов участникам — писать некому, и это не ошибка", async () => {
    const { repository, notifications, notices } = setup();
    repository.close(PERIOD, snapshotOf({ payouts: [] }), CLOSED_AT);
    expect(await notices.reportReady(PERIOD, 0)).toBe(0);
    expect(notifications.repository.rows).toEqual([]);
  });

  it("отозван: получают те, кому отчёт отправляли, — по ключам проводок закрытия; причина — в сообщении", async () => {
    const { repository, notifications, notices } = setup();
    repository.closeKeys.push({ period: PERIOD, round: 0, accountId: ALICE });

    expect(await notices.recalled(PERIOD, 0, "Ошибка в курсе рубля")).toBe(1);

    expect(notifications.repository.of(ALICE)).toEqual([{ kind: "finance_report", payload: { period: PERIOD, state: "recalled", amountRub: null, reason: "Ошибка в курсе рубля" } }]);
    expect(notifications.repository.rows[0]?.dedupeKey).toBe(`finance:report:${PERIOD}:${ALICE}:0:recalled`);
    expect(await notices.recalled(PERIOD, 0, "Ошибка в курсе рубля")).toBe(0);
  });

  it("выплачено: участнику — сообщение с суммой, ключ — операция; повтор не пишет второе; владельцу, налогу и займу не пишем", async () => {
    const { notifications, notices } = setup();

    expect(await notices.paid(OP_ID, PAYOUT)).toBe(true);
    expect(await notices.paid(OP_ID, PAYOUT)).toBe(false);

    expect(notifications.repository.of(ALICE)).toEqual([{ kind: "finance_payout", payload: { period: PERIOD, amountRub: "15980.40" } }]);
    expect(notifications.repository.rows[0]?.dedupeKey).toBe(`finance:payout:${OP_ID}`);
    for (const payee of ["owner", "tax", `loan:${LOAN_ID}`]) expect(await notices.paid(`${OP_ID}-${payee}`, { ...PAYOUT, payee }), payee).toBe(false);
    expect(notifications.repository.rows).toHaveLength(1);
  });

  it("сбой ленты сообщение не роняет: уведомитель не бросает, а сообщает, что не вышло", async () => {
    const { notifications, notices } = setup();
    notifications.repository.insert = async () => {
      throw new Error("лента недоступна");
    };
    await expect(notices.reportReady(PERIOD, 0)).resolves.toBe(0);
    await expect(notices.paid(OP_ID, PAYOUT)).resolves.toBe(false);
  });

  it("данные уведомлений проверяются схемой вида: сумма — десятичная строка, месяц — «ГГГГ-ММ»", () => {
    const report = NOTIFICATION_KINDS.finance_report;
    expect(report.safeParse({ period: PERIOD, state: "ready", amountRub: "15980.40", reason: null }).success).toBe(true);
    expect(report.safeParse({ period: PERIOD, state: "recalled", amountRub: null, reason: "Ошибка" }).success).toBe(true);
    expect(report.safeParse({ period: "2026-13", state: "ready", amountRub: "1.00", reason: null }).success).toBe(false);
    expect(report.safeParse({ period: PERIOD, state: "unknown", amountRub: "1.00", reason: null }).success).toBe(false);
    expect(report.safeParse({ period: PERIOD, state: "ready", amountRub: "15 980,40", reason: null }).success).toBe(false);
    const payout = NOTIFICATION_KINDS.finance_payout;
    expect(payout.safeParse({ period: PERIOD, amountRub: "15980.40" }).success).toBe(true);
    expect(payout.safeParse({ period: PERIOD, amountRub: "-1.00" }).success).toBe(false);
  });
});

describe("текст в бота: на «ты», суммы по-русски, правила как у сообщения команды", () => {
  const launch = (): string | null => "https://t.me/rubezh_bot/play?startapp=n-x";

  it("отчёт готов", () => {
    const message = botMessageOf("finance_report", { period: PERIOD, state: "ready", amountRub: "15980.40", reason: null }, launch);
    expect(message?.text).toBe("Отчёт за ноябрь готов: твоя часть — 15 980,40 ₽. Подтверди в панели — без подтверждения выплата ждёт.");
  });

  it("выплачено", () => {
    expect(botMessageOf("finance_payout", { period: PERIOD, amountRub: "15980.40" }, launch)?.text).toBe("Выплачено 15 980,40 ₽ за ноябрь.");
  });

  it("отозван на пересчёт: с причиной", () => {
    expect(botMessageOf("finance_report", { period: PERIOD, state: "recalled", amountRub: null, reason: "Ошибка в курсе рубля" }, launch)?.text).toBe("Отчёт за ноябрь отозван на пересчёт: Ошибка в курсе рубля.");
  });

  it("суммы группируются по тысячам; месяц — по номеру в имени", () => {
    expect(botMessageOf("finance_payout", { period: "2026-03", amountRub: "950.00" }, launch)?.text).toBe("Выплачено 950,00 ₽ за март.");
    expect(botMessageOf("finance_payout", { period: "2027-12", amountRub: "1234567.89" }, launch)?.text).toBe("Выплачено 1 234 567,89 ₽ за декабрь.");
  });

  it("данные не по схеме — писать нечего; кнопки «Открыть игру» нет: сообщение про панель, а не про игру", () => {
    expect(botMessageOf("finance_payout", { period: PERIOD }, launch)).toBeNull();
    expect(botMessageOf("finance_report", { period: PERIOD, state: "ready", amountRub: null, reason: null }, launch)).toBeNull();
    expect(botMessageOf("finance_payout", { period: PERIOD, amountRub: "1.00" }, launch)?.button).toBeNull();
  });

  it("правило дубля — то же, что у сообщения команды: ключ игрока, без потолка, не напоминание", () => {
    expect(botRuleOf("finance_report")).toEqual(botRuleOf("team_message"));
    expect(botRuleOf("finance_payout")).toEqual(botRuleOf("team_message"));
    expect(botRuleOf("finance_report")).not.toHaveProperty("reminder");
  });
});

// ---- Хуки месяца ----

describe("хуки месяца: выплаты запрещают снятие закрытия, снятие сбрасывает подтверждения", () => {
  function setup() {
    const repository = new MemoryPayoutsRepository();
    repository.close(PERIOD, snapshotOf(), CLOSED_AT);
    const notifications = memoryNotifications();
    const notices = new PayoutNotices(notifications.service, repository, { send: async () => undefined });
    const locks: string[] = [];
    const lock = {
      run: async <T>(period: string, work: () => Promise<T>) => {
        locks.push(`${period}:begin`);
        try {
          return await work();
        } finally {
          locks.push(`${period}:end`);
        }
      },
    };
    return { repository, notifications, notices, lock, locks, hooks: new PayoutPeriodHooks(repository, notices, lock) };
  }

  it("`hasPayouts`: нет выплат — нет; есть выплата месяца — да; чужого месяца — нет; проводка есть, отметки нет — тоже да", async () => {
    const { repository, hooks } = setup();
    expect(await hooks.hasPayouts(PERIOD)).toBe(false);

    repository.payoutRows.push({ operationId: "op-1", period: "2026-10", payee: "owner", accountId: "equity.owner_draw.RUB", currency: "RUB", minor: 1n, overrideReason: null, at: DAY_2 });
    expect(await hooks.hasPayouts(PERIOD)).toBe(false);

    repository.journaledPayouts.add(`${PERIOD}|op-2`);
    expect(await hooks.hasPayouts(PERIOD)).toBe(true);

    repository.journaledPayouts.clear();
    repository.payoutRows.push({ operationId: "op-3", period: PERIOD, payee: "owner", accountId: "equity.owner_draw.RUB", currency: "RUB", minor: 1n, overrideReason: null, at: DAY_2 });
    expect(await hooks.hasPayouts(PERIOD)).toBe(true);
  });

  it("`resetConfirmations`: подтверждения месяца стираются (чужих месяцев — нет), участникам уходит «отозван» с причиной", async () => {
    const { repository, notifications, hooks } = setup();
    await repository.saveConfirmation(confirmation("confirmed"));
    await repository.saveConfirmation({ period: "2026-10", accountId: ALICE, status: "confirmed", comment: null, decidedAt: DAY_2 });
    repository.closeKeys.push({ period: PERIOD, round: 0, accountId: ALICE });

    await hooks.resetConfirmations(PERIOD, { round: 0, reason: "Ошибка в курсе рубля" });

    expect([...repository.confirmationRows.keys()]).toEqual(["2026-10|" + ALICE]);
    expect(notifications.repository.of(ALICE)).toEqual([{ kind: "finance_report", payload: { period: PERIOD, state: "recalled", amountRub: null, reason: "Ошибка в курсе рубля" } }]);
  });

  it("`resetConfirmations` без причины и раза — просто стирает, сообщений не пишет", async () => {
    const { repository, notifications, hooks } = setup();
    await repository.saveConfirmation(confirmation("confirmed"));
    await hooks.resetConfirmations(PERIOD);
    expect(repository.confirmationRows.size).toBe(0);
    expect(notifications.repository.rows).toEqual([]);
  });

  it("сбой при стирании подтверждений — исключение наружу (сервис месяца его залогирует), а сообщение «отозван» всё равно уходит: отчёт отозван в любом случае", async () => {
    const { repository, notifications, hooks } = setup();
    repository.failClear = true;
    repository.closeKeys.push({ period: PERIOD, round: 0, accountId: ALICE });
    await expect(hooks.resetConfirmations(PERIOD, { round: 0, reason: "Ошибка" })).rejects.toThrow("база недоступна");
    expect(notifications.repository.of(ALICE)).toHaveLength(1);
  });

  it("`closed`: участникам с долгом — «отчёт готов»; `exclusive` берёт замок месяца на всё время работы", async () => {
    const { notifications, hooks, locks } = setup();
    await hooks.closed(PERIOD, 0);
    expect(notifications.repository.of(ALICE)).toHaveLength(1);

    const value = await hooks.exclusive(PERIOD, async () => {
      locks.push("work");
      return 42;
    });
    expect(value).toBe(42);
    expect(locks).toEqual([`${PERIOD}:begin`, "work", `${PERIOD}:end`]);
  });
});

describe("порт выплат для операций", () => {
  it("факты, замок и сообщение «выплачено» — одним объектом, замок на месяц выплаты", async () => {
    const repository = new MemoryPayoutsRepository();
    repository.close(PERIOD, snapshotOf(), CLOSED_AT);
    repository.balances.set(aliceDebt, ALICE_OWED);
    const notifications = memoryNotifications();
    const notices = new PayoutNotices(notifications.service, repository, { send: async () => undefined });
    const taken: string[] = [];
    const support = new PayoutSupportService(repository, panelSettings(), { run: async <T>(period: string, work: () => Promise<T>) => (taken.push(period), await work()) }, notices);

    expect(await support.exclusive(PERIOD, async () => "ok")).toBe("ok");
    expect(taken).toEqual([PERIOD]);
    expect(await support.facts(PAYOUT, DAY_2)).toMatchObject({ periodStatus: "closed", owed: ALICE_OWED });
    await support.announcePaid(OP_ID, PAYOUT);
    expect(notifications.repository.of(ALICE)).toHaveLength(1);
  });
});
