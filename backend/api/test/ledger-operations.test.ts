import { randomUUID } from "node:crypto";
import { Decimal, rateOf, type CurrencyCode, type Rate, type RatesSnapshot } from "@bh/fx";
import { findEntryProblems, periodOf, reverse as reverseEntry, type EntryLine, type LedgerAccount } from "@bh/ledger";
import { describe, expect, it } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import type { ArticleView, FeeTemplate, PlaceView } from "../src/modules/ledger/ledger-chart.js";
import type { LedgerChartService } from "../src/modules/ledger/ledger-chart.service.js";
import { LedgerAlreadyReversedError, LedgerEntryInvalidError, LedgerEntryNotFoundError, LedgerSourceConflictError } from "../src/modules/ledger/ledger-errors.js";
import { describeProblem } from "../src/modules/ledger/ledger-problems.js";
import type { LedgerPostInput, LedgerService, PostResult } from "../src/modules/ledger/ledger.service.js";
import {
  applyFeeTemplate,
  buildOperation,
  receiptMissingOf,
  type BuildResult,
  type BuiltOperation,
  type ChartArticle,
  type ChartPlace,
  type OperationsChart,
  type ServiceAccount,
} from "../src/modules/ledger/operations/builders.js";
import { operationInputSchema, type BuildableInput, type OperationInput, type OperationInputOf } from "../src/modules/ledger/operations/operation-input.js";
import type {
  DraftPatch,
  InsertOutcome,
  NewLoan,
  NewOperation,
  OperationFilter,
  OperationsRepository,
  PostedOutcome,
  StoredEntryLine,
  StoredLoan,
  StoredOperation,
  StoredOperationEntry,
} from "../src/modules/ledger/operations/operations.repository.js";
import { OperationsService, type OperationActor } from "../src/modules/ledger/operations/operations.service.js";
import type { OperationApprovals } from "../src/modules/ledger/operations/approval.js";
import type { MediaService } from "../src/modules/media/media.service.js";
import type { FxService } from "../src/modules/fx/fx.service.js";
import type { AuditEntry } from "../src/modules/roles/roles.repository.js";
import type { RolesService } from "../src/modules/roles/roles.service.js";

/**
 * Ручные операции учёта (Р220, Р221, tasks/T-0461; docs/37-accounting.md §4, §6, §12). Три слоя:
 * сборщики проводок — чистые функции, проверяются на справочнике в памяти и ядром учёта (`findEntryProblems`);
 * схема тела операции — строгая; сервис — на подменённых репозитории, журнале и курсах: черновик, проведение,
 * идемпотентность, сторно. Как это ложится на таблицы и гонки базы — `ledger-operations.integration.test.ts`.
 */

const NOW = new Date("2026-11-13T12:00:00Z");
const NO_FEE: FeeTemplate = { percentBp: null, fixed: null, fixedCurrency: null };

// ---- Справочник для сборщиков ----

function place(accountId: string, name: string, currency: string, options: { fee?: FeeTemplate; archived?: boolean; group?: string } = {}): [string, ChartPlace] {
  return [accountId, { accountId, name, currency, place: options.group ?? accountId, archived: options.archived ?? false, fee: options.fee ?? NO_FEE }];
}

function article(articleId: string, name: string, kind: "expense" | "income", archived = false): [string, ChartArticle] {
  return [articleId, { articleId, name, kind, archived }];
}

/** Места на старте и несколько заведённых из панели: у звёзд — шаблон «1 % + 0,05 Gram», у биржи — «0,5 %». */
const STARS_TEMPLATE: FeeTemplate = { percentBp: 100, fixed: 50_000_000n, fixedCurrency: "GRAM" };

const PLACES: [string, ChartPlace][] = [
  place("stars.bot.hold", "Звёзды бота — в холде", "XTR", { group: "stars.bot" }),
  place("stars.bot.available", "Звёзды бота — доступно", "XTR", { group: "stars.bot", fee: STARS_TEMPLATE }),
  place("wallet.ton", "Кошелёк TON", "GRAM"),
  place("exchange.usdt", "Биржа или USDT", "USDT", { fee: { percentBp: 50, fixed: null, fixedCurrency: null } }),
  place("wallet.usdt-ton", "Кошелёк USDT", "USDT"),
  place("bank.rub", "Банк, ₽", "RUB"),
  place("bank.tbank", "Карта Т-Банка", "RUB"),
  place("bank.old", "Старый счёт", "RUB", { archived: true }),
];

const ARTICLES: [string, ChartArticle][] = [
  article("vps", "Сервер (VPS)", "expense"),
  article("fee_withdrawal", "Комиссия вывода", "expense"),
  article("fee_exchange", "Комиссия обмена", "expense"),
  article("old_costs", "Старые расходы", "expense", true),
  article("ads_adsgram", "Реклама: AdsGram", "income"),
];

function chartWith(options: { without?: string[]; extraPlaces?: [string, ChartPlace][] } = {}): OperationsChart {
  const skipped = new Set(options.without ?? []);
  return {
    places: new Map([...PLACES, ...(options.extraPlaces ?? [])].filter(([id]) => !skipped.has(id))),
    articles: new Map(ARTICLES),
  };
}

const CHART = chartWith();
const OP_ID = "6f1d3c52-5a0e-4a8e-9d57-0c6f0a2d9b11";

const BASE = { note: "Оплата сервера за ноябрь", at: "2026-11-10" };

/** Все счета, о которых проводка говорит: места плана, статьи в валютах и служебные счета сборки. */
function accountsOf(built: BuiltOperation): Map<string, LedgerAccount> {
  const accounts = new Map<string, LedgerAccount>();
  for (const [, item] of PLACES) accounts.set(item.accountId, { id: item.accountId, type: "asset", currency: item.currency, name: item.name });
  for (const need of built.articleAccounts) {
    const found = ARTICLES.find(([id]) => id === need.articleId)?.[1];
    if (found === undefined) throw new Error(`в справочнике теста нет статьи ${need.articleId}`);
    const id = `${found.kind}.${found.articleId}.${need.currency}`;
    accounts.set(id, { id, type: found.kind === "expense" ? "expense" : "revenue", currency: need.currency, name: id });
  }
  for (const service of built.serviceAccounts) accounts.set(service.accountId, { id: service.accountId, type: service.type, currency: service.currency, name: service.name });
  return accounts;
}

/** Собрать и убедиться, что проводка проходит проверку ядра учёта: баланс в каждой валюте, ни нулевых, ни повторных строк. */
function built(input: BuildableInput, chart: OperationsChart = CHART): BuiltOperation {
  const result = buildOperation(OP_ID, input, chart, NOW);
  if (!result.ok) throw new Error(`ожидалась проводка, а сборка отказала: ${result.problems.map((problem) => problem.message).join("; ")}`);
  expect(findEntryProblems(result.built.draft, accountsOf(result.built))).toEqual([]);
  return result.built;
}

function problemsOf(input: BuildableInput, chart: OperationsChart = CHART): string[] {
  const result: BuildResult = buildOperation(OP_ID, input, chart, NOW);
  if (result.ok) throw new Error("ожидались проблемы, а сборка прошла");
  return result.problems.map((problem) => problem.message);
}

function linesOf(draft: LedgerPostInput): Record<string, bigint> {
  return Object.fromEntries(draft.lines.map((line) => [line.accountId, line.amount]));
}

