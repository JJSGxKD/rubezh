import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import {
  approveOperation,
  discardOperation,
  draftPeriod,
  loadOperations,
  mergeOperations,
  operationPageSchema,
  operationsQuery,
  pendingOperations,
  rejectOperation,
  saveOperation,
  STATUS_LABELS,
  submitOperation,
  type ArticleView,
  type OperationInput,
  type OperationView,
  type PlaceView,
} from "../src/api/ledger-operations";
import { emptyForm, formFromInput, inputFromForm, suggestFee, type FormState } from "../src/screens/ledger/operations/form-model";
import { fromMinor, toMinor } from "../src/screens/ledger/operations/money";
import { OperationCard } from "../src/screens/ledger/operations/OperationCard";
import { approvalOutlook, feeSuggestion, flattenPlaces, previewOf, receiptWarning, reversalPreview, type Chart, type Preview } from "../src/screens/ledger/operations/preview";
import { fakeFetch, json } from "./helpers";

/**
 * «Бухгалтерия → Операции» (tasks/T-0464, Р220, Р221): предпросмотр проводки по видам — те же числа, что у сервера на
 * тех же входах (образцы из `backend/api/test/ledger-operations.test.ts`), подпись «Проведётся сразу / Ждёт подтверждения»,
 * предупреждение о чеке НПД, форма → тело запроса, вызовы маршрутов и кнопки решения владельца.
 */

const plain = (text: string) => text.replace(/[  ]/g, " ");

// ---- справочник: как его отдаёт сервер ----

function place(placeId: string, name: string, currency: string, options: { fee?: PlaceView["fee"]; archived?: boolean; accounts?: PlaceView["accounts"] } = {}): PlaceView {
  return {
    placeId,
    name,
    currency,
    archived: options.archived ?? false,
    balance: "0",
    fee: options.fee ?? null,
    accounts: options.accounts ?? [{ accountId: placeId, name, balance: "0" }],
  };
}

const PLACES: PlaceView[] = [
  place("stars.bot", "Звёзды бота", "XTR", {
    fee: { percentBp: 100, fixed: "0.050000000", fixedCurrency: "GRAM" },
    accounts: [
      { accountId: "stars.bot.hold", name: "Звёзды бота — в холде", balance: "0" },
      { accountId: "stars.bot.available", name: "Звёзды бота — доступно", balance: "0" },
    ],
  }),
  place("wallet.ton", "Кошелёк TON", "GRAM"),
  place("exchange.usdt", "Биржа или USDT", "USDT", { fee: { percentBp: 50, fixed: null, fixedCurrency: null } }),
  place("wallet.usdt-ton", "Кошелёк USDT", "USDT"),
  place("bank.rub", "Банк, ₽", "RUB"),
  place("bank.tbank", "Карта Т-Банка", "RUB"),
  place("bank.old", "Старый счёт", "RUB", { archived: true }),
];

const ARTICLES: ArticleView[] = [
  { articleId: "vps", kind: "expense", name: "Сервер (VPS)", system: false, archived: false },
  { articleId: "fee_withdrawal", kind: "expense", name: "Комиссия вывода", system: true, archived: false },
  { articleId: "fee_exchange", kind: "expense", name: "Комиссия обмена", system: true, archived: false },
  { articleId: "ads_adsgram", kind: "income", name: "Реклама: AdsGram", system: false, archived: false },
];

const CHART: Chart = { places: flattenPlaces(PLACES), articles: ARTICLES };
const BASE = { note: "Оплата сервера за ноябрь", at: "2026-11-10" };

/** Строки предпросмотра как «счёт → сумма со знаком» — по ним сверяются с проводкой сервера. */
function linesOf(preview: Preview): Record<string, string> {
  if (!preview.ok) throw new Error(`ожидался предпросмотр, а вышли проблемы: ${preview.problems.join("; ")}`);
  return Object.fromEntries(preview.lines.map((line) => [line.accountName, line.amount]));
}

function problemsOf(preview: Preview): string[] {
  if (preview.ok) throw new Error("ожидались проблемы, а предпросмотр собрался");
  return preview.problems;
}