describe("сборщики проводок: перевод", () => {
  it("перевод с процентной комиссией: списание с суммой и комиссией, зачисление, статья «Комиссия вывода»", () => {
    const result = built({ kind: "transfer", ...BASE, from: "bank.rub", to: "bank.tbank", amount: "1000", fee: { amount: "15" } });

    expect(linesOf(result.draft)).toEqual({ "bank.rub": -101_500n, "bank.tbank": 100_000n, "expense.fee_withdrawal.RUB": 1_500n });
    expect(result.draft.sourceKey).toBe(`op:${OP_ID}`);
    expect(result.draft.memo).toBe(BASE.note);
    expect(result.draft.at).toEqual(new Date("2026-11-10T00:00:00Z"));
    expect(result.articleAccounts).toEqual([{ articleId: "fee_withdrawal", currency: "RUB" }]);
    expect(result.draft.meta).toMatchObject({ operation: OP_ID, kind: "transfer", fee: "15.00 RUB" });
  });

  it("перевод без комиссии — две строки", () => {
    const result = built({ kind: "transfer", ...BASE, from: "bank.rub", to: "bank.tbank", amount: "2500.50" });

    expect(linesOf(result.draft)).toEqual({ "bank.rub": -250_050n, "bank.tbank": 250_050n });
    expect(result.articleAccounts).toEqual([]);
  });

  it("процент в валюте перевода и фикса в другой валюте: фикса — отдельная пара строк на месте этой валюты", () => {
    const result = built({
      kind: "transfer",
      ...BASE,
      from: "exchange.usdt",
      to: "wallet.usdt-ton",
      amount: "200.5",
      fee: { amount: "1.0025", fixed: { amount: "0.05", currency: "GRAM" } },
    });

    expect(linesOf(result.draft)).toEqual({
      "exchange.usdt": -201_502_500n,
      "wallet.usdt-ton": 200_500_000n,
      "expense.fee_withdrawal.USDT": 1_002_500n,
      "wallet.ton": -50_000_000n,
      "expense.fee_withdrawal.GRAM": 50_000_000n,
    });
    expect(result.articleAccounts).toEqual([
      { articleId: "fee_withdrawal", currency: "USDT" },
      { articleId: "fee_withdrawal", currency: "GRAM" },
    ]);
    // В проводке — фактическая комиссия, рядом — шаблон места списания (docs/37 §6).
    expect(result.draft.meta).toMatchObject({ fee: "1.002500 USDT + 0.050000000 GRAM", feeTemplate: "0.5%" });
  });

  it("фикса в той же валюте, что у перевода, складывается с процентом в одну строку комиссии", () => {
    const result = built({ kind: "transfer", ...BASE, from: "bank.rub", to: "bank.tbank", amount: "1000", fee: { amount: "10", fixed: { amount: "5", currency: "RUB" } } });

    expect(linesOf(result.draft)).toEqual({ "bank.rub": -101_500n, "bank.tbank": 100_000n, "expense.fee_withdrawal.RUB": 1_500n });
  });

  it("нет места в валюте фиксы — проблема «нет места в валюте фиксы»", () => {
    const chart = chartWith({ without: ["wallet.ton"] });

    const problems = problemsOf({ kind: "transfer", ...BASE, from: "exchange.usdt", to: "wallet.usdt-ton", amount: "100", fee: { fixed: { amount: "0.05", currency: "GRAM" } } }, chart);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Нет места в валюте фиксы GRAM");
  });

  it("несколько мест в валюте фиксы — выбор за человеком; с указанным местом проводка собирается", () => {
    const chart = chartWith({ extraPlaces: [place("wallet.ton-2", "Второй кошелёк TON", "GRAM")] });
    const fee = { fixed: { amount: "0.05", currency: "GRAM" as const } };

    const ambiguous = problemsOf({ kind: "transfer", ...BASE, from: "exchange.usdt", to: "wallet.usdt-ton", amount: "100", fee }, chart);
    expect(ambiguous[0]).toContain("несколько мест");

    const chosen = buildOperation(OP_ID, { kind: "transfer", ...BASE, from: "exchange.usdt", to: "wallet.usdt-ton", amount: "100", fee: { fixed: { ...fee.fixed, from: "wallet.ton-2" } } }, chart, NOW);
    expect(chosen.ok).toBe(true);
    if (chosen.ok) expect(linesOf(chosen.built.draft)).toMatchObject({ "wallet.ton-2": -50_000_000n });
  });

  it("фикса со своим местом в другой валюте — проблема: место и фикса должны быть в одной валюте", () => {
    const problems = problemsOf({ kind: "transfer", ...BASE, from: "exchange.usdt", to: "wallet.usdt-ton", amount: "100", fee: { fixed: { amount: "0.05", currency: "GRAM", from: "bank.rub" } } });

    expect(problems[0]).toContain("в валюте RUB, а фикса — в GRAM");
  });

  it("перевод между разными валютами, на то же место и в архивное — проблемы с названием места", () => {
    expect(problemsOf({ kind: "transfer", ...BASE, from: "bank.rub", to: "wallet.ton", amount: "100" })[0]).toContain("есть обмен");
    expect(problemsOf({ kind: "transfer", ...BASE, from: "bank.rub", to: "bank.rub", amount: "100" })[0]).toContain("одно и то же место");
    expect(problemsOf({ kind: "transfer", ...BASE, from: "bank.rub", to: "bank.old", amount: "100" })[0]).toContain("«Старый счёт» в архиве");
    expect(problemsOf({ kind: "transfer", ...BASE, from: "bank.net", to: "bank.rub", amount: "100" })[0]).toContain("«bank.net» нет");
  });
});

describe("сборщики проводок: обмен", () => {
  it("вывод звёзд на кошелёк: каждая валюта сходится через транзит обмена, курс — частное двух сумм", () => {
    const result = built({
      kind: "exchange",
      ...BASE,
      note: "Вывод 10 000 ⭐ через Fragment",
      from: "stars.bot.available",
      to: "wallet.ton",
      given: "10000",
      received: "52.3",
      fee: { amount: "100", fixed: { amount: "0.05", currency: "GRAM" } },
    });

    expect(linesOf(result.draft)).toEqual({
      "stars.bot.available": -10_100n,
      "exchange.transit.XTR": 10_000n,
      "expense.fee_exchange.XTR": 100n,
      "exchange.transit.GRAM": -52_300_000_000n,
      // Фикса в Gram списана с кошелька, куда пришли Gram: ему остаётся полученное за вычетом фиксы.
      "wallet.ton": 52_250_000_000n,
      "expense.fee_exchange.GRAM": 50_000_000n,
    });
    expect(result.serviceAccounts.map((account) => [account.accountId, account.type, account.currency])).toEqual([
      ["exchange.transit.XTR", "asset", "XTR"],
      ["exchange.transit.GRAM", "asset", "GRAM"],
    ]);
    expect(result.draft.meta).toMatchObject({ kind: "exchange", rate: "0.00523", ratePair: "XTR→GRAM", feeTemplate: "1% + 0.050000000 GRAM" });
  });

  it("обмен в одной валюте — проблема: для неё есть перевод; нулевая и дробная сумма — проблемы", () => {
    expect(problemsOf({ kind: "exchange", ...BASE, from: "bank.rub", to: "bank.tbank", given: "100", received: "100" })[0]).toContain("для одной валюты есть перевод");
    expect(problemsOf({ kind: "exchange", ...BASE, from: "stars.bot.available", to: "wallet.ton", given: "0", received: "5" })[0]).toContain("Отдано: сумма должна быть больше нуля");
    expect(problemsOf({ kind: "exchange", ...BASE, from: "stars.bot.available", to: "wallet.ton", given: "10.5", received: "5" })[0]).toContain("Отдано");
  });
});

describe("сборщики проводок: расход, поступление, заём", () => {
  it("расход: оплата сервера 1 500 ₽ — место минус, статья расхода в рублях плюс", () => {
    const result = built({ kind: "expense", ...BASE, from: "bank.rub", article: "vps", amount: "1500" });

    expect(linesOf(result.draft)).toEqual({ "bank.rub": -150_000n, "expense.vps.RUB": 150_000n });
    expect(result.articleAccounts).toEqual([{ articleId: "vps", currency: "RUB" }]);
    expect(result.estimate).toEqual([{ currency: "RUB", minor: 150_000n }]);
  });

  it("расход: статья не того вида, архивная или несуществующая — проблема", () => {
    expect(problemsOf({ kind: "expense", ...BASE, from: "bank.rub", article: "ads_adsgram", amount: "1" })[0]).toContain("не из статей расходов");
    expect(problemsOf({ kind: "expense", ...BASE, from: "bank.rub", article: "old_costs", amount: "1" })[0]).toContain("в архиве");
    expect(problemsOf({ kind: "expense", ...BASE, from: "bank.rub", article: "net", amount: "1" })[0]).toContain("«net» нет");
  });

  it("поступление: выплата сети — место плюс, статья поступления минус, «за какой месяц» — в примечании проводки", () => {
    const result = built({ kind: "income", ...BASE, to: "bank.rub", article: "ads_adsgram", amount: "120.40", forMonth: "2026-10" });

    expect(linesOf(result.draft)).toEqual({ "bank.rub": 12_040n, "income.ads_adsgram.RUB": -12_040n });
    expect(result.draft.meta).toMatchObject({ forMonth: "2026-10" });
  });

  it("поступление: месяц позже месяца даты операции — проблема, тот же месяц и раньше — можно", () => {
    expect(problemsOf({ kind: "income", ...BASE, to: "bank.rub", article: "ads_adsgram", amount: "1", forMonth: "2026-12" })[0]).toContain("позже месяца даты");
    expect(buildOperation(OP_ID, { kind: "income", ...BASE, to: "bank.rub", article: "ads_adsgram", amount: "1", forMonth: periodOf(new Date(BASE.at)) }, CHART, NOW).ok).toBe(true);
    expect(buildOperation(OP_ID, { kind: "income", ...BASE, at: "2026-11-02", to: "bank.rub", article: "ads_adsgram", amount: "1", forMonth: "2026-09" }, CHART, NOW).ok).toBe(true);
  });

  it("заём: место плюс, счёт-обязательство «Заём: кредитор» минус, условия — для строки займа", () => {
    const result = built({ kind: "loan", ...BASE, note: "Заём на закупку рекламы", to: "bank.rub", lender: "Иван Петров", amount: "100000", premium: "10000", repaymentBp: 2500 });

    expect(linesOf(result.draft)).toEqual({ "bank.rub": 10_000_000n, "loan.ivan-petrov.RUB": -10_000_000n });
    expect(result.serviceAccounts).toEqual([{ accountId: "loan.ivan-petrov.RUB", type: "liability", currency: "RUB", name: "Заём: Иван Петров" }]);
    expect(result.loan).toEqual({ lender: "Иван Петров", accountId: "loan.ivan-petrov.RUB", currency: "RUB", principal: 10_000_000n, premium: 1_000_000n, repaymentBp: 2500 });
    expect(result.draft.meta).toMatchObject({ lender: "Иван Петров", premium: "10000.00", repaymentBp: 2500 });
  });

  it("заём: кредитор без букв, премия с лишними знаками и ставка вне 0…10 000 — проблемы", () => {
    expect(problemsOf({ kind: "loan", ...BASE, to: "bank.rub", lender: "!!", amount: "100", premium: "0", repaymentBp: 100 })[0]).toContain("Кредитор");
    expect(problemsOf({ kind: "loan", ...BASE, to: "bank.rub", lender: "Иван Петров", amount: "100", premium: "0.001", repaymentBp: 100 })[0]).toContain("Премия");
    expect(problemsOf({ kind: "loan", ...BASE, to: "bank.rub", lender: "Иван Петров", amount: "100", premium: "0", repaymentBp: 10_001 })[0]).toContain("Ставка погашения");
  });
});