describe("деньги формы: десятичные строки без плавающей точки", () => {
  it("toMinor: знаки по справочнику валют, лишние знаки и мусор — null", () => {
    expect(toMinor("1500", "RUB")).toBe(150_000n);
    expect(toMinor("52.3", "GRAM")).toBe(52_300_000_000n);
    expect(toMinor("10000", "XTR")).toBe(10_000n);
    expect(toMinor("10.5", "XTR")).toBeNull();
    expect(toMinor("1.001", "RUB")).toBeNull();
    expect(toMinor("1e3", "RUB")).toBeNull();
    expect(toMinor("-5", "RUB")).toBeNull();
    expect(toMinor("", "RUB")).toBeNull();
    expect(toMinor("5", "ABC")).toBeNull();
  });

  it("fromMinor: обратно с полным числом знаков валюты", () => {
    expect(fromMinor(150_000n, "RUB")).toBe("1500.00");
    expect(fromMinor(-101_500n, "RUB")).toBe("-1015.00");
    expect(fromMinor(52_250_000_000n, "GRAM")).toBe("52.250000000");
    expect(fromMinor(10_100n, "XTR")).toBe("10100");
    expect(fromMinor(5n, "USDT")).toBe("0.000005");
  });
});

describe("предпросмотр проводки: перевод", () => {
  it("с процентной комиссией: списание с суммой и комиссией, зачисление, статья «Комиссия вывода»", () => {
    const preview = previewOf({ kind: "transfer", ...BASE, from: "bank.rub", to: "bank.tbank", amount: "1000", fee: { amount: "15" } }, CHART);

    expect(linesOf(preview)).toEqual({ "Банк, ₽": "-1015.00", "Карта Т-Банка": "1000.00", "Комиссия вывода, ₽": "15.00" });
  });

  it("без комиссии — две строки", () => {
    const preview = previewOf({ kind: "transfer", ...BASE, from: "bank.rub", to: "bank.tbank", amount: "2500.50" }, CHART);

    expect(linesOf(preview)).toEqual({ "Банк, ₽": "-2500.50", "Карта Т-Банка": "2500.50" });
  });

  it("процент в валюте перевода и фикса в другой: фикса — пара строк на месте этой валюты", () => {
    const preview = previewOf(
      { kind: "transfer", ...BASE, from: "exchange.usdt", to: "wallet.usdt-ton", amount: "200.5", fee: { amount: "1.0025", fixed: { amount: "0.05", currency: "GRAM" } } },
      CHART,
    );

    expect(linesOf(preview)).toEqual({
      "Биржа или USDT": "-201.502500",
      "Кошелёк USDT": "200.500000",
      "Комиссия вывода, USDT": "1.002500",
      "Кошелёк TON": "-0.050000000",
      "Комиссия вывода, GRAM": "0.050000000",
    });
  });

  it("фикса в валюте перевода складывается с процентом в одну строку комиссии", () => {
    const preview = previewOf({ kind: "transfer", ...BASE, from: "bank.rub", to: "bank.tbank", amount: "1000", fee: { amount: "10", fixed: { amount: "5", currency: "RUB" } } }, CHART);

    expect(linesOf(preview)).toEqual({ "Банк, ₽": "-1015.00", "Карта Т-Банка": "1000.00", "Комиссия вывода, ₽": "15.00" });
  });

  it("проблемы: те же места, разные валюты, архивное место, нулевая сумма", () => {
    expect(problemsOf(previewOf({ kind: "transfer", ...BASE, from: "bank.rub", to: "bank.rub", amount: "1" }, CHART))[0]).toContain("одно и то же место");
    expect(problemsOf(previewOf({ kind: "transfer", ...BASE, from: "bank.rub", to: "wallet.ton", amount: "1" }, CHART))[0]).toContain("есть обмен");
    expect(problemsOf(previewOf({ kind: "transfer", ...BASE, from: "bank.rub", to: "bank.old", amount: "1" }, CHART))[0]).toContain("в архиве");
    expect(problemsOf(previewOf({ kind: "transfer", ...BASE, from: "bank.rub", to: "bank.tbank", amount: "0" }, CHART))[0]).toContain("больше нуля");
  });

  it("фикса в чужой валюте: мест нет — проблема, несколько — выбор за человеком, названное место подходит", () => {
    const none = { ...CHART, places: CHART.places.filter((item) => item.accountId !== "wallet.ton") };
    const fixed = { amount: "0.05", currency: "GRAM" };
    expect(problemsOf(previewOf({ kind: "transfer", ...BASE, from: "exchange.usdt", to: "wallet.usdt-ton", amount: "10", fee: { fixed } }, none))[0]).toContain("Нет места в валюте фиксы GRAM");

    const two = { ...CHART, places: [...CHART.places, ...flattenPlaces([place("wallet.ton2", "Второй кошелёк", "GRAM")])] };
    expect(problemsOf(previewOf({ kind: "transfer", ...BASE, from: "exchange.usdt", to: "wallet.usdt-ton", amount: "10", fee: { fixed } }, two))[0]).toContain("несколько мест");
    const named = previewOf({ kind: "transfer", ...BASE, from: "exchange.usdt", to: "wallet.usdt-ton", amount: "10", fee: { fixed: { ...fixed, from: "wallet.ton2" } } }, two);
    expect(linesOf(named)["Второй кошелёк"]).toBe("-0.050000000");
  });
});

describe("предпросмотр проводки: обмен", () => {
  it("вывод звёзд на кошелёк: каждая валюта сходится через транзит, фикса списана с кошелька", () => {
    const preview = previewOf(
      { kind: "exchange", ...BASE, from: "stars.bot.available", to: "wallet.ton", given: "10000", received: "52.3", fee: { amount: "100", fixed: { amount: "0.05", currency: "GRAM" } } },
      CHART,
    );

    expect(linesOf(preview)).toEqual({
      "Звёзды бота — доступно": "-10100",
      "Обмен (транзит), XTR": "10000",
      "Комиссия обмена, XTR": "100",
      "Обмен (транзит), GRAM": "-52.300000000",
      "Кошелёк TON": "52.250000000",
      "Комиссия обмена, GRAM": "0.050000000",
    });
  });

  it("обмен в одной валюте и дробные звёзды — проблемы", () => {
    expect(problemsOf(previewOf({ kind: "exchange", ...BASE, from: "bank.rub", to: "bank.tbank", given: "100", received: "100" }, CHART))[0]).toContain("для одной валюты есть перевод");
    expect(problemsOf(previewOf({ kind: "exchange", ...BASE, from: "stars.bot.available", to: "wallet.ton", given: "10.5", received: "5" }, CHART))[0]).toContain("Отдано");
  });
});

describe("предпросмотр проводки: расход, поступление, заём, исправление", () => {
  it("расход: место минус, статья расхода в валюте места плюс", () => {
    const preview = previewOf({ kind: "expense", ...BASE, from: "bank.rub", article: "vps", amount: "1500" }, CHART);

    expect(linesOf(preview)).toEqual({ "Банк, ₽": "-1500.00", "Сервер (VPS), ₽": "1500.00" });
  });

  it("расход: статья не того вида, архивная и неизвестная — проблемы", () => {
    expect(problemsOf(previewOf({ kind: "expense", ...BASE, from: "bank.rub", article: "ads_adsgram", amount: "1" }, CHART))[0]).toContain("не из статей расходов");
    expect(problemsOf(previewOf({ kind: "expense", ...BASE, from: "bank.rub", article: "net", amount: "1" }, CHART))[0]).toContain("«net» нет");
  });

  it("поступление: место плюс, статья поступления минус", () => {
    const preview = previewOf({ kind: "income", ...BASE, to: "bank.rub", article: "ads_adsgram", amount: "120.40", forMonth: "2026-10" }, CHART);

    expect(linesOf(preview)).toEqual({ "Банк, ₽": "120.40", "Реклама: AdsGram, ₽": "-120.40" });
  });

  it("поступление: месяц позже месяца даты операции — проблема", () => {
    expect(problemsOf(previewOf({ kind: "income", ...BASE, to: "bank.rub", article: "ads_adsgram", amount: "1", forMonth: "2026-12" }, CHART))[0]).toContain("позже месяца даты");
  });

  it("заём: место плюс, счёт-обязательство «Заём: кредитор» минус", () => {
    const preview = previewOf({ kind: "loan", ...BASE, to: "bank.rub", lender: "Иван Петров", amount: "100000", premium: "10000", repaymentBp: 2500 }, CHART);

    expect(linesOf(preview)).toEqual({ "Банк, ₽": "100000.00", "Заём: Иван Петров, ₽": "-100000.00" });
  });

  it("заём: премия с лишними знаками и ставка вне 0…10 000 — проблемы", () => {
    expect(problemsOf(previewOf({ kind: "loan", ...BASE, to: "bank.rub", lender: "Иван", amount: "100", premium: "0.001", repaymentBp: 100 }, CHART))[0]).toContain("Премия");
    expect(problemsOf(previewOf({ kind: "loan", ...BASE, to: "bank.rub", lender: "Иван", amount: "100", premium: "0", repaymentBp: 10_001 }, CHART))[0]).toContain("Ставка погашения");
  });

  it("исправление: строки исходной проводки с обратными знаками", () => {
    const lines = reversalPreview([
      { accountId: "bank.rub", accountName: "Банк, ₽", currency: "RUB", amount: "-1500.00" },
      { accountId: "expense.vps.RUB", accountName: "Расход: Сервер (VPS), ₽", currency: "RUB", amount: "1500.00" },
    ]);

    expect(lines.map((line) => [line.accountName, line.amount])).toEqual([
      ["Банк, ₽", "1500.00"],
      ["Расход: Сервер (VPS), ₽", "-1500.00"],
    ]);
  });

  it("дата не в календаре и причина короче трёх знаков — проблемы разом", () => {
    const problems = problemsOf(previewOf({ kind: "expense", note: "ab", at: "2026-02-31", from: "bank.rub", article: "vps", amount: "1" }, CHART));
    expect(problems.some((text) => text.includes("Дата"))).toBe(true);
    expect(problems.some((text) => text.includes("Причина"))).toBe(true);
  });
});