describe("сборщики проводок: общие правила", () => {
  const expense = (overrides: Partial<OperationInputOf<"expense">>): OperationInputOf<"expense"> => ({ kind: "expense", ...BASE, from: "bank.rub", article: "vps", amount: "1500", ...overrides });

  it("сумма с лишними знаками — проблема, округлять нечем: у рубля два знака, у звезды ни одного", () => {
    expect(problemsOf(expense({ amount: "1500.005" }))[0]).toContain("длиннее 2 знаков");
    expect(problemsOf({ kind: "expense", ...BASE, from: "stars.bot.hold", article: "vps", amount: "10.5" })[0]).toContain("длиннее 0 знаков");
    // Нули сверх знаков валюты допустимы: «1500.00» — те же полторы тысячи.
    expect(buildOperation(OP_ID, expense({ amount: "1500.000" }), CHART, NOW).ok).toBe(true);
  });

  it("нулевая, отрицательная и непосильно большая сумма — проблемы", () => {
    expect(problemsOf(expense({ amount: "0" }))[0]).toContain("больше нуля");
    expect(problemsOf(expense({ amount: "-5" }))[0]).toContain("больше нуля");
    expect(problemsOf(expense({ amount: "999999999999999999" }))[0]).toContain("слишком велика");
  });

  it("дата в будущем — проблема; раньше 2026 года и несуществующий день — тоже", () => {
    expect(problemsOf(expense({ at: "2026-11-14" }))[0]).toContain("в будущем");
    expect(problemsOf(expense({ at: "2026-11-13T12:00:01Z" }))[0]).toContain("в будущем");
    expect(problemsOf(expense({ at: "2025-12-31" }))[0]).toContain("раньше 1 января 2026");
    expect(problemsOf(expense({ at: "2026-02-31" }))[0]).toContain("не существует");
    expect(buildOperation(OP_ID, expense({ at: "2026-11-13T11:59:00Z" }), CHART, NOW).ok).toBe(true);
    expect(buildOperation(OP_ID, expense({ at: "2026-01-01" }), CHART, NOW).ok).toBe(true);
  });

  it("проблемы собираются разом: неизвестное место, неверная дата и неизвестная статья — три сообщения, а не первое", () => {
    const problems = problemsOf(expense({ from: "bank.net", article: "net", at: "2026-11-14" }));

    expect(problems).toHaveLength(3);
  });

  it("ссылка и причина доезжают в примечание проводки, повтор сборки даёт те же строки (ключ `op:<id>`)", () => {
    const first = built(expense({ link: "https://example.com/check/1" }));
    const second = built(expense({ link: "https://example.com/check/1" }));

    expect(first.draft.meta).toMatchObject({ link: "https://example.com/check/1" });
    expect(first.draft).toEqual(second.draft);
  });
});

describe("чек НПД (Р221)", () => {
  const income = (overrides: Partial<OperationInputOf<"income">>): OperationInputOf<"income"> => ({ kind: "income", ...BASE, to: "bank.rub", article: "ads_adsgram", amount: "5000", forMonth: "2026-10", ...overrides });

  it("поступление в рубли без чека проводится, но помечено: receiptMissing", () => {
    const result = built(income({}));

    expect(result.receiptMissing).toBe(true);
    expect(receiptMissingOf(income({}), CHART)).toBe(true);
  });

  it("с чеком — не помечено, плательщик, номер и ссылка пишутся в проводку", () => {
    const input = income({ receipt: { payer: "legal", number: "2026-11-ab12", link: "https://lknpd.nalog.ru/check/1" } });
    const result = built(input);

    expect(result.receiptMissing).toBe(false);
    expect(result.draft.meta).toMatchObject({ receiptPayer: "legal", receiptNumber: "2026-11-ab12", receiptLink: "https://lknpd.nalog.ru/check/1" });
  });

  it("чек только с плательщиком допустим: картинку чека прикладывают отдельно", () => {
    expect(built(income({ receipt: { payer: "individual" } })).receiptMissing).toBe(false);
  });

  it("зачисление в другую валюту чека не требует; чек у него — проблема", () => {
    const usdt = income({ to: "wallet.usdt-ton", amount: "10" });

    expect(built(usdt).receiptMissing).toBe(false);
    expect(problemsOf(income({ to: "wallet.usdt-ton", amount: "10", receipt: { payer: "individual" } }))[0]).toContain("при зачислении в рубли");
  });

  it("обмен на рублёвое место без чека помечен, на валютное — нет; расход, перевод и заём чека не требуют", () => {
    const exchangeToRub = { kind: "exchange", ...BASE, from: "exchange.usdt", to: "bank.rub", given: "100", received: "9000" } satisfies OperationInputOf<"exchange">;
    const exchangeToTon = { kind: "exchange", ...BASE, from: "stars.bot.available", to: "wallet.ton", given: "100", received: "0.5" } satisfies OperationInputOf<"exchange">;

    expect(built(exchangeToRub).receiptMissing).toBe(true);
    expect(built({ ...exchangeToRub, receipt: { payer: "individual", number: "1" } }).receiptMissing).toBe(false);
    expect(built(exchangeToTon).receiptMissing).toBe(false);
    expect(built({ kind: "expense", ...BASE, from: "bank.rub", article: "vps", amount: "1" }).receiptMissing).toBe(false);
    expect(built({ kind: "transfer", ...BASE, from: "bank.rub", to: "bank.tbank", amount: "1" }).receiptMissing).toBe(false);
    expect(built({ kind: "loan", ...BASE, to: "bank.rub", lender: "Иван Петров", amount: "1", premium: "0", repaymentBp: 0 }).receiptMissing).toBe(false);
    expect(receiptMissingOf({ kind: "reversal", ...BASE, sourceKey: "purchase:1:paid" }, CHART)).toBe(false);
  });
});

describe("комиссия по шаблону места списания", () => {
  const exchange = (overrides: Partial<OperationInputOf<"exchange">> = {}): OperationInputOf<"exchange"> => ({
    kind: "exchange",
    ...BASE,
    from: "stars.bot.available",
    to: "wallet.ton",
    given: "10000",
    received: "52.3",
    ...overrides,
  });

  it("не задана — подставляется шаблон: процент и фикса в своей валюте, процент округлён вверх", () => {
    const applied = applyFeeTemplate(exchange(), CHART);

    expect(applied).toMatchObject({ fee: { amount: "100", fixed: { amount: "0.050000000", currency: "GRAM" } } });
    // 1 % от 99 звёзд — 0,99, комиссию не занижаем: одна звезда.
    expect(applyFeeTemplate(exchange({ given: "99" }), CHART)).toMatchObject({ fee: { amount: "1" } });
  });

  it("фикса в чужой валюте закрепляется за единственным местом этой валюты: второе место потом не сделает черновик неоднозначным", () => {
    const pinned = applyFeeTemplate(exchange(), CHART);
    const explicit = applyFeeTemplate(exchange({ fee: { fixed: { amount: "0.05", currency: "GRAM" } } }), CHART);

    expect(pinned).toMatchObject({ fee: { fixed: { from: "wallet.ton" } } });
    expect(explicit).toMatchObject({ fee: { fixed: { amount: "0.05", currency: "GRAM", from: "wallet.ton" } } });

    // Закреплённый черновик собирается и после появления второго кошелька, а незакреплённый — нет.
    const grown = chartWith({ extraPlaces: [place("wallet.ton-2", "Второй кошелёк TON", "GRAM")] });
    expect(buildOperation(OP_ID, pinned as BuildableInput, grown, NOW).ok).toBe(true);
    expect(buildOperation(OP_ID, exchange({ fee: { fixed: { amount: "0.05", currency: "GRAM" } } }), grown, NOW).ok).toBe(false);
  });

  it("закреплять нечего или некого: место названо, валюта та же, мест нет или несколько — фикса остаётся как есть", () => {
    const named = exchange({ fee: { fixed: { amount: "0.05", currency: "GRAM", from: "wallet.ton" } } });
    const sameCurrency = exchange({ fee: { fixed: { amount: "5", currency: "XTR" } } });
    const none = exchange({ fee: { fixed: { amount: "0.05", currency: "GRAM" } } });
    const many = exchange({ fee: { fixed: { amount: "0.05", currency: "GRAM" } } });

    expect(applyFeeTemplate(named, CHART)).toBe(named);
    expect(applyFeeTemplate(sameCurrency, CHART)).toBe(sameCurrency);
    expect(applyFeeTemplate(none, chartWith({ without: ["wallet.ton"] }))).toBe(none);
    expect(applyFeeTemplate(many, chartWith({ extraPlaces: [place("wallet.ton-2", "Второй кошелёк TON", "GRAM")] }))).toBe(many);
  });

  it("задана — остаётся как есть, в том числе пустая: «комиссии нет, хотя шаблон есть»", () => {
    const explicit = exchange({ fee: { amount: "7" } });
    const none = exchange({ fee: {} });

    expect(applyFeeTemplate(explicit, CHART)).toBe(explicit);
    expect(applyFeeTemplate(none, CHART)).toBe(none);
    expect(built(none).draft.meta).not.toHaveProperty("fee");
  });

  it("у места нет шаблона, место неизвестно или сумма неверна — ввод не меняется", () => {
    const noTemplate: OperationInputOf<"transfer"> = { kind: "transfer", ...BASE, from: "bank.rub", to: "bank.tbank", amount: "10" };
    const unknown = exchange({ from: "bank.net" });
    const broken = exchange({ given: "abc" });

    expect(applyFeeTemplate(noTemplate, CHART)).toBe(noTemplate);
    expect(applyFeeTemplate(unknown, CHART)).toBe(unknown);
    expect(applyFeeTemplate(broken, CHART)).toBe(broken);
  });

  it("расход, поступление, заём и исправление шаблон не трогает", () => {
    const expense: OperationInput = { kind: "expense", ...BASE, from: "stars.bot.available", article: "vps", amount: "10" };

    expect(applyFeeTemplate(expense, CHART)).toBe(expense);
  });
});

// ---- Схема тела операции ----

describe("схема тела операции: строгая, по виду", () => {
  const VALID: OperationInput[] = [
    { kind: "transfer", ...BASE, from: "bank.rub", to: "bank.tbank", amount: "100", fee: { amount: "1", fixed: { amount: "0.05", currency: "GRAM", from: "wallet.ton" } } },
    { kind: "exchange", ...BASE, from: "stars.bot.available", to: "wallet.ton", given: "10000", received: "52.3", receipt: { payer: "individual", number: "1", link: "https://example.com/c" } },
    { kind: "expense", ...BASE, from: "bank.rub", article: "vps", amount: "1500", link: "https://example.com/pay" },
    { kind: "income", ...BASE, to: "bank.rub", article: "ads_adsgram", amount: "10", forMonth: "2026-10" },
    { kind: "loan", ...BASE, to: "bank.rub", lender: "Иван Петров", amount: "100", premium: "0", repaymentBp: 10_000 },
    { kind: "reversal", ...BASE, sourceKey: "purchase:42:paid" },
  ];

  it.each(VALID.map((input) => [input.kind, input] as const))("%s: правильное тело проходит", (_kind, input) => {
    expect(operationInputSchema.safeParse(input).success).toBe(true);
  });

  it.each(VALID.map((input) => [input.kind, input] as const))("%s: лишнее поле — отказ, а не молчаливое игнорирование", (_kind, input) => {
    expect(operationInputSchema.safeParse({ ...input, extra: 1 }).success).toBe(false);
  });

  it("поле чужого вида — отказ: у расхода нет «received», у перевода — «receipt»", () => {
    expect(operationInputSchema.safeParse({ kind: "expense", ...BASE, from: "bank.rub", article: "vps", amount: "1", received: "1" }).success).toBe(false);
    expect(operationInputSchema.safeParse({ kind: "transfer", ...BASE, from: "bank.rub", to: "bank.tbank", amount: "1", receipt: { payer: "legal" } }).success).toBe(false);
  });

  it("неизвестный вид и тело без вида — отказ", () => {
    expect(operationInputSchema.safeParse({ kind: "payout", ...BASE }).success).toBe(false);
    expect(operationInputSchema.safeParse({ ...BASE, from: "bank.rub" }).success).toBe(false);
  });

  it.each(["-5", "1e3", " 5", "1,5", "", "0x10", "1.", ".5", "+5", "٣"])("сумма «%s» — отказ", (amount) => {
    expect(operationInputSchema.safeParse({ kind: "expense", ...BASE, from: "bank.rub", article: "vps", amount }).success).toBe(false);
  });

  it("причина: короче трёх знаков, длиннее пятисот и из пробелов — отказ; края обрезаются", () => {
    const body = { kind: "expense", at: BASE.at, from: "bank.rub", article: "vps", amount: "1" };

    expect(operationInputSchema.safeParse({ ...body, note: "ab" }).success).toBe(false);
    expect(operationInputSchema.safeParse({ ...body, note: "   " }).success).toBe(false);
    expect(operationInputSchema.safeParse({ ...body, note: "я".repeat(501) }).success).toBe(false);
    expect(operationInputSchema.safeParse({ ...body, note: "я".repeat(500) }).success).toBe(true);
    const trimmed = operationInputSchema.safeParse({ ...body, note: "  Оплата  " });
    expect(trimmed.success && trimmed.data.note).toBe("Оплата");
  });

  it.each(["http://example.com/c", "ftp://example.com", "example.com", "https://", "javascript:alert(1)", `https://example.com/${"a".repeat(500)}`])("ссылка «%s» — отказ", (link) => {
    expect(operationInputSchema.safeParse({ kind: "expense", ...BASE, from: "bank.rub", article: "vps", amount: "1", link }).success).toBe(false);
  });

  it.each(["13.11.2026", "2026-11", "2026-11-13 10:00", "вчера", "2026-11-13T10:00"])("дата события «%s» — отказ", (at) => {
    expect(operationInputSchema.safeParse({ kind: "expense", ...BASE, at, from: "bank.rub", article: "vps", amount: "1" }).success).toBe(false);
  });

  it.each(["2026-11-13", "2026-11-13T10:00Z", "2026-11-13T10:00:30.5+03:00"])("дата события «%s» проходит", (at) => {
    expect(operationInputSchema.safeParse({ kind: "expense", ...BASE, at, from: "bank.rub", article: "vps", amount: "1" }).success).toBe(true);
  });

  it("месяц поступления, ставка погашения, валюта фиксы, плательщик чека и кредитор — границы", () => {
    const income = { kind: "income", ...BASE, to: "bank.rub", article: "ads_adsgram", amount: "1", forMonth: "2026-10" };
    const loan = { kind: "loan", ...BASE, to: "bank.rub", lender: "Иван", amount: "1", premium: "0", repaymentBp: 0 };

    expect(operationInputSchema.safeParse({ ...income, forMonth: "2026-13" }).success).toBe(false);
    expect(operationInputSchema.safeParse({ ...income, forMonth: "2026-1" }).success).toBe(false);
    expect(operationInputSchema.safeParse({ ...income, receipt: { payer: "company" } }).success).toBe(false);
    expect(operationInputSchema.safeParse({ ...loan, repaymentBp: 10_001 }).success).toBe(false);
    expect(operationInputSchema.safeParse({ ...loan, repaymentBp: -1 }).success).toBe(false);
    expect(operationInputSchema.safeParse({ ...loan, repaymentBp: 1.5 }).success).toBe(false);
    expect(operationInputSchema.safeParse({ ...loan, lender: "" }).success).toBe(false);
    expect(operationInputSchema.safeParse({ ...loan, lender: "и".repeat(101) }).success).toBe(false);
    expect(operationInputSchema.safeParse({ kind: "transfer", ...BASE, from: "bank.rub", to: "bank.tbank", amount: "1", fee: { fixed: { amount: "1", currency: "ABC" } } }).success).toBe(false);
    expect(operationInputSchema.safeParse({ kind: "transfer", ...BASE, from: "bank.rub", to: "bank.tbank", amount: "1", fee: { percent: "1" } }).success).toBe(false);
  });

  it("идентификатор места: строчные латиница, цифры, точка, дефис, подчёркивание", () => {
    expect(operationInputSchema.safeParse({ kind: "expense", ...BASE, from: "Bank RUB", article: "vps", amount: "1" }).success).toBe(false);
    expect(operationInputSchema.safeParse({ kind: "expense", ...BASE, from: "a".repeat(65), article: "vps", amount: "1" }).success).toBe(false);
  });
});