describe("комиссия по шаблону места: подсказка формы", () => {
  const stars = CHART.places.find((item) => item.accountId === "stars.bot.available");
  const exchange = CHART.places.find((item) => item.accountId === "exchange.usdt");

  it("процент округлён вверх, фикса — в своей валюте", () => {
    expect(stars).toBeDefined();
    expect(feeSuggestion("10000", stars ?? null)).toEqual({ amount: "100", fixed: { amount: "0.050000000", currency: "GRAM" } });
    // 1 % от 99 звёзд — 0,99: комиссию не занижаем, одна звезда.
    expect(feeSuggestion("99", stars ?? null)).toEqual({ amount: "1", fixed: { amount: "0.050000000", currency: "GRAM" } });
  });

  it("только процент; без шаблона и без суммы — подсказки нет", () => {
    expect(feeSuggestion("200", exchange ?? null)).toEqual({ amount: "1.000000" });
    expect(feeSuggestion("200", CHART.places.find((item) => item.accountId === "bank.rub") ?? null)).toBeNull();
    expect(feeSuggestion("", stars ?? null)).toBeNull();
    expect(feeSuggestion("0", stars ?? null)).toBeNull();
  });
});

describe("подпись «Проведётся сразу» / «Ждёт подтверждения владельца»", () => {
  const finance = { canApprove: false, thresholdUsd: 200 };

  it("у владельца — сразу, при любой сумме и даже у исправления", () => {
    expect(approvalOutlook({ kind: "expense", amountUsd: "9999.00", canApprove: true, thresholdUsd: 200 }).verdict).toBe("immediate");
    expect(approvalOutlook({ kind: "reversal", amountUsd: null, canApprove: true, thresholdUsd: 200 }).verdict).toBe("immediate");
  });

  it("исправление финансов — всегда ждёт владельца", () => {
    expect(approvalOutlook({ kind: "reversal", amountUsd: "1.00", ...finance }).verdict).toBe("pending");
  });

  it("порог включительно: 199,99 — сразу, 200,00 — ждёт", () => {
    expect(approvalOutlook({ kind: "expense", amountUsd: "199.99", ...finance })).toEqual({ verdict: "immediate", text: "Проведётся сразу" });
    expect(approvalOutlook({ kind: "expense", amountUsd: "200.00", ...finance })).toEqual({ verdict: "pending", text: "Ждёт подтверждения владельца" });
  });

  it("нет оценки в долларах — ждёт: неизвестное не мелочь", () => {
    expect(approvalOutlook({ kind: "expense", amountUsd: null, ...finance }).verdict).toBe("pending");
  });

  it("оценка ещё не получена или порог неизвестен — честно «решит сервер», а не угадывание", () => {
    expect(approvalOutlook({ kind: "expense", amountUsd: undefined, ...finance }).verdict).toBe("unknown");
    expect(approvalOutlook({ kind: "expense", amountUsd: "50.00", canApprove: false, thresholdUsd: null }).verdict).toBe("unknown");
    expect(approvalOutlook({ kind: "expense", amountUsd: "50.00", canApprove: false, thresholdUsd: null }).text).toContain("порог");
  });
});