// ---- Сервис на подменённых репозитории, журнале и курсах ----

const OWNER: OperationActor = { accountId: randomUUID(), platform: "telegram", platformUserId: "1" };
const FINANCE: OperationActor = { accountId: randomUUID(), platform: "telegram", platformUserId: "2" };
const OTHER_FINANCE: OperationActor = { accountId: randomUUID(), platform: "telegram", platformUserId: "3" };

const PLACE_VIEWS: PlaceView[] = [
  {
    placeId: "stars.bot",
    name: "Звёзды бота",
    currency: "XTR",
    archived: false,
    balance: "0",
    fee: { percentBp: 100, fixed: "0.05", fixedCurrency: "GRAM" },
    accounts: [
      { accountId: "stars.bot.hold", name: "Звёзды бота — в холде", balance: "0" },
      { accountId: "stars.bot.available", name: "Звёзды бота — доступно", balance: "0" },
    ],
  },
  { placeId: "wallet.ton", name: "Кошелёк TON", currency: "GRAM", archived: false, balance: "0", fee: null, accounts: [{ accountId: "wallet.ton", name: "Кошелёк TON", balance: "0" }] },
  { placeId: "bank.rub", name: "Банк, ₽", currency: "RUB", archived: false, balance: "0", fee: null, accounts: [{ accountId: "bank.rub", name: "Банк, ₽", balance: "0" }] },
  { placeId: "bank.tbank", name: "Карта Т-Банка", currency: "RUB", archived: false, balance: "0", fee: { percentBp: 150, fixed: null, fixedCurrency: null }, accounts: [{ accountId: "bank.tbank", name: "Карта Т-Банка", balance: "0" }] },
];

const ARTICLE_VIEWS: ArticleView[] = [
  { articleId: "vps", kind: "expense", name: "Сервер (VPS)", system: false, archived: false },
  { articleId: "fee_withdrawal", kind: "expense", name: "Комиссия вывода", system: true, archived: false },
  { articleId: "fee_exchange", kind: "expense", name: "Комиссия обмена", system: true, archived: false },
  { articleId: "ads_adsgram", kind: "income", name: "Реклама: AdsGram", system: false, archived: false },
];

interface MemoryEntry {
  entryId: string;
  sourceKey: string;
  at: Date;
  memo: string;
  lines: EntryLine[];
  reversalOf: string | null;
  meta: unknown;
  createdBy: string | null;
}

/** Журнал в памяти с теми же правилами, что у настоящего: ядро проверяет проводку, ключ идемпотентен, сторно одно. */
class FakeLedger {
  readonly entries = new Map<string, MemoryEntry>();
  postCalls = 0;

  constructor(private readonly accounts: Map<string, LedgerAccount>) {}

  async post(input: LedgerPostInput, actor?: { accountId: string }): Promise<PostResult> {
    this.postCalls += 1;
    const problem = findEntryProblems(input, this.accounts)[0];
    if (problem !== undefined) throw new LedgerEntryInvalidError(describeProblem(problem));
    const existing = this.entries.get(input.sourceKey);
    if (existing !== undefined) {
      const same = existing.lines.length === input.lines.length && input.lines.every((line) => existing.lines.some((other) => other.accountId === line.accountId && other.amount === line.amount));
      if (!same || existing.reversalOf !== (input.reversalOf ?? null)) throw new LedgerSourceConflictError(input.sourceKey);
      return { entryId: existing.entryId, created: false };
    }
    if (input.reversalOf !== undefined && [...this.entries.values()].some((entry) => entry.reversalOf === input.reversalOf)) throw new LedgerAlreadyReversedError(input.reversalOf);
    const entry: MemoryEntry = {
      entryId: randomUUID(),
      sourceKey: input.sourceKey,
      at: input.at,
      memo: input.memo,
      lines: input.lines.map((line) => ({ ...line })),
      reversalOf: input.reversalOf ?? null,
      meta: input.meta ?? null,
      createdBy: actor?.accountId ?? null,
    };
    this.entries.set(input.sourceKey, entry);
    return { entryId: entry.entryId, created: true };
  }

  async reverse(sourceKey: string, newSourceKey: string, at: Date, memo: string, actor?: { accountId: string }): Promise<PostResult> {
    const original = this.entries.get(sourceKey);
    if (original === undefined) throw new LedgerEntryNotFoundError(sourceKey);
    return await this.post(reverseEntry({ sourceKey: original.sourceKey, at: original.at, memo: original.memo, lines: original.lines }, newSourceKey, at, memo), actor);
  }

  forgetAccounts(): void {}

  /** Остаток счёта: сумма его строк по всем проводкам. */
  balanceOf(accountId: string): bigint {
    return [...this.entries.values()].flatMap((entry) => entry.lines).filter((line) => line.accountId === accountId).reduce((sum, line) => sum + line.amount, 0n);
  }
}

class FakeChart {
  constructor(private readonly accounts: Map<string, LedgerAccount>) {}

  async places(): Promise<PlaceView[]> {
    return PLACE_VIEWS;
  }

  async articles(): Promise<ArticleView[]> {
    return ARTICLE_VIEWS;
  }

  async ensureArticleAccount(articleId: string, currency: string): Promise<string> {
    const found = ARTICLE_VIEWS.find((item) => item.articleId === articleId);
    if (found === undefined) throw new Error(`нет статьи ${articleId}`);
    const id = `${found.kind}.${articleId}.${currency}`;
    this.accounts.set(id, { id, type: found.kind === "expense" ? "expense" : "revenue", currency, name: id });
    return id;
  }
}

class MemoryOperations implements OperationsRepository {
  readonly rows = new Map<string, StoredOperation>();
  readonly loans = new Map<string, StoredLoan>();
  /** сколько раз подряд отметка «проведена» падает, как при сбое сети после записи проводки */
  failMarkPosted = 0;
  accountsCreated = 0;
  private tick = 0;

  constructor(
    private readonly ledger: FakeLedger,
    private readonly accounts: Map<string, LedgerAccount>,
  ) {}

  async insert(operation: NewOperation): Promise<InsertOutcome> {
    if (operation.templateId !== null && [...this.rows.values()].some((row) => row.templateId === operation.templateId && row.templatePeriod === operation.templatePeriod)) return "template_taken";
    this.rows.set(operation.operationId, {
      operationId: operation.operationId,
      kind: operation.kind,
      status: "draft",
      input: operation.input,
      note: operation.note,
      link: operation.link,
      receiptImage: operation.receiptImage,
      amountUsd: operation.amountUsd,
      sourceKey: null,
      createdBy: operation.createdBy,
      createdAt: new Date(Date.UTC(2026, 10, 13, 12, 0, this.tick++)),
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      templateId: operation.templateId,
      templatePeriod: operation.templatePeriod,
    });
    return "inserted";
  }

  async byId(operationId: string): Promise<StoredOperation | null> {
    const row = this.rows.get(operationId);
    return row === undefined ? null : { ...row };
  }

  async updateDraft(operationId: string, patch: DraftPatch): Promise<boolean> {
    const row = this.rows.get(operationId);
    if (row === undefined || row.status !== "draft") return false;
    this.rows.set(operationId, { ...row, kind: patch.kind, input: patch.input, note: patch.note, link: patch.link, amountUsd: patch.amountUsd });
    return true;
  }