describe("предупреждение о чеке НПД (Р221)", () => {
  const WARNING = "Без чека НПД: налог периода не досчитается";

  it("поступление и обмен в рубли без чека — предупреждение", () => {
    expect(receiptWarning({ kind: "income", ...BASE, to: "bank.rub", article: "ads_adsgram", amount: "1", forMonth: "2026-10" }, CHART)).toBe(WARNING);
    expect(receiptWarning({ kind: "exchange", ...BASE, from: "wallet.ton", to: "bank.rub", given: "1", received: "100" }, CHART)).toBe(WARNING);
  });

  it("с чеком, в другую валюту, расход, перевод и заём — нет", () => {
    expect(receiptWarning({ kind: "income", ...BASE, to: "bank.rub", article: "ads_adsgram", amount: "1", forMonth: "2026-10", receipt: { payer: "legal" } }, CHART)).toBeNull();
    expect(receiptWarning({ kind: "income", ...BASE, to: "wallet.ton", article: "ads_adsgram", amount: "1", forMonth: "2026-10" }, CHART)).toBeNull();
    expect(receiptWarning({ kind: "expense", ...BASE, from: "bank.rub", article: "vps", amount: "1" }, CHART)).toBeNull();
    expect(receiptWarning({ kind: "loan", ...BASE, to: "bank.rub", lender: "Иван", amount: "1", premium: "0", repaymentBp: 0 }, CHART)).toBeNull();
  });
});

describe("форма → тело запроса", () => {
  const form = (patch: Partial<FormState>): FormState => ({ ...emptyForm("expense", "2026-11-13"), note: "Оплата сервера", ...patch });

  it("расход: только поля своего вида, пустые необязательные не уходят", () => {
    const result = inputFromForm(form({ kind: "expense", from: "bank.rub", article: "vps", amount: " 1500 " }), CHART);

    expect(result).toEqual({ ok: true, input: { kind: "expense", note: "Оплата сервера", at: "2026-11-13", from: "bank.rub", article: "vps", amount: "1500" } });
  });

  it("ссылка и снимок чека уходят, когда заданы", () => {
    const result = inputFromForm(form({ kind: "expense", from: "bank.rub", article: "vps", amount: "1", link: "https://example.com/a", receiptImage: "a".repeat(64) }), CHART);

    expect(result).toMatchObject({ ok: true, input: { link: "https://example.com/a", receiptImage: "a".repeat(64) } });
  });

  it("заём: ставка в процентах переводится в сотые доли, без премии — «0»", () => {
    const result = inputFromForm(form({ kind: "loan", to: "bank.rub", lender: "Иван Петров", amount: "100000", premium: "", repaymentPercent: "12,5" }), CHART);

    expect(result).toMatchObject({ ok: true, input: { kind: "loan", lender: "Иван Петров", premium: "0", repaymentBp: 1250 } });
    expect(inputFromForm(form({ kind: "loan", to: "bank.rub", lender: "Иван", amount: "1", repaymentPercent: "100,5" }), CHART).ok).toBe(false);
    expect(inputFromForm(form({ kind: "loan", to: "bank.rub", lender: "Иван", amount: "1", repaymentPercent: "abc" }), CHART).ok).toBe(false);
  });

  it("поступление в рубли: плательщик чека, номер и ссылка", () => {
    const result = inputFromForm(
      form({ kind: "income", to: "bank.rub", article: "ads_adsgram", amount: "120.40", forMonth: "2026-10", receiptPayer: "individual", receiptNumber: "20ab", receiptLink: "https://lknpd.nalog.ru/x" }),
      CHART,
    );

    expect(result).toMatchObject({ ok: true, input: { kind: "income", forMonth: "2026-10", receipt: { payer: "individual", number: "20ab", link: "https://lknpd.nalog.ru/x" } } });
  });

  it("чек не уходит, если места в рублях нет: сервер отказал бы", () => {
    const result = inputFromForm(form({ kind: "income", to: "wallet.ton", article: "ads_adsgram", amount: "1", forMonth: "2026-10", receiptPayer: "legal" }), CHART);

    expect(result.ok && "receipt" in result.input).toBe(false);
  });

  it("перевод: комиссия из полей; поля стёрты, а у места есть шаблон — {} «комиссии нет»; шаблона нет — поля не уходят", () => {
    const withFee = inputFromForm(form({ kind: "transfer", from: "exchange.usdt", to: "wallet.usdt-ton", amount: "200.5", feePercent: "1.0025", fixedAmount: "0.05", fixedCurrency: "GRAM", fixedFrom: "wallet.ton" }), CHART);
    expect(withFee).toMatchObject({ ok: true, input: { fee: { amount: "1.0025", fixed: { amount: "0.05", currency: "GRAM", from: "wallet.ton" } } } });

    const erased = inputFromForm(form({ kind: "transfer", from: "exchange.usdt", to: "wallet.usdt-ton", amount: "10" }), CHART);
    expect(erased).toMatchObject({ ok: true, input: { fee: {} } });

    const none = inputFromForm(form({ kind: "transfer", from: "bank.rub", to: "bank.tbank", amount: "10" }), CHART);
    expect(none.ok && "fee" in none.input).toBe(false);
  });

  it("исправление: ключ проводки и причина", () => {
    const result = inputFromForm(form({ kind: "reversal", sourceKey: "op:abc", note: "Не тот счёт" }), CHART);

    expect(result).toEqual({ ok: true, input: { kind: "reversal", note: "Не тот счёт", at: "2026-11-13", sourceKey: "op:abc" } });
  });

  it("нет обязательного — отказ с названием поля, а не пустой запрос", () => {
    const result = inputFromForm(form({ kind: "expense", from: "bank.rub", article: "", amount: "1" }), CHART);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain("Статья");
  });

  it("правка черновика: форма заполняется из ввода и собирается в то же тело", () => {
    const input: OperationInput = { kind: "transfer", ...BASE, from: "bank.rub", to: "bank.tbank", amount: "1000", fee: { amount: "15" }, link: "https://example.com/p" };
    const state = formFromInput(input);

    expect(state).toMatchObject({ kind: "transfer", from: "bank.rub", to: "bank.tbank", amount: "1000", feePercent: "15", link: "https://example.com/p", feeEdited: true });
    expect(inputFromForm(state, CHART)).toEqual({ ok: true, input });
  });

  it("подсказка комиссии: подставляет шаблон места списания в поля формы", () => {
    const state = form({ kind: "exchange", from: "stars.bot.available", to: "wallet.ton", given: "10000", received: "52.3" });

    expect(suggestFee(state, CHART)).toEqual({ feePercent: "100", fixedAmount: "0.050000000", fixedCurrency: "GRAM", fixedFrom: "" });
    expect(suggestFee({ ...state, from: "bank.rub" }, CHART)).toEqual({ feePercent: "", fixedAmount: "", fixedCurrency: "", fixedFrom: "" });
  });
});

// ---- ответы сервера и вызовы маршрутов ----

function operation(patch: Partial<OperationView> = {}): OperationView {
  return {
    operationId: "6f1d3c52-5a0e-4a8e-9d57-0c6f0a2d9b11",
    kind: "expense",
    status: "draft",
    input: { kind: "expense", ...BASE, from: "bank.rub", article: "vps", amount: "1500" },
    amountUsd: "16.20",
    createdBy: "Алина",
    createdAt: "2026-11-13T09:00:00.000Z",
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    templateId: null,
    templatePeriod: null,
    receiptMissing: false,
    entry: null,
    loan: null,
    ...patch,
  };
}