  async deleteDraft(operationId: string): Promise<boolean> {
    const row = this.rows.get(operationId);
    if (row === undefined || row.status !== "draft") return false;
    return this.rows.delete(operationId);
  }

  async list(filter: OperationFilter, cursor: { at: Date; entryId: string } | null, limit: number): Promise<StoredOperation[]> {
    return [...this.rows.values()]
      .filter((row) => (filter.status === undefined || row.status === filter.status) && (filter.kind === undefined || row.kind === filter.kind))
      .filter((row) => cursor === null || row.createdAt < cursor.at || (row.createdAt.getTime() === cursor.at.getTime() && row.operationId < cursor.entryId))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.operationId < b.operationId ? 1 : -1))
      .slice(0, limit);
  }

  async entryExists(sourceKey: string): Promise<boolean> {
    return this.ledger.entries.has(sourceKey);
  }

  // Второй ключ (T-0462) проверяет `ledger-approval.test.ts`: здесь все операции проводятся сразу.
  async markPending(): Promise<boolean> {
    return false;
  }

  async reject(): Promise<boolean> {
    return false;
  }

  async markPosted(operationId: string, sourceKey: string, loan: NewLoan | null): Promise<PostedOutcome> {
    if (this.failMarkPosted > 0) {
      this.failMarkPosted -= 1;
      throw new Error("соединение с базой потеряно");
    }
    const row = this.rows.get(operationId);
    if (row === undefined) return "missing";
    if (row.status !== "draft") return "already";
    this.rows.set(operationId, { ...row, status: "posted", sourceKey });
    if (loan !== null) this.loans.set(operationId, { ...loan, operationId });
    return "posted";
  }

  async ensureAccount(account: ServiceAccount): Promise<boolean> {
    if (this.accounts.has(account.accountId)) return false;
    this.accounts.set(account.accountId, { id: account.accountId, type: account.type, currency: account.currency, name: account.name });
    this.accountsCreated += 1;
    return true;
  }

  async entriesBySource(sourceKeys: readonly string[]): Promise<Map<string, StoredOperationEntry>> {
    const result = new Map<string, StoredOperationEntry>();
    for (const key of sourceKeys) {
      const entry = this.ledger.entries.get(key);
      if (entry === undefined) continue;
      // Дебет сверху, внутри — по счёту: так отдаёт строки и настоящий репозиторий.
      const lines: StoredEntryLine[] = entry.lines
        .map((line) => {
          const account = this.accounts.get(line.accountId);
          if (account === undefined) throw new Error(`нет счёта ${line.accountId}`);
          return { accountId: line.accountId, accountName: account.name, currency: account.currency, amount: line.amount };
        })
        .sort((a, b) => (a.amount === b.amount ? a.accountId.localeCompare(b.accountId) : a.amount > b.amount ? -1 : 1));
      result.set(key, { entryId: entry.entryId, sourceKey: key, at: entry.at, period: periodOf(entry.at), memo: entry.memo, reversalOf: entry.reversalOf, meta: entry.meta, createdBy: entry.createdBy, lines });
    }
    return result;
  }

  async loansOf(operationIds: readonly string[]): Promise<Map<string, StoredLoan>> {
    const result = new Map<string, StoredLoan>();
    for (const id of operationIds) {
      const loan = this.loans.get(id);
      if (loan !== undefined) result.set(id, loan);
    }
    return result;
  }
}

function snapshot(rates: Partial<Record<CurrencyCode, string>>, payout: Partial<Record<CurrencyCode, string>> = {}): Omit<RatesSnapshot, "id"> {
  const asRates = (source: Partial<Record<CurrencyCode, string>>): Map<CurrencyCode, Rate> =>
    new Map((Object.entries(source) as [CurrencyCode, string][]).map(([code, usd]) => [code, rateOf(code, new Decimal(usd), ["test"], NOW)]));
  return { takenAt: NOW, rates: asRates(rates), payout: asRates(payout) };
}

interface Harness {
  service: OperationsService;
  repository: MemoryOperations;
  ledger: FakeLedger;
  accounts: Map<string, LedgerAccount>;
  audit: AuditEntry[];
  fx: { rates: Omit<RatesSnapshot, "id">; broken: boolean };
}

function harness(): Harness {
  const accounts = new Map<string, LedgerAccount>();
  for (const view of PLACE_VIEWS) for (const account of view.accounts) accounts.set(account.accountId, { id: account.accountId, type: "asset", currency: view.currency, name: account.name });
  const ledger = new FakeLedger(accounts);
  const repository = new MemoryOperations(ledger, accounts);
  const audit: AuditEntry[] = [];
  const fx = { rates: snapshot({ RUB: "0.0125", GRAM: "5", USDT: "1" }, { XTR: "0.013" }), broken: false };
  const roles = {
    audit: async (entry: AuditEntry) => void audit.push(entry),
    rolesFor: async (actor: OperationActor) => (actor.accountId === OWNER.accountId ? ["owner"] : ["finance"]),
  };
  const fxService = {
    peek: async () => {
      if (fx.broken) throw new Error("база курсов недоступна");
      return fx.rates;
    },
  };
  // Второй ключ и снимок чека (T-0462) проверяет `ledger-approval.test.ts`: здесь операции проводятся сразу.
  const approvals = { required: async () => false } as unknown as OperationApprovals;
  const media = { require: async () => undefined } as unknown as MediaService;
  const service = new OperationsService(repository, ledger as unknown as LedgerService, new FakeChart(accounts) as unknown as LedgerChartService, fxService as unknown as FxService, roles as unknown as RolesService, approvals, media);
  return { service, repository, ledger, accounts, audit, fx };
}

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("ожидалась доменная ошибка, а вызов прошёл");
}

const VPS: OperationInput = { kind: "expense", ...BASE, from: "bank.rub", article: "vps", amount: "1500" };
const LOAN: OperationInput = { kind: "loan", ...BASE, note: "Заём на закупку рекламы", to: "bank.rub", lender: "Иван Петров", amount: "100000", premium: "10000", repaymentBp: 2500 };