const POSTED = operation({
  operationId: "11111111-1111-4111-8111-111111111111",
  status: "posted",
  entry: {
    entryId: "e1",
    sourceKey: "op:11111111-1111-4111-8111-111111111111",
    at: "2026-11-10T00:00:00.000Z",
    period: "2026-11",
    memo: "Оплата сервера за ноябрь",
    reversalOf: null,
    createdBy: null,
    meta: null,
    lines: [
      { accountId: "bank.rub", accountName: "Банк, ₽", currency: "RUB", amount: "-1500.00" },
      { accountId: "expense.vps.RUB", accountName: "Сервер (VPS), ₽", currency: "RUB", amount: "1500.00" },
    ],
  },
});
const PENDING = operation({
  operationId: "22222222-2222-4222-8222-222222222222",
  status: "pending",
  kind: "exchange",
  input: { kind: "exchange", ...BASE, note: "Вывод 25 000 ⭐", from: "stars.bot.available", to: "wallet.ton", given: "25000", received: "130.5" },
  amountUsd: "325.00",
});
const REJECTED = operation({ operationId: "33333333-3333-4333-8333-333333333333", status: "rejected", decidedBy: "Владелец", decisionNote: "Не наш счёт" });

describe("ответ сервера об операциях", () => {
  it("страница операций разбирается, лишнее поле не мешает", () => {
    const page = { operations: [POSTED, PENDING], next: null, extra: 1 };
    expect(operationPageSchema.safeParse(page).success).toBe(true);
  });

  it("нехватка обязательного поля — ошибка: панель не рисует таблицу с undefined", () => {
    const broken: Record<string, unknown> = { ...POSTED };
    delete broken["status"];
    expect(operationPageSchema.safeParse({ operations: [broken], next: null }).success).toBe(false);
  });

  it("подписи статусов — как в задаче", () => {
    expect(STATUS_LABELS).toEqual({ draft: "Черновик", pending: "Ждёт подтверждения", posted: "Проведена", rejected: "Отклонена" });
  });

  it("запрос списка: пустой фильтр не уходит, курсор — отдельным параметром; «Показать ещё» без повторов", () => {
    expect(operationsQuery({}, null)).toEqual({});
    expect(operationsQuery({ status: "pending" }, "abc")).toEqual({ status: "pending", cursor: "abc" });
    expect(mergeOperations([POSTED], [POSTED, PENDING]).map((item) => item.status)).toEqual(["posted", "pending"]);
  });

  it("блок «На подтверждении» — только ждущие", () => {
    expect(pendingOperations([POSTED, PENDING, REJECTED]).map((item) => item.operationId)).toEqual([PENDING.operationId]);
  });
});

describe("вызовы маршрутов учёта", () => {
  it("список: GET с фильтром и курсором", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { operations: [POSTED], next: null } }));

    const result = await loadOperations(new AdminApi(fetch), { status: "pending" }, "cur");

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("/api/v1/admin/ledger/operations?status=pending&cursor=cur");
  });

  it("создание — POST, правка — PATCH с телом операции; ответ — операция", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { operation: operation() } }), json(200, { data: { operation: operation() } }));
    const api = new AdminApi(fetch);
    const input: OperationInput = { kind: "expense", ...BASE, from: "bank.rub", article: "vps", amount: "1500" };

    await saveOperation(api, input, null);
    await saveOperation(api, input, "6f1d3c52-5a0e-4a8e-9d57-0c6f0a2d9b11");

    expect(calls[0]?.url).toBe("/api/v1/admin/ledger/operations");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(input);
    expect(calls[1]?.url).toBe("/api/v1/admin/ledger/operations/6f1d3c52-5a0e-4a8e-9d57-0c6f0a2d9b11");
    expect(calls[1]?.init.method).toBe("PATCH");
  });

  it("проведение, удаление черновика, решение владельца — свои маршруты; комментарий подтверждения необязателен", async () => {
    const { fetch, calls } = fakeFetch(
      json(200, { data: { operation: operation() } }),
      json(200, { data: { ok: true } }),
      json(200, { data: { operation: operation() } }),
      json(200, { data: { operation: operation() } }),
    );
    const api = new AdminApi(fetch);
    const id = "6f1d3c52-5a0e-4a8e-9d57-0c6f0a2d9b11";

    await submitOperation(api, id);
    await discardOperation(api, id);
    await approveOperation(api, id, undefined);
    await rejectOperation(api, id, "Не наш счёт");

    expect(calls.map((call) => call.url.replace("/api/v1/admin/ledger/operations/", ""))).toEqual([`${id}/submit`, `${id}/discard`, `${id}/approve`, `${id}/reject`]);
    expect(JSON.parse(String(calls[2]?.init.body ?? "{}"))).toEqual({});
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({ note: "Не наш счёт" });
  });

  it("«Расходы месяца»: период ГГГГ-ММ, итог разбирается", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { period: "2026-11", created: 2, existing: 1, failed: [{ templateId: "t1", name: "VPS", reason: "Место в архиве" }] } }));

    const result = await draftPeriod(new AdminApi(fetch), "2026-11");

    expect(calls[0]?.url).toBe("/api/v1/admin/ledger/templates/draft-period");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ period: "2026-11" });
    expect(result.ok && result.data.created).toBe(2);
  });

  it("ошибка сервера 409 и 400 приходит текстом сервера, а не нашим", async () => {
    const { fetch } = fakeFetch(
      json(409, { error: { code: "ledger_operation_not_pending", message: "Операция «x»: проведена — решение принимается только по операции, которая ждёт подтверждения" } }),
      json(400, { error: { code: "ledger_operation_invalid", message: "Откуда: места хранения «bank.x» нет" } }),
    );
    const api = new AdminApi(fetch);

    const approve = await approveOperation(api, "6f1d3c52-5a0e-4a8e-9d57-0c6f0a2d9b11", undefined);
    const save = await saveOperation(api, { kind: "expense", ...BASE, from: "bank.x", article: "vps", amount: "1" }, null);

    expect(!approve.ok && approve.error.message).toContain("решение принимается только по операции, которая ждёт");
    expect(!save.ok && save.error.message).toBe("Откуда: места хранения «bank.x» нет");
  });
});

describe("карточка операции", () => {
  const noop = () => undefined;
  const card = (item: OperationView, patch: { canApprove?: boolean; canEdit?: boolean } = {}) =>
    plain(
      renderToStaticMarkup(
        createElement(OperationCard, {
          operation: item,
          places: CHART.places,
          articles: ARTICLES,
          canApprove: patch.canApprove ?? false,
          canEdit: patch.canEdit ?? false,
          busy: false,
          onApprove: noop,
          onReject: noop,
          onSubmit: noop,
          onEdit: noop,
          onDiscard: noop,
          onFix: noop,
        }),
      ),
    );

  it("кнопки решения — только с правом `finance.operation.approve`", () => {
    expect(card(PENDING, { canApprove: true })).toContain("Подтвердить");
    expect(card(PENDING, { canApprove: true })).toContain("Отклонить");
    const finance = card(PENDING, { canEdit: true });
    expect(finance).not.toContain("Подтвердить");
    expect(finance).not.toContain("Отклонить");
    expect(finance).toContain("Ждёт подтверждения");
  });

  it("решать можно только ожидающую: у проведённой кнопок решения нет", () => {
    expect(card(POSTED, { canApprove: true })).not.toContain("Подтвердить");
  });

  it("проведённая не правится: есть «Исправить» (сторно), «Править» нет; черновик — наоборот", () => {
    const posted = card(POSTED, { canEdit: true });
    expect(posted).toContain("Исправить");
    expect(posted).not.toContain("Править");
    const draft = card(operation(), { canEdit: true });
    expect(draft).toContain("Править");
    expect(draft).toContain("Провести");
    expect(draft).not.toContain("Исправить");
    expect(card(operation(), { canEdit: false })).not.toContain("Провести");
  });

  it("показывает вид, сумму в валюте и ≈ $, причину отказа и подпись статуса", () => {
    const text = card(REJECTED);
    expect(text).toContain("Отклонена");
    expect(text).toContain("Не наш счёт");
    expect(text).toContain("Расход");
    expect(text).toContain("1 500,00 ₽");
    expect(text).toContain("≈ 16,20 $");
    expect(card(PENDING)).toContain("25 000 ⭐");
  });

  it("зачисление в рубли без чека помечено", () => {
    expect(card(operation({ status: "posted", receiptMissing: true }))).toContain("Без чека НПД");
  });
});