describe("OperationsService: черновик и проведение", () => {
  it("create делает черновик: проводки нет, остатки не тронуты, размер оценён по курсам, действие в аудите", async () => {
    const { service, ledger, audit } = harness();

    const created = await service.create(OWNER, VPS);

    expect(created).toMatchObject({ kind: "expense", status: "draft", entry: null, loan: null, receiptMissing: false, amountUsd: "18.75", createdBy: OWNER.accountId });
    expect(created.input).toMatchObject({ kind: "expense", from: "bank.rub", article: "vps", amount: "1500", note: BASE.note });
    expect(ledger.postCalls).toBe(0);
    expect(ledger.balanceOf("bank.rub")).toBe(0n);
    expect(audit.map((entry) => [entry.action, entry.target, entry.actorAccountId])).toEqual([["ledger.operation.create", created.operationId, OWNER.accountId]]);
  });

  it("submit проводит черновик: проводка `op:<id>`, остатки изменились, статья расхода заведена, аудит", async () => {
    const { service, ledger, audit, accounts } = harness();
    const created = await service.create(FINANCE, VPS);

    const posted = await service.submit(FINANCE, created.operationId);

    expect(posted.status).toBe("posted");
    expect(posted.entry).toMatchObject({ sourceKey: `op:${created.operationId}`, memo: BASE.note, createdBy: FINANCE.accountId, period: "2026-11" });
    expect(posted.entry?.lines).toEqual([
      { accountId: "expense.vps.RUB", accountName: "expense.vps.RUB", currency: "RUB", amount: "1500.00" },
      { accountId: "bank.rub", accountName: "Банк, ₽", currency: "RUB", amount: "-1500.00" },
    ]);
    expect(ledger.balanceOf("bank.rub")).toBe(-150_000n);
    expect(accounts.has("expense.vps.RUB")).toBe(true);
    expect(audit.map((entry) => entry.action)).toEqual(["ledger.operation.create", "ledger.operation.submit"]);
  });

  it("повторный submit — та же проводка: вторая не создаётся, второго аудита нет", async () => {
    const { service, ledger, audit } = harness();
    const created = await service.create(OWNER, VPS);

    const first = await service.submit(OWNER, created.operationId);
    const second = await service.submit(OWNER, created.operationId);

    expect(second.entry?.entryId).toBe(first.entry?.entryId);
    expect(ledger.entries.size).toBe(1);
    expect(ledger.postCalls).toBe(1);
    expect(audit.filter((entry) => entry.action === "ledger.operation.submit")).toHaveLength(1);
  });

  it("сбой между проводкой и отметкой лечится повтором: проводка с теми же строками — та же, операция становится проведённой", async () => {
    const { service, repository, ledger } = harness();
    const created = await service.create(OWNER, VPS);
    repository.failMarkPosted = 1;

    await expect(service.submit(OWNER, created.operationId)).rejects.toThrow("соединение с базой потеряно");
    expect(ledger.entries.size).toBe(1);
    expect(repository.rows.get(created.operationId)?.status).toBe("draft");

    const retry = await service.submit(OWNER, created.operationId);

    expect(retry.status).toBe("posted");
    expect(ledger.entries.size).toBe(1);
    expect(ledger.balanceOf("bank.rub")).toBe(-150_000n);
  });

  it("сбой между проводкой и отметкой: правка черновика отказывает 409, ввод прежний, а повторный submit доводит операцию до «проведена»", async () => {
    const { service, repository, ledger, audit } = harness();
    const created = await service.create(OWNER, VPS);
    repository.failMarkPosted = 1;
    await expect(service.submit(OWNER, created.operationId)).rejects.toThrow("соединение с базой потеряно");
    const auditBefore = audit.length;

    const edit = await domainError(service.update(OWNER, created.operationId, { ...VPS, amount: "2000" }));

    expect(edit).toMatchObject({ code: "ledger_operation_not_draft", status: 409 });
    expect(repository.rows.get(created.operationId)?.input).toMatchObject({ amount: "1500" });
    expect(repository.rows.get(created.operationId)?.status).toBe("draft");
    expect(audit).toHaveLength(auditBefore);

    // Ввод остался тем, по которому записана проводка, поэтому повтор не упирается в «ключ занят другими строками».
    const retry = await service.submit(OWNER, created.operationId);

    expect(retry.status).toBe("posted");
    expect(retry.input).toMatchObject({ amount: "1500" });
    expect(ledger.entries.size).toBe(1);
    expect(ledger.balanceOf("bank.rub")).toBe(-150_000n);
  });

  it("правка автором, у которого проводка уже записана, тоже отказывает: проверка проводки не зависит от того, кто правит", async () => {
    const { service, repository } = harness();
    const created = await service.create(FINANCE, VPS);
    repository.failMarkPosted = 1;
    await expect(service.submit(FINANCE, created.operationId)).rejects.toThrow();

    expect((await domainError(service.update(FINANCE, created.operationId, { ...VPS, amount: "1" }))).code).toBe("ledger_operation_not_draft");
    expect((await domainError(service.update(OWNER, created.operationId, { ...VPS, amount: "1" }))).code).toBe("ledger_operation_not_draft");
  });

  it("два одновременных submit дают одну проводку и одну отметку", async () => {
    const { service, ledger, audit } = harness();
    const created = await service.create(OWNER, VPS);

    const [a, b] = await Promise.all([service.submit(OWNER, created.operationId), service.submit(OWNER, created.operationId)]);

    expect(a.status).toBe("posted");
    expect(b.status).toBe("posted");
    expect(ledger.entries.size).toBe(1);
    expect(ledger.balanceOf("bank.rub")).toBe(-150_000n);
    expect(audit.filter((entry) => entry.action === "ledger.operation.submit")).toHaveLength(1);
  });

  it("неверная операция при create — 400 ledger_operation_invalid с текстом проблем, ничего не записано", async () => {
    const { service, repository, audit } = harness();

    const error = await domainError(service.create(OWNER, { ...VPS, from: "bank.net", at: "2099-01-01" }));

    expect(error).toMatchObject({ code: "ledger_operation_invalid", status: 400 });
    expect(error.message).toContain("«bank.net» нет");
    expect(error.message).toContain("в будущем");
    expect(repository.rows.size).toBe(0);
    expect(audit).toHaveLength(0);
  });

  it("тело мимо схемы (серверный вызов шаблона) — тоже 400, с названием поля", async () => {
    const { service } = harness();

    const error = await domainError(service.create(OWNER, { ...VPS, amount: "-5" }));

    expect(error).toMatchObject({ code: "ledger_operation_invalid", status: 400 });
    expect(error.message).toContain("«amount»");
  });

  it("место ушло в архив между черновиком и проведением — submit отказывает с понятным текстом, проводки нет", async () => {
    const { service, ledger } = harness();
    const created = await service.create(OWNER, VPS);
    const archived = PLACE_VIEWS.find((view) => view.placeId === "bank.rub");
    if (archived === undefined) throw new Error("нет места в справочнике теста");
    archived.archived = true;
    try {
      const error = await domainError(service.submit(OWNER, created.operationId));

      expect(error).toMatchObject({ code: "ledger_operation_invalid", status: 400 });
      expect(error.message).toContain("в архиве");
      expect(ledger.entries.size).toBe(0);
    } finally {
      archived.archived = false;
    }
  });

  it("неизвестная операция — 404", async () => {
    const { service } = harness();

    expect((await domainError(service.get(randomUUID()))).code).toBe("ledger_operation_not_found");
    expect((await domainError(service.submit(OWNER, randomUUID()))).status).toBe(404);
    expect((await domainError(service.discard(OWNER, randomUUID()))).status).toBe(404);
  });
});

describe("OperationsService: правка и удаление черновика", () => {
  it("черновик правится автором целиком: сумма, комиссия, оценка и аудит меняются, автор остаётся", async () => {
    const { service, audit } = harness();
    const created = await service.create(FINANCE, VPS);

    const updated = await service.update(FINANCE, created.operationId, { ...VPS, amount: "2000", note: "Оплата сервера, счёт №7" });

    expect(updated.input).toMatchObject({ amount: "2000", note: "Оплата сервера, счёт №7" });
    expect(updated).toMatchObject({ status: "draft", amountUsd: "25.00", createdBy: FINANCE.accountId, createdAt: created.createdAt });
    expect(audit.map((entry) => entry.action)).toEqual(["ledger.operation.create", "ledger.operation.update"]);
  });

  it("чужой черновик правит владелец, а другой человек из финансов — нет: 403", async () => {
    const { service } = harness();
    const created = await service.create(FINANCE, VPS);

    expect((await domainError(service.update(OTHER_FINANCE, created.operationId, { ...VPS, amount: "1" }))).status).toBe(403);
    expect((await service.update(OWNER, created.operationId, { ...VPS, amount: "1" })).input).toMatchObject({ amount: "1" });
  });

  it("правка вида меняет и вид: черновик расхода становится переводом", async () => {
    const { service } = harness();
    const created = await service.create(OWNER, VPS);

    const updated = await service.update(OWNER, created.operationId, { kind: "transfer", ...BASE, from: "bank.rub", to: "bank.tbank", amount: "100" });

    expect(updated).toMatchObject({ kind: "transfer", status: "draft" });
  });

  it("неверная правка — 400, прежний ввод не затронут", async () => {
    const { service } = harness();
    const created = await service.create(OWNER, VPS);

    expect((await domainError(service.update(OWNER, created.operationId, { ...VPS, amount: "0" }))).code).toBe("ledger_operation_invalid");
    expect((await service.get(created.operationId)).input).toMatchObject({ amount: "1500" });
  });

  it("проведённая операция не правится и не удаляется — 409 ledger_operation_not_draft", async () => {
    const { service, ledger } = harness();
    const created = await service.create(OWNER, VPS);
    await service.submit(OWNER, created.operationId);

    const update = await domainError(service.update(OWNER, created.operationId, { ...VPS, amount: "1" }));
    const discard = await domainError(service.discard(OWNER, created.operationId));

    expect(update).toMatchObject({ code: "ledger_operation_not_draft", status: 409 });
    expect(discard).toMatchObject({ code: "ledger_operation_not_draft", status: 409 });
    expect(ledger.balanceOf("bank.rub")).toBe(-150_000n);
  });

  it("discard убирает черновик и пишет аудит; убрать то, что проводится прямо сейчас (проводка есть, отметки нет), нельзя", async () => {
    const { service, repository, audit } = harness();
    const gone = await service.create(OWNER, VPS);
    await service.discard(OWNER, gone.operationId);

    expect((await domainError(service.get(gone.operationId))).status).toBe(404);
    expect(audit.at(-1)).toMatchObject({ action: "ledger.operation.discard", target: gone.operationId });

    const inFlight = await service.create(OWNER, VPS);
    repository.failMarkPosted = 1;
    await expect(service.submit(OWNER, inFlight.operationId)).rejects.toThrow();
    expect((await domainError(service.discard(OWNER, inFlight.operationId))).code).toBe("ledger_operation_not_draft");
  });
});

describe("OperationsService: виды операций целиком", () => {
  it("комиссия по шаблону подставляется в ввод при create: что человек видит в черновике, то и проводится", async () => {
    const { service, ledger } = harness();

    const created = await service.create(OWNER, { kind: "exchange", ...BASE, note: "Вывод звёзд через Fragment", from: "stars.bot.available", to: "wallet.ton", given: "10000", received: "52.3" });

    expect(created.input).toMatchObject({ fee: { amount: "100", fixed: { amount: "0.050000000", currency: "GRAM" } } });
    expect(created.amountUsd).toBe("130.00");
    await service.submit(OWNER, created.operationId);
    expect(ledger.balanceOf("stars.bot.available")).toBe(-10_100n);
    expect(ledger.balanceOf("exchange.transit.XTR")).toBe(10_000n);
    expect(ledger.balanceOf("exchange.transit.GRAM")).toBe(-52_300_000_000n);
    expect(ledger.balanceOf("wallet.ton")).toBe(52_250_000_000n);
  });

  it("заём заводит счёт-обязательство и строку условий; второй заём того же кредитора идёт на тот же счёт", async () => {
    const { service, repository, accounts, ledger } = harness();

    const first = await service.submit(OWNER, (await service.create(OWNER, LOAN)).operationId);
    const second = await service.submit(OWNER, (await service.create(OWNER, { ...LOAN, amount: "50000", premium: "0", repaymentBp: 1000 })).operationId);

    expect(first.loan).toMatchObject({ lender: "Иван Петров", accountId: "loan.ivan-petrov.RUB", currency: "RUB", principal: "100000.00", premium: "10000.00", repaymentBp: 2500 });
    expect(second.loan).toMatchObject({ principal: "50000.00", premium: "0.00", repaymentBp: 1000 });
    expect(accounts.get("loan.ivan-petrov.RUB")).toEqual({ id: "loan.ivan-petrov.RUB", type: "liability", currency: "RUB", name: "Заём: Иван Петров" });
    expect(repository.accountsCreated).toBe(1);
    expect(repository.loans.size).toBe(2);
    expect(ledger.balanceOf("bank.rub")).toBe(15_000_000n);
    expect(ledger.balanceOf("loan.ivan-petrov.RUB")).toBe(-15_000_000n);
  });

  it("у черновика займа строки условий ещё нет — она появляется вместе с проводкой", async () => {
    const { service, repository } = harness();

    const draft = await service.create(OWNER, LOAN);

    expect(draft.loan).toBeNull();
    expect(repository.loans.size).toBe(0);
  });

  it("исправление: сторно исходной проводки обратными знаками; повторное исправление той же проводки — 409", async () => {
    const { service, ledger } = harness();
    const original = await service.submit(OWNER, (await service.create(OWNER, VPS)).operationId);
    const originalKey = original.entry?.sourceKey ?? "";

    const fix = await service.create(OWNER, { kind: "reversal", ...BASE, note: "Оплатили с другого счёта", sourceKey: originalKey });
    expect(fix).toMatchObject({ kind: "reversal", status: "draft", amountUsd: null });
    const posted = await service.submit(OWNER, fix.operationId);

    expect(posted.entry).toMatchObject({ reversalOf: originalKey, memo: "Оплатили с другого счёта" });
    expect(ledger.balanceOf("bank.rub")).toBe(0n);
    expect(ledger.balanceOf("expense.vps.RUB")).toBe(0n);

    const again = await service.create(OWNER, { kind: "reversal", ...BASE, note: "Ещё раз", sourceKey: originalKey });
    expect((await domainError(service.submit(OWNER, again.operationId))).code).toBe("ledger_already_reversed");
    expect(ledger.entries.size).toBe(2);
  });

  it("исправление несуществующей проводки отказывает уже при create, с ключом в тексте", async () => {
    const { service } = harness();

    const error = await domainError(service.create(OWNER, { kind: "reversal", ...BASE, sourceKey: "purchase:404:paid" }));

    expect(error.code).toBe("ledger_operation_invalid");
    expect(error.message).toContain("purchase:404:paid");
  });

  it("поступление в рубли без чека: receiptMissing в черновике и после проведения, с чеком — нет", async () => {
    const { service } = harness();
    const income: OperationInput = { kind: "income", ...BASE, to: "bank.rub", article: "ads_adsgram", amount: "5000", forMonth: "2026-10" };

    const draft = await service.create(OWNER, income);
    const posted = await service.submit(OWNER, draft.operationId);
    const withReceipt = await service.create(OWNER, { ...income, receipt: { payer: "individual", number: "ab12" } });

    expect(draft.receiptMissing).toBe(true);
    expect(posted).toMatchObject({ status: "posted", receiptMissing: true });
    expect(posted.entry?.meta).toMatchObject({ forMonth: "2026-10" });
    expect(withReceipt.receiptMissing).toBe(false);
  });

  it("повторный черновик по шаблону на тот же период — 409, другой период — можно", async () => {
    const { service, repository } = harness();
    const template = { templateId: "vps-monthly", period: "2026-11" };

    const first = await service.create(OWNER, VPS, template);
    const error = await domainError(service.create(OWNER, VPS, template));

    expect(first).toMatchObject({ templateId: "vps-monthly", templatePeriod: "2026-11" });
    expect(error).toMatchObject({ code: "ledger_operation_template_taken", status: 409 });
    await service.create(OWNER, VPS, { templateId: "vps-monthly", period: "2026-10" });
    expect(repository.rows.size).toBe(2);
  });
});

describe("OperationsService: оценка размера в долларах", () => {
  it("звезда — по курсу выплаты, остальные — по рынку, округление вверх до цента", async () => {
    const { service } = harness();

    const stars = await service.create(OWNER, { kind: "expense", ...BASE, from: "stars.bot.available", article: "vps", amount: "1001" });
    const gram = await service.create(OWNER, { kind: "expense", ...BASE, from: "wallet.ton", article: "vps", amount: "0.123456789" });

    // 1001 ⭐ × 0,013 $ = 13,013 → 13,02; 0,123456789 Gram × 5 $ = 0,617283945 → 0,62
    expect(stars.amountUsd).toBe("13.02");
    expect(gram.amountUsd).toBe("0.62");
  });

  it("обмен оценивается по отданному; нет курса отданной валюты — по полученной", async () => {
    const { service, fx } = harness();
    fx.rates = snapshot({ GRAM: "5" });

    const created = await service.create(OWNER, { kind: "exchange", ...BASE, from: "stars.bot.available", to: "wallet.ton", given: "10000", received: "10", fee: {} });

    expect(created.amountUsd).toBe("50.00");
  });

  it("нет курса или курсы недоступны — оценки нет (`null`), черновик всё равно создаётся", async () => {
    const { service, fx } = harness();
    fx.rates = snapshot({});
    const withoutRate = await service.create(OWNER, VPS);
    fx.broken = true;
    const brokenRates = await service.create(OWNER, VPS);

    expect(withoutRate).toMatchObject({ status: "draft", amountUsd: null });
    expect(brokenRates).toMatchObject({ status: "draft", amountUsd: null });
  });
});

describe("OperationsService: список", () => {
  it("новые сверху, страницы по курсору без повторов и потерь, фильтры по статусу и виду", async () => {
    const { service } = harness();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) ids.push((await service.create(OWNER, { ...VPS, amount: String(index + 1) })).operationId);
    await service.submit(OWNER, ids[0] ?? "");

    const first = await service.list({}, null, 2);
    const second = await service.list({}, first.next, 2);
    const third = await service.list({}, second.next, 2);

    expect(first.operations.map((operation) => operation.operationId)).toEqual([ids[4], ids[3]]);
    expect(second.operations.map((operation) => operation.operationId)).toEqual([ids[2], ids[1]]);
    expect(third.operations.map((operation) => operation.operationId)).toEqual([ids[0]]);
    expect(third.next).toBeNull();
    expect(third.operations[0]?.entry).not.toBeNull();
    expect((await service.list({ status: "draft" }, null, 10)).operations).toHaveLength(4);
    expect((await service.list({ status: "posted" }, null, 10)).operations.map((operation) => operation.operationId)).toEqual([ids[0]]);
    expect((await service.list({ kind: "loan" }, null, 10)).operations).toEqual([]);
  });

  it("лимит вне 1…100 и нечитаемый курсор — отказы", async () => {
    const { service } = harness();

    expect((await domainError(service.list({}, null, 0))).code).toBe("validation_failed");
    expect((await domainError(service.list({}, null, 101))).code).toBe("validation_failed");
    expect((await domainError(service.list({}, "не-курсор", 10))).code).toBe("ledger_cursor_invalid");
  });
});
