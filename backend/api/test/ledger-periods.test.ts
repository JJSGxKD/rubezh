import { Decimal, type CurrencyCode } from "@bh/fx";
import { describe, expect, it } from "vitest";
import type { AccountType, EntryLine, LedgerAccount } from "@bh/ledger";
import { findEntryProblems } from "@bh/ledger";
import { DomainError } from "../src/common/domain-error.js";
import type { RateOnDate } from "../src/modules/fx/fx-history.js";
import type { FxService } from "../src/modules/fx/fx.service.js";
import { LedgerService } from "../src/modules/ledger/ledger.service.js";
import type { LedgerRepository, NewLedgerEntry, StoredLedgerEntry, StoredLedgerAccount, InsertResult } from "../src/modules/ledger/ledger.repository.js";
import { buildChecklist, hasBlockers, type ChecklistInput } from "../src/modules/ledger/periods/checklist.js";
import { computeClose, closeEntries, recomputeFromSnapshot, type CloseInput } from "../src/modules/ledger/periods/period-close.js";
import { groupOf, npdTax, rateKey, rateQueries, valueLines, waterfallLines, type FactLine, type Receipt } from "../src/modules/ledger/periods/period-facts.js";
import { closeKey, closePrefix, isEnded, isPeriod, periodRange, reopenKey } from "../src/modules/ledger/periods/period-rules.js";
import { parseSnapshot } from "../src/modules/ledger/periods/period-snapshot.js";
import type { ClosePlan, CloseOutcome, MonthSource, PeriodRow, PeriodsRepository, ReopenOutcome, ReopenPlan, ReviewOutcome } from "../src/modules/ledger/periods/period-types.js";
import type { PeriodHooks } from "../src/modules/ledger/periods/period-hooks.js";
import { PeriodsService } from "../src/modules/ledger/periods/periods.service.js";
import type { RolesService } from "../src/modules/roles/roles.service.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import type { SettingsReader } from "../src/modules/settings/settings.service.js";
import type { AuditEntry } from "../src/modules/roles/roles.repository.js";

/**
 * Закрытие месяца учёта без базы (Р222, docs/37-accounting.md §13, tasks/T-0468): правила месяца, оценка проводок
 * по курсу их дня, налог с чеков двух ставок, чек-лист блокеров и предупреждений, водопад и рублёвые долги из него,
 * снимок для пересчёта без базы, состояния месяца в сервисе и замок закрытого месяца в журнале. Что делает база
 * (транзакция закрытия, гонка двух закрытий, сторно) — `ledger-periods.integration.test.ts`.
 */

const NOW = new Date("2026-12-02T10:00:00.000Z");
const PERIOD = "2026-11";
const OWNER = { accountId: "00000000-0000-4000-8000-0000000000a0", platform: "telegram", platformUserId: "9001" } as const;
const ALICE = "00000000-0000-4000-8000-0000000000a1";
const BOB = "00000000-0000-4000-8000-0000000000b2";

// ---------------------------------------------------------------------------------------------------------------
// Курсы: звезда дорожает 15 ноября, рубль в ноябре стоит 0,0125 доллара, а в день закрытия — 0,0123
// ---------------------------------------------------------------------------------------------------------------

function rate(usdPerUnit: string, at: string, stale = false): RateOnDate {
  return { usdPerUnit: new Decimal(usdPerUnit), at: new Date(at), stale, source: "market" };
}

function rateFor(currency: string, at: Date): RateOnDate | null {
  if (currency === "USD") return { usdPerUnit: new Decimal(1), at, stale: false, source: "market" };
  if (currency === "XTR") return at.getTime() < Date.UTC(2026, 10, 15) ? rate("0.013", "2026-11-01T00:00:00.000Z") : rate("0.014", "2026-11-15T00:00:00.000Z");
  if (currency === "RUB") return at.getTime() < Date.UTC(2026, 11, 1) ? rate("0.0125", "2026-11-01T00:00:00.000Z") : rate("0.0123", "2026-12-01T00:00:00.000Z");
  return null;
}

const lookupFor = (lines: readonly FactLine[], answer: (currency: string, at: Date) => RateOnDate | null = rateFor) =>
  new Map(rateQueries(lines, []).map((query) => [rateKey(query.currency, query.at), answer(query.currency, query.at)] as const));

// ---------------------------------------------------------------------------------------------------------------
// Проводки ноября: выручка магазина в звёздах, реклама и расходы в рублях, комиссия вывода в звёздах
// ---------------------------------------------------------------------------------------------------------------

function line(accountId: string, type: AccountType, currency: string, at: string, minor: bigint, accountName = accountId): FactLine {
  return { accountId, accountName, type, currency, at: new Date(at), minor };
}

const SHOP = "revenue.shop.telegram";
const NOVEMBER: FactLine[] = [
  line(SHOP, "revenue", "XTR", "2026-11-05T12:00:00.000Z", -6_000n, "Выручка: магазин, Telegram"),
  line(SHOP, "revenue", "XTR", "2026-11-06T12:00:00.000Z", -4_000n, "Выручка: магазин, Telegram"),
  line(SHOP, "revenue", "XTR", "2026-11-20T12:00:00.000Z", -5_000n, "Выручка: магазин, Telegram"),
  line("income.ads_adsgram.RUB", "revenue", "RUB", "2026-11-10T12:00:00.000Z", -800_000n, "Поступление: AdsGram"),
  line("expense.vps.RUB", "expense", "RUB", "2026-11-12T12:00:00.000Z", 200_000n, "Расход: сервер"),
  line("expense.fee_withdrawal.XTR", "expense", "XTR", "2026-11-20T13:00:00.000Z", 100n, "Комиссия вывода"),
  // налог, начисленный закрытием, в водопад не входит: он считается заново
  line("expense.tax_accrued.RUB", "expense", "RUB", "2026-12-02T09:00:00.000Z", 10_000n, "Налог: начислено"),
];

const receipt = (payer: "individual" | "legal", rubMinor: bigint, key: string): Receipt => ({
  entryId: `entry-${key}`,
  sourceKey: `op:${key}`,
  at: new Date("2026-11-25T12:00:00.000Z"),
  period: PERIOD,
  payer,
  rubMinor,
  number: null,
  link: null,
});
const RECEIPTS: Receipt[] = [receipt("individual", 4_000_000n, "r1"), receipt("legal", 1_000_000n, "r2")];

const SETTINGS_NPD = { npdRateIndividualBp: 400, npdRateLegalBp: 600, npdYearLimitRub: 2_400_000, npdWarnPercent: 80 };

// ---------------------------------------------------------------------------------------------------------------
describe("правила месяца учёта", () => {
  it("месяц — «ГГГГ-ММ» с месяцем от 01 до 12", () => {
    expect(["2026-11", "1999-01", "2026-12"].every(isPeriod)).toBe(true);
    expect(["2026-13", "2026-00", "2026-1", "26-11", "2026-11-01", ""].some(isPeriod)).toBe(false);
  });

  it("границы месяца по UTC: с первого числа включительно до первого числа следующего", () => {
    expect(periodRange("2026-11")).toEqual({ from: new Date("2026-11-01T00:00:00.000Z"), to: new Date("2026-12-01T00:00:00.000Z") });
    expect(periodRange("2026-12").to).toEqual(new Date("2027-01-01T00:00:00.000Z"));
  });

  it("месяц кончился, только когда наступил следующий: на сверку ставится прошлый или ещё более ранний", () => {
    expect(isEnded("2026-11", new Date("2026-11-30T23:59:59.999Z"))).toBe(false);
    expect(isEnded("2026-11", new Date("2026-12-01T00:00:00.000Z"))).toBe(true);
    expect(isEnded("2027-01", NOW)).toBe(false);
  });

  it("ключи проводок закрытия несут месяц и номер раза: повторное закрытие не конфликтует с первым", () => {
    expect(closeKey("2026-11", 0, "tax")).toBe("close:2026-11:r0:tax");
    expect(closeKey("2026-11", 1, `payout:${ALICE}`)).toBe(`close:2026-11:r1:payout:${ALICE}`);
    expect(closePrefix("2026-11", 1)).toBe("close:2026-11:r1:");
    // r1 — не префикс r10
    expect(closeKey("2026-11", 10, "tax").startsWith(closePrefix("2026-11", 1))).toBe(false);
  });

  it("сторно проводки закрытия — свой ключ: журнал различает закрытие и его снятие", () => {
    expect(reopenKey("close:2026-11:r0:tax")).toBe("reopen:2026-11:r0:tax");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("счета, которые входят в водопад", () => {
  it("выручка — revenue.*, прочие поступления — income.*, расходы — expense.*, кроме начисленного налога", () => {
    expect(groupOf("revenue.shop.telegram", "revenue")).toBe("revenue");
    expect(groupOf("income.ads_adsgram.RUB", "revenue")).toBe("income");
    expect(groupOf("expense.vps.RUB", "expense")).toBe("expense");
    expect(groupOf("expense.tax_accrued.RUB", "expense")).toBeNull();
  });

  it("места хранения, обязательства и капитал в водопад не входят", () => {
    expect(groupOf("stars.bot.hold", "asset")).toBeNull();
    expect(groupOf("liability.tax.RUB", "liability")).toBeNull();
    expect(groupOf("equity.distribution.RUB", "equity")).toBeNull();
    // имя счёта не решает: у выручки по типу «обязательство» префикса revenue быть не может
    expect(groupOf("revenue.x", "liability")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("оценка проводок месяца по курсу их дня", () => {
  it("каждая проводка — по курсу своего дня: звёзды до и после 15 ноября оцениваются по-разному", () => {
    const valuation = valueLines(NOVEMBER, lookupFor(NOVEMBER));
    const shop = valuation.buckets.filter((bucket) => bucket.accountId === SHOP);
    // пятое и шестое ноября — один курс и одна корзина, двадцатое — другой курс
    expect(shop.map((bucket) => [bucket.usdPerUnit, bucket.minor])).toEqual([
      ["0.013", 10_000n],
      ["0.014", 5_000n],
    ]);
    expect(valuation.missing).toEqual([]);
  });

  it("в центах: выручка 130 + 70 долларов, реклама 100, сервер 25, комиссия 1,40; начисленный налог пропущен", () => {
    const lines = waterfallLines(valueLines(NOVEMBER, lookupFor(NOVEMBER)).buckets);
    expect(lines.revenue).toEqual([{ key: SHOP, amount: 20_000n }]);
    expect(lines.otherIncome).toEqual([{ key: "income.ads_adsgram.RUB", amount: 10_000n }]);
    expect(lines.expenses).toEqual([
      { key: "expense.fee_withdrawal.XTR", amount: 140n },
      { key: "expense.vps.RUB", amount: 2_500n },
    ]);
  });

  it("курс по минутам одного дня не склеивает разные курсы: корзина — это счёт и действовавший курс", () => {
    const lines = [line("expense.vps.RUB", "expense", "RUB", "2026-11-12T01:00:00.000Z", 100_000n), line("expense.vps.RUB", "expense", "RUB", "2026-11-12T23:00:00.000Z", 100_000n)];
    const answer = (_currency: string, at: Date) => (at.getUTCHours() < 12 ? rate("0.0100", "2026-11-12T00:00:00.000Z") : rate("0.0200", "2026-11-12T12:00:00.000Z"));
    const valuation = valueLines(lines, lookupFor(lines, answer));
    expect(valuation.buckets).toHaveLength(2);
    // 1000 ₽ × 0,01 + 1000 ₽ × 0,02 = 30 долларов
    expect(waterfallLines(valuation.buckets).expenses).toEqual([{ key: "expense.vps.RUB", amount: 3_000n }]);
  });

  it("нет курса на дату проводки — это блокер: валюта и день названы, сумма в доллары не превращается", () => {
    const valuation = valueLines(NOVEMBER, lookupFor(NOVEMBER, (currency, at) => (currency === "XTR" && at.getUTCDate() === 20 ? null : rateFor(currency, at))));
    expect(valuation.missing).toEqual([{ currency: "XTR", day: "2026-11-20" }]);
    expect(valuation.buckets.some((bucket) => bucket.currency === "XTR" && bucket.usdPerUnit === "0.014")).toBe(false);
  });

  it("валюта вне справочника курсов — тоже «нет курса», а не молчаливый ноль", () => {
    const lines = [line("expense.odd.ABC", "expense", "ABC", "2026-11-03T00:00:00.000Z", 5n)];
    expect(valueLines(lines, lookupFor(lines)).missing).toEqual([{ currency: "ABC", day: "2026-11-03" }]);
  });

  it("устаревший курс не мешает закрыть, но попадает в предупреждения: день и валюта", () => {
    const stale = (currency: string, at: Date) => (currency === "RUB" ? { ...rate("0.0125", "2026-10-01T00:00:00.000Z"), stale: true } : rateFor(currency, at));
    const valuation = valueLines(NOVEMBER, lookupFor(NOVEMBER, stale));
    expect(valuation.missing).toEqual([]);
    expect(valuation.stale.map((item) => `${item.currency}:${item.day}`)).toEqual(["RUB:2026-11-10", "RUB:2026-11-12"]);
  });

  it("выручка с возвратами больше самих продаж не ломает водопад: минус уходит в расходы, итог тот же", () => {
    const lines = [line(SHOP, "revenue", "XTR", "2026-11-05T12:00:00.000Z", 500n)];
    const result = waterfallLines(valueLines(lines, lookupFor(lines)).buckets);
    expect(result.revenue).toEqual([]);
    // 500 звёзд × 0,013 = 6,50 доллара
    expect(result.expenses).toEqual([{ key: `contra:${SHOP}`, amount: 650n }]);
  });

  it("расход с обратным знаком (сторно расхода) становится прочим доходом на ту же сумму", () => {
    const lines = [line("expense.vps.RUB", "expense", "RUB", "2026-11-12T12:00:00.000Z", -200_000n)];
    const result = waterfallLines(valueLines(lines, lookupFor(lines)).buckets);
    expect(result.expenses).toEqual([]);
    expect(result.otherIncome).toEqual([{ key: "contra:expense.vps.RUB", amount: 2_500n }]);
  });

  it("расходы округляются вверх, выручка вниз: учёт не завышает прибыль на долю цента", () => {
    const lines = [line(SHOP, "revenue", "XTR", "2026-11-05T12:00:00.000Z", -1n), line("expense.vps.RUB", "expense", "RUB", "2026-11-05T12:00:00.000Z", 1n)];
    const result = waterfallLines(valueLines(lines, lookupFor(lines)).buckets);
    // 1 звезда = 0,013 доллара = 1,3 цента → 1; 1 копейка = 0,000125 доллара = 0,0125 цента → 1
    expect(result.revenue).toEqual([{ key: SHOP, amount: 1n }]);
    expect(result.expenses).toEqual([{ key: "expense.vps.RUB", amount: 1n }]);
  });

  it("запросы курсов — по одному на валюту и момент, без дублей и без счетов вне водопада", () => {
    const queries = rateQueries(NOVEMBER, [{ currency: "RUB", at: NOW }]);
    const keys = queries.map((query) => rateKey(query.currency, query.at));
    expect(new Set(keys).size).toBe(keys.length);
    // налог, начисленный закрытием, курса не требует; а курс рубля на день закрытия добавлен вызывающим
    expect(queries.filter((query) => query.at.getTime() === Date.parse("2026-12-02T09:00:00.000Z"))).toEqual([]);
    expect(queries.some((query) => query.currency === "RUB" && query.at.getTime() === NOW.getTime())).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("налог НПД с чеков месяца", () => {
  it("физлицо — 4 %, юрлицо — 6 %: 40 000 ₽ и 10 000 ₽ дают 1 600 ₽ и 600 ₽", () => {
    const tax = npdTax(RECEIPTS, { individualBp: 400, legalBp: 600 });
    expect(tax.byPayer).toEqual([
      { payer: "individual", rubMinor: 4_000_000n, bp: 400, taxMinor: 160_000n },
      { payer: "legal", rubMinor: 1_000_000n, bp: 600, taxMinor: 60_000n },
    ]);
    expect(tax.taxMinor).toBe(220_000n);
  });

  it("налог округляется вверх до копейки: обязательство не занижается", () => {
    // 100,01 ₽ × 4 % = 4,0004 ₽ → 4,01 ₽
    expect(npdTax([receipt("individual", 10_001n, "x")], { individualBp: 400, legalBp: 600 }).taxMinor).toBe(401n);
  });

  it("ставки — настройки: смена ставки меняет налог, а чеков нет — нулевой налог и пустая разбивка", () => {
    expect(npdTax([receipt("legal", 1_000_000n, "y")], { individualBp: 400, legalBp: 100 }).taxMinor).toBe(10_000n);
    expect(npdTax([], { individualBp: 400, legalBp: 600 })).toEqual({ byPayer: [], taxMinor: 0n });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("чек-лист сверки", () => {
  const CLEAN: ChecklistInput = {
    period: PERIOD,
    openOperations: [],
    unpostedPurchaseIds: [],
    missingRates: [],
    staleRates: [],
    receiptsMissing: [],
    npd: { yearReceiptsMinor: 0n, limitRub: 2_400_000, warnPercent: 80 },
    sharesOverLimit: false,
  };
  const only = (patch: Partial<ChecklistInput>) => buildChecklist({ ...CLEAN, ...patch });

  it("чистый месяц — пустой чек-лист и можно закрывать", () => {
    expect(buildChecklist(CLEAN)).toEqual([]);
    expect(hasBlockers([])).toBe(false);
  });

  it("операция на подтверждении — блокер со ссылкой на операцию: «1 операция ждёт подтверждения»", () => {
    const items = only({ openOperations: [{ operationId: "op-1", status: "pending" }] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ code: "operations_pending", severity: "blocker", count: 1, refs: [{ kind: "operation", id: "op-1" }], moreRefs: 0 });
    expect(items[0]?.message).toBe("1 операция ждёт подтверждения");
    expect(hasBlockers(items)).toBe(true);
  });

  it("черновики операций месяца — отдельный блокер; число и падеж следуют за количеством", () => {
    const items = only({
      openOperations: [
        { operationId: "d1", status: "draft" },
        { operationId: "d2", status: "draft" },
        { operationId: "d3", status: "draft" },
        { operationId: "p1", status: "pending" },
        { operationId: "p2", status: "pending" },
      ],
    });
    expect(items.map((item) => [item.code, item.count])).toEqual([
      ["operations_pending", 2],
      ["operations_draft", 3],
    ]);
    expect(items[0]?.message).toBe("2 операции ждут подтверждения");
    expect(items[1]?.message).toBe("3 черновика операций в месяце");
    expect(items.every((item) => item.severity === "blocker")).toBe(true);
  });

  it("оплаты месяца без проводки — блокер: сверка платежей отстала, в ссылках — покупки", () => {
    const items = only({ unpostedPurchaseIds: ["p-1", "p-2", "p-3", "p-4", "p-5"] });
    expect(items[0]).toMatchObject({ code: "payments_unposted", severity: "blocker", count: 5 });
    expect(items[0]?.refs.map((ref) => ref.kind)).toEqual(["purchase", "purchase", "purchase", "purchase", "purchase"]);
    expect(items[0]?.message).toContain("5 оплат месяца без проводки");
    expect(items[0]?.message).toContain("сверка платежей отстала");
  });

  it("нет курса на дату — блокер: валюты и дни в ссылках и в тексте", () => {
    const items = only({
      missingRates: [
        { currency: "XTR", day: "2026-11-20" },
        { currency: "GRAM", day: "2026-11-21" },
      ],
    });
    expect(items[0]).toMatchObject({ code: "rate_missing", severity: "blocker", count: 2 });
    expect(items[0]?.refs).toEqual([
      { kind: "rate", id: "XTR:2026-11-20" },
      { kind: "rate", id: "GRAM:2026-11-21" },
    ]);
    expect(items[0]?.message).toContain("XTR");
    expect(items[0]?.message).toContain("2026-11-20");
  });

  it("рублёвые поступления без чека — предупреждение, не блокер: «2 рублёвых поступления без чека»", () => {
    const items = only({
      receiptsMissing: [
        { entryId: "e1", operationId: "op-a" },
        { entryId: "e2", operationId: null },
      ],
    });
    expect(items[0]).toMatchObject({ code: "receipts_missing", severity: "warning", count: 2 });
    expect(items[0]?.message).toBe("2 рублёвых поступления без чека");
    expect(items[0]?.refs).toEqual([
      { kind: "operation", id: "op-a" },
      { kind: "entry", id: "e2" },
    ]);
    expect(hasBlockers(items)).toBe(false);
  });

  it("устаревший курс — предупреждение: проводки оценены, но по курсу старше недели", () => {
    const items = only({ staleRates: [{ currency: "RUB", day: "2026-11-10" }] });
    expect(items[0]).toMatchObject({ code: "rate_stale", severity: "warning", count: 1 });
    expect(hasBlockers(items)).toBe(false);
  });

  it("лимит НПД: тишина ниже порога предупреждения, предупреждение с порога (80 % от 2,4 млн ₽ — 1 920 000 ₽)", () => {
    expect(only({ npd: { ...CLEAN.npd, yearReceiptsMinor: 191_999_999n } })).toEqual([]);
    const items = only({ npd: { ...CLEAN.npd, yearReceiptsMinor: 192_000_000n } });
    expect(items[0]).toMatchObject({ code: "npd_limit", severity: "warning", count: 1 });
    expect(items[0]?.message).toContain("1 920 000");
    expect(items[0]?.message).toContain("2 400 000");
    expect(items[0]?.message).toContain("80 %");
  });

  it("порог предупреждения — настройка: 100 % — только когда лимит выбран целиком", () => {
    expect(only({ npd: { yearReceiptsMinor: 239_999_999n, limitRub: 2_400_000, warnPercent: 100 } })).toEqual([]);
    expect(only({ npd: { yearReceiptsMinor: 240_000_000n, limitRub: 2_400_000, warnPercent: 100 } })[0]?.code).toBe("npd_limit");
  });

  it("сумма долей участников больше 100 % — блокер: повреждённые данные закрытие не примет", () => {
    expect(only({ sharesOverLimit: true })[0]).toMatchObject({ code: "shares_over_limit", severity: "blocker" });
  });

  it("ссылок в пункте не больше двадцати: остальные — числом, а счёт остаётся полным", () => {
    const ids = Array.from({ length: 27 }, (_, index) => `p-${String(index)}`);
    const item = only({ unpostedPurchaseIds: ids })[0];
    expect(item?.count).toBe(27);
    expect(item?.refs).toHaveLength(20);
    expect(item?.moreRefs).toBe(7);
  });

  it("блокеры идут раньше предупреждений", () => {
    const items = only({ receiptsMissing: [{ entryId: "e1", operationId: null }], openOperations: [{ operationId: "op-1", status: "pending" }], staleRates: [{ currency: "RUB", day: "2026-11-10" }] });
    expect(items.map((item) => item.severity)).toEqual(["blocker", "warning", "warning"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Закрытие: водопад, налог, рублёвые долги и снимок
// ---------------------------------------------------------------------------------------------------------------

const RUB_AT_CLOSE = { usdPerUnit: "0.0123", at: "2026-12-01T00:00:00.000Z", stale: false };

function closeInput(overrides: Partial<CloseInput> = {}): CloseInput {
  const valuation = valueLines(NOVEMBER, lookupFor(NOVEMBER));
  return {
    period: PERIOD,
    round: 0,
    closedAt: NOW,
    settings: SETTINGS_NPD,
    buckets: valuation.buckets,
    receipts: RECEIPTS,
    rubRate: RUB_AT_CLOSE,
    loans: [{ loanId: "loan-1", lender: "Иван", currency: "RUB", remainingMinor: 880_000n, repaymentBp: 1_000, usdPerUnit: "0.0123" }],
    shares: [
      { accountId: ALICE, bp: 2_500, name: "Алиса" },
      { accountId: BOB, bp: 1_000, name: "Боб" },
    ],
    warnings: [],
    ...overrides,
  };
}

describe("закрытие месяца: водопад, налог и долги участникам в рублях", () => {
  const result = computeClose(closeInput());

  it("налог 2 200 ₽ с чеков переводится в доллары по курсу рубля дня закрытия: 27,06 $", () => {
    expect(result.tax.taxMinor).toBe(220_000n);
    // 220 000 копеек × 0,0123 цента за копейку
    expect(result.tax.usdCents).toBe(2_706n);
    expect(result.waterfall.tax).toBe(2_706n);
  });

  it("водопад в центах: прибыль до налога 273,60 $, после — 246,54 $", () => {
    expect(result.waterfall.grossRevenue).toBe(20_000n);
    expect(result.waterfall.totalExpenses).toBe(2_640n);
    expect(result.waterfall.profitBeforeTax).toBe(27_360n);
    expect(result.waterfall.netProfit).toBe(24_654n);
  });

  it("транш займа в рублях переводится по курсу дня закрытия: остаток 8 800 ₽ — это 108,24 $, десять процентов прибыли — 24,65 $", () => {
    expect(result.waterfall.tranches).toEqual([{ loanId: "loan-1", amount: 2_465n, remainingAfter: 8_359n }]);
    expect(result.loans[0]).toMatchObject({ loanId: "loan-1", remainingUsdCents: 10_824n, trancheUsdCents: 2_465n, trancheMinor: 200_406n });
  });

  it("прибыль к разделу 221,89 $: доли 25 % и 10 %, остаток владельцу", () => {
    expect(result.waterfall.toDistribute).toBe(22_189n);
    expect(result.waterfall.payouts.map((payout) => [payout.accountId, payout.amount])).toEqual([
      [ALICE, 5_547n],
      [BOB, 2_218n],
    ]);
    expect(result.waterfall.ownerAmount).toBe(14_424n);
    expect(result.waterfall.noDistribution).toBe(false);
  });

  it("долг участнику — в рублях по курсу дня закрытия и вниз до копейки: 4 509,75 ₽ и 1 803,25 ₽", () => {
    expect(result.rub.payouts).toEqual([
      { accountId: ALICE, bp: 2_500, usdCents: 5_547n, rubMinor: 450_975n },
      { accountId: BOB, bp: 1_000, usdCents: 2_218n, rubMinor: 180_325n },
    ]);
  });

  it("проводки закрытия: налог и долги участникам — под ключами месяца и раза, в рублях, суммы сходятся", () => {
    const { accounts, entries } = closeEntries(result);
    expect(entries.map((entry) => entry.sourceKey)).toEqual(["close:2026-11:r0:tax", `close:2026-11:r0:payout:${ALICE}`, `close:2026-11:r0:payout:${BOB}`]);
    expect(entries[0]?.lines).toEqual([
      { accountId: "expense.tax_accrued.RUB", amount: 220_000n },
      { accountId: "liability.tax.RUB", amount: -220_000n },
    ]);
    expect(entries[1]?.lines).toEqual([
      { accountId: "equity.distribution.RUB", amount: 450_975n },
      { accountId: `liability.stakeholder.${ALICE}.RUB`, amount: -450_975n },
    ]);
    // дата — день закрытия, месяц — закрываемый
    expect(entries.every((entry) => entry.at.getTime() === NOW.getTime() && entry.period === PERIOD)).toBe(true);
    // счета заведены с верными типами, и ядро учёта проводки принимает
    const plan = new Map<string, LedgerAccount>(accounts.map((account) => [account.accountId, { id: account.accountId, type: account.type, currency: account.currency, name: account.name }]));
    expect(plan.get("expense.tax_accrued.RUB")?.type).toBe("expense");
    expect(plan.get("liability.tax.RUB")?.type).toBe("liability");
    expect(plan.get("equity.distribution.RUB")?.type).toBe("equity");
    expect(plan.get(`liability.stakeholder.${ALICE}.RUB`)?.name).toContain("Алиса");
    for (const entry of entries) expect(findEntryProblems({ sourceKey: entry.sourceKey, at: entry.at, memo: entry.memo, lines: entry.lines, period: entry.period }, plan)).toEqual([]);
  });

  it("повторное закрытие после снятия — свой номер раза в ключах", () => {
    const again = closeEntries(computeClose(closeInput({ round: 1 })));
    expect(again.entries.map((entry) => entry.sourceKey)).toEqual(["close:2026-11:r1:tax", `close:2026-11:r1:payout:${ALICE}`, `close:2026-11:r1:payout:${BOB}`]);
  });

  it("доля владельца долгом не проводится: проводок на неё нет, она — только в отчёте", () => {
    const { entries } = closeEntries(result);
    expect(entries.flatMap((entry) => entry.lines).some((entryLine) => entryLine.accountId.includes("owner"))).toBe(false);
    expect(result.waterfall.ownerAmount).toBeGreaterThan(0n);
  });

  it("убыток: выплат и траншей нет, проводки — только налог (чеки были)", () => {
    const loss = computeClose(closeInput({ buckets: valueLines(NOVEMBER.filter((entry) => entry.type === "expense"), lookupFor(NOVEMBER)).buckets }));
    expect(loss.waterfall.noDistribution).toBe(true);
    expect(loss.waterfall.payouts.every((payout) => payout.amount === 0n)).toBe(true);
    expect(loss.waterfall.tranches.every((tranche) => tranche.amount === 0n)).toBe(true);
    expect(loss.rub.payouts.every((payout) => payout.rubMinor === 0n)).toBe(true);
    const { entries } = closeEntries(loss);
    expect(entries.map((entry) => entry.sourceKey)).toEqual(["close:2026-11:r0:tax"]);
  });

  it("без чеков и без прибыли к разделу проводок закрытия нет вовсе: месяц просто закрывается", () => {
    const quiet = computeClose(closeInput({ buckets: [], receipts: [], loans: [], shares: [] }));
    expect(closeEntries(quiet)).toEqual({ accounts: [], entries: [] });
  });

  it("транш займа не больше остатка: заём на 5 $ погашается целиком и не больше", () => {
    const small = computeClose(closeInput({ loans: [{ loanId: "loan-2", lender: "Пётр", currency: "USD", remainingMinor: 500n, repaymentBp: 10_000, usdPerUnit: "1" }] }));
    expect(small.waterfall.tranches).toEqual([{ loanId: "loan-2", amount: 500n, remainingAfter: 0n }]);
    // заём погашен полностью — в снимке то же число в валюте займа: остаток обнулился без хвоста
    expect(small.loans[0]).toMatchObject({ trancheUsdCents: 500n, trancheMinor: 500n });
  });

  it("нет чеков — нет налога и нет нужды в курсе рубля: водопад считается без него", () => {
    const noRub = computeClose(closeInput({ receipts: [], rubRate: null, loans: [], shares: [] }));
    expect(noRub.tax).toEqual({ taxMinor: 0n, usdCents: 0n, byPayer: [] });
    expect(noRub.waterfall.netProfit).toBe(27_360n);
  });

  it("курса рубля нет, а чеки или участники есть — исключение: тихо посчитать в рублях по нулю нельзя", () => {
    expect(() => computeClose(closeInput({ rubRate: null }))).toThrow(/курс рубля/u);
  });
});

describe("снимок закрытия", () => {
  const input = closeInput({ warnings: [{ code: "receipts_missing", severity: "warning", count: 2, message: "2 рублёвых поступления без чека", refs: [], moreRefs: 0 }] });
  const result = computeClose(input);

  it("хранит всё, чем считано: ставки, доли, займы, курсы по корзинам, чеки и итог", () => {
    const { snapshot } = result;
    expect(snapshot).toMatchObject({ version: 1, period: PERIOD, round: 0, closedAt: NOW.toISOString(), settings: SETTINGS_NPD });
    expect(snapshot.rubRate).toEqual(RUB_AT_CLOSE);
    expect(snapshot.shares).toEqual([
      { accountId: ALICE, bp: 2_500 },
      { accountId: BOB, bp: 1_000 },
    ]);
    expect(snapshot.loans[0]).toMatchObject({ loanId: "loan-1", remainingMinor: "880000", repaymentBp: 1_000, usdPerUnit: "0.0123" });
    expect(snapshot.buckets.length).toBeGreaterThan(0);
    expect(snapshot.receipts).toHaveLength(2);
    expect(snapshot.warnings.map((warning) => warning.code)).toEqual(["receipts_missing"]);
    expect(snapshot.entries).toEqual(["close:2026-11:r0:tax", `close:2026-11:r0:payout:${ALICE}`, `close:2026-11:r0:payout:${BOB}`]);
  });

  it("сохраняется в JSON без bigint и читается обратно схемой", () => {
    const json: unknown = JSON.parse(JSON.stringify(result.snapshot));
    const parsed = parseSnapshot(json);
    expect(parsed).toEqual(result.snapshot);
  });

  it("для пересчёта хватает снимка, базы не нужно: из него выходит тот же водопад и те же рубли", () => {
    const parsed = parseSnapshot(JSON.parse(JSON.stringify(result.snapshot)));
    const again = recomputeFromSnapshot(parsed);
    expect(again.waterfall).toEqual(result.snapshot.waterfall);
    expect(again.rub).toEqual(result.snapshot.rub);
  });

  it("смена ставок и долей после закрытия прошлое не трогает: пересчёт идёт по ставкам и долям снимка", () => {
    const parsed = parseSnapshot(JSON.parse(JSON.stringify(result.snapshot)));
    const changed = computeClose(closeInput({ settings: { ...SETTINGS_NPD, npdRateIndividualBp: 1_000 } }));
    expect(changed.tax.taxMinor).not.toBe(220_000n);
    expect(recomputeFromSnapshot(parsed).rub.taxMinor).toBe("220000");
  });

  it("повреждённый снимок схема не пропускает: строка вместо числа и лишний тип — отказ, а не молчаливая подгонка", () => {
    const broken: unknown = JSON.parse(JSON.stringify(result.snapshot));
    (broken as { shares: { bp: unknown }[] }).shares[0]!.bp = "много";
    expect(() => parseSnapshot(broken)).toThrow();
    expect(() => parseSnapshot({ version: 2 })).toThrow();
    expect(() => parseSnapshot(null)).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Сервис месяцев
// ---------------------------------------------------------------------------------------------------------------

function emptySource(): MonthSource {
  return { lines: [], receipts: [], yearReceiptsMinor: 0n, receiptsMissing: [], openOperations: [], unpostedPurchaseIds: [], loans: [], shares: [], fingerprint: "0:-" };
}

function fullSource(): MonthSource {
  return {
    lines: NOVEMBER,
    receipts: RECEIPTS,
    yearReceiptsMinor: 5_000_000n,
    receiptsMissing: [],
    openOperations: [],
    unpostedPurchaseIds: [],
    loans: [{ loanId: "loan-1", lender: "Иван", currency: "RUB", principalMinor: 800_000n, premiumMinor: 80_000n, repaidMinor: 0n, repaymentBp: 1_000, takenAt: new Date("2026-10-01T00:00:00.000Z") }],
    shares: [
      { accountId: ALICE, name: "Алиса", bp: 2_500 },
      { accountId: BOB, name: "Боб", bp: 1_000 },
    ],
    fingerprint: "7:2026-11-30T12:00:00.000Z",
  };
}

function periodRow(overrides: Partial<PeriodRow> = {}): PeriodRow {
  return { period: PERIOD, status: "review", reviewAt: new Date("2026-12-01T09:00:00.000Z"), reviewBy: OWNER.accountId, closedAt: null, closedBy: null, reopenedCount: 0, snapshot: null, updatedAt: NOW, ...overrides };
}

class FakePeriods implements PeriodsRepository {
  readonly rowMap = new Map<string, PeriodRow>();
  source: MonthSource = emptySource();
  firstPeriod: string | null = "2026-10";
  readonly closes: ClosePlan[] = [];
  readonly reopens: ReopenPlan[] = [];
  readonly reviews: { period: string; by: string }[] = [];
  closeResult: CloseOutcome = { outcome: "closed" };
  reopenResult: ReopenOutcome = { outcome: "reopened", reversed: 3 };
  reviewResult: ReviewOutcome = "started";

  async row(period: string): Promise<PeriodRow | null> {
    return this.rowMap.get(period) ?? null;
  }

  async rows(): Promise<PeriodRow[]> {
    return [...this.rowMap.values()];
  }

  async firstEntryPeriod(): Promise<string | null> {
    return this.firstPeriod;
  }

  async loadMonth(): Promise<MonthSource> {
    return this.source;
  }

  async startReview(period: string, by: string): Promise<ReviewOutcome> {
    this.reviews.push({ period, by });
    return this.reviewResult;
  }

  async commitClose(plan: ClosePlan): Promise<CloseOutcome> {
    this.closes.push(plan);
    return this.closeResult;
  }

  async commitReopen(plan: ReopenPlan): Promise<ReopenOutcome> {
    this.reopens.push(plan);
    return this.reopenResult;
  }
}

class FakeHooks implements PeriodHooks {
  payouts = false;
  readonly resets: string[] = [];

  async hasPayouts(): Promise<boolean> {
    return this.payouts;
  }

  async resetConfirmations(period: string): Promise<void> {
    this.resets.push(period);
  }
}

function service(): { periods: PeriodsService; repository: FakePeriods; hooks: FakeHooks; audit: AuditEntry[]; fxCalls: number[] } {
  const repository = new FakePeriods();
  const hooks = new FakeHooks();
  const audit: AuditEntry[] = [];
  const fxCalls: number[] = [];
  const fx = {
    ratesAt: async (queries: readonly { currency: CurrencyCode; at: Date }[]) => {
      fxCalls.push(queries.length);
      return queries.map((query) => rateFor(query.currency, query.at));
    },
  } as unknown as FxService;
  const settings: SettingsReader = { get: (setting) => setting.fallback, onChange: () => undefined };
  const roles = { audit: async (entry: AuditEntry) => void audit.push(entry) } as unknown as RolesService;
  return { periods: new PeriodsService(repository, fx, settings, roles, hooks), repository, hooks, audit, fxCalls };
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

describe("настройки НПД — четыре ключа в каталоге", () => {
  it("ставки 4 и 6 %, лимит 2,4 млн ₽ и порог предупреждения 80 %", () => {
    expect(SETTINGS.financeNpdRateIndividualBp).toMatchObject({ key: "finance.npd-rate-individual-bp", fallback: 400 });
    expect(SETTINGS.financeNpdRateLegalBp).toMatchObject({ key: "finance.npd-rate-legal-bp", fallback: 600 });
    expect(SETTINGS.financeNpdYearLimitRub).toMatchObject({ key: "finance.npd-year-limit-rub", fallback: 2_400_000 });
    expect(SETTINGS.financeNpdWarnPercent).toMatchObject({ key: "finance.npd-warn-percent", fallback: 80 });
  });

  it("пределы не пускают ставку выше 100 %, нулевой лимит и порог выше 100 %", () => {
    expect(SETTINGS.financeNpdRateIndividualBp.schema.safeParse(10_001).success).toBe(false);
    expect(SETTINGS.financeNpdRateLegalBp.schema.safeParse(-1).success).toBe(false);
    expect(SETTINGS.financeNpdYearLimitRub.schema.safeParse(0).success).toBe(false);
    expect(SETTINGS.financeNpdWarnPercent.schema.safeParse(101).success).toBe(false);
    expect(SETTINGS.financeNpdWarnPercent.schema.safeParse(80).success).toBe(true);
  });
});

describe("сервис месяцев: сверка", () => {
  it("на сверку ставится прошлый месяц: статус «на сверке», аудит с автором", async () => {
    const { periods, repository, audit } = service();
    await periods.startReview(OWNER, PERIOD, NOW);
    expect(repository.reviews).toEqual([{ period: PERIOD, by: OWNER.accountId }]);
    expect(audit).toEqual([expect.objectContaining({ actorAccountId: OWNER.accountId, action: "ledger.period.review", target: PERIOD })]);
  });

  it("текущий и будущий месяц на сверку не идут: он ещё не кончился", async () => {
    const { periods, repository } = service();
    expect((await domainError(periods.startReview(OWNER, "2026-12", NOW))).code).toBe("ledger_period_not_ended");
    expect((await domainError(periods.startReview(OWNER, "2027-03", NOW))).code).toBe("ledger_period_not_ended");
    expect(repository.reviews).toEqual([]);
  });

  it("повторная постановка на сверку безопасна и второго аудита не пишет", async () => {
    const { periods, repository, audit } = service();
    repository.reviewResult = "already";
    await periods.startReview(OWNER, PERIOD, NOW);
    expect(audit).toEqual([]);
  });

  it("закрытый месяц на сверку не возвращается: для этого есть снятие закрытия", async () => {
    const { periods, repository } = service();
    repository.reviewResult = "closed";
    expect((await domainError(periods.startReview(OWNER, PERIOD, NOW))).code).toBe("ledger_period_status");
  });

  it("месяц не вида «ГГГГ-ММ» — ошибка запроса, а не поход в базу", async () => {
    const { periods, repository } = service();
    expect((await domainError(periods.startReview(OWNER, "2026-13", NOW))).code).toBe("validation_failed");
    expect(repository.reviews).toEqual([]);
  });
});

describe("сервис месяцев: чек-лист и черновик отчёта", () => {
  it("отчёт месяца на сверке: блокеры видны, черновик водопада посчитан, закрыть нельзя", async () => {
    const { periods, repository } = service();
    repository.rowMap.set(PERIOD, periodRow());
    repository.source = { ...fullSource(), openOperations: [{ operationId: "op-1", status: "pending" }] };
    const report = await periods.report(PERIOD, NOW);
    expect(report.status).toBe("review");
    expect(report.canClose).toBe(false);
    expect(report.checklist.map((item) => item.code)).toEqual(["operations_pending"]);
    expect(report.reportIsDraft).toBe(true);
    expect(report.report?.netProfit).toBe("246.54");
    expect(report.report?.payouts.map((payout) => [payout.name, payout.rub])).toEqual([
      ["Алиса", "4509.75"],
      ["Боб", "1803.25"],
    ]);
  });

  it("нет курса на дату проводки — отчёта нет, а в чек-листе блокер: считать по выдуманному курсу нельзя", async () => {
    const { periods, repository } = service();
    repository.rowMap.set(PERIOD, periodRow());
    repository.source = { ...fullSource(), lines: NOVEMBER.map((entry) => (entry.currency === "XTR" ? { ...entry, currency: "ABC" } : entry)) };
    const report = await periods.report(PERIOD, NOW);
    expect(report.checklist[0]).toMatchObject({ code: "rate_missing", severity: "blocker" });
    expect(report.report).toBeNull();
    expect(report.canClose).toBe(false);
  });

  it("месяц без строки — «открыт»: отчёт и чек-лист всё равно доступны", async () => {
    const { periods, repository } = service();
    repository.source = emptySource();
    const report = await periods.report(PERIOD, NOW);
    expect(report).toMatchObject({ period: PERIOD, status: "open", reopenedCount: 0 });
  });

  it("список месяцев: от первого месяца с проводками до текущего, статусы из строк, остальные открыты", async () => {
    const { periods, repository } = service();
    repository.firstPeriod = "2026-09";
    repository.rowMap.set("2026-10", periodRow({ period: "2026-10", status: "closed", closedAt: new Date("2026-11-03T00:00:00.000Z") }));
    const list = await periods.list(NOW);
    expect(list.map((item) => [item.period, item.status])).toEqual([
      ["2026-12", "open"],
      ["2026-11", "open"],
      ["2026-10", "closed"],
      ["2026-09", "open"],
    ]);
  });

  it("список без единой проводки — только текущий месяц", async () => {
    const { periods, repository } = service();
    repository.firstPeriod = null;
    expect((await periods.list(NOW)).map((item) => item.period)).toEqual(["2026-12"]);
  });
});

describe("сервис месяцев: закрытие", () => {
  it("закрывает чистый месяц: план закрытия с проводками, снимком и отпечатком; аудит `ledger.period.close`", async () => {
    const { periods, repository, audit } = service();
    repository.rowMap.set(PERIOD, periodRow());
    repository.source = fullSource();
    await periods.close(OWNER, PERIOD, NOW);
    expect(repository.closes).toHaveLength(1);
    const plan = repository.closes[0]!;
    expect(plan).toMatchObject({ period: PERIOD, round: 0, closedBy: OWNER.accountId, closedAt: NOW, fingerprint: "7:2026-11-30T12:00:00.000Z" });
    expect(plan.entries.map((entry) => entry.sourceKey)).toEqual(["close:2026-11:r0:tax", `close:2026-11:r0:payout:${ALICE}`, `close:2026-11:r0:payout:${BOB}`]);
    expect(plan.snapshot.waterfall.netProfit).toBe("24654");
    expect(plan.snapshot.settings).toEqual(SETTINGS_NPD);
    expect(audit).toEqual([expect.objectContaining({ actorAccountId: OWNER.accountId, action: "ledger.period.close", target: PERIOD })]);
  });

  it("остаток займа — тело плюс премия минус погашенное: 8 800 ₽ минус уже погашенные 1 000 ₽ дают другой транш", async () => {
    const { periods, repository } = service();
    repository.rowMap.set(PERIOD, periodRow());
    const source = fullSource();
    repository.source = { ...source, loans: [{ ...source.loans[0]!, repaidMinor: 100_000n }] };
    await periods.close(OWNER, PERIOD, NOW);
    expect(repository.closes[0]?.snapshot.loans[0]).toMatchObject({ remainingMinor: "780000" });
  });

  it("повторное закрытие после снятия берёт следующий номер раза", async () => {
    const { periods, repository } = service();
    repository.rowMap.set(PERIOD, periodRow({ reopenedCount: 1 }));
    repository.source = fullSource();
    await periods.close(OWNER, PERIOD, NOW);
    expect(repository.closes[0]?.round).toBe(1);
    expect(repository.closes[0]?.entries[0]?.sourceKey).toBe("close:2026-11:r1:tax");
  });

  it("с блокером месяц не закрывается: 409, в базу ничего не пишется, в тексте — что мешает", async () => {
    const { periods, repository, audit } = service();
    repository.rowMap.set(PERIOD, periodRow());
    repository.source = { ...fullSource(), openOperations: [{ operationId: "op-1", status: "pending" }] };
    const error = await domainError(periods.close(OWNER, PERIOD, NOW));
    expect(error).toMatchObject({ code: "ledger_period_blocked", status: 409 });
    expect(error.message).toContain("1 операция ждёт подтверждения");
    expect(repository.closes).toEqual([]);
    expect(audit).toEqual([]);
  });

  it("предупреждения закрытию не мешают и остаются в снимке", async () => {
    const { periods, repository } = service();
    repository.rowMap.set(PERIOD, periodRow());
    repository.source = { ...fullSource(), receiptsMissing: [{ entryId: "e1", sourceKey: "op:a", operationId: "a" }, { entryId: "e2", sourceKey: "op:b", operationId: "b" }] };
    await periods.close(OWNER, PERIOD, NOW);
    expect(repository.closes[0]?.snapshot.warnings.map((warning) => warning.code)).toEqual(["receipts_missing"]);
  });

  it("закрыть можно только месяц на сверке: открытый, закрытый и без строки — 409", async () => {
    const { periods, repository } = service();
    repository.source = fullSource();
    expect((await domainError(periods.close(OWNER, PERIOD, NOW))).code).toBe("ledger_period_status");
    repository.rowMap.set(PERIOD, periodRow({ status: "open" }));
    expect((await domainError(periods.close(OWNER, PERIOD, NOW))).code).toBe("ledger_period_status");
    repository.rowMap.set(PERIOD, periodRow({ status: "closed" }));
    expect((await domainError(periods.close(OWNER, PERIOD, NOW))).code).toBe("ledger_period_status");
    expect(repository.closes).toEqual([]);
  });

  it("гонка двух закрытий: проигравший получает 409 «месяц уже не на сверке», а не вторую проводку", async () => {
    const { periods, repository, audit } = service();
    repository.rowMap.set(PERIOD, periodRow());
    repository.source = fullSource();
    repository.closeResult = { outcome: "not_review", status: "closed" };
    expect((await domainError(periods.close(OWNER, PERIOD, NOW))).code).toBe("ledger_period_status");
    expect(audit).toEqual([]);
  });

  it("пока шло закрытие, в месяце появились проводки: 409 с просьбой повторить, снимок не записан", async () => {
    const { periods, repository, audit } = service();
    repository.rowMap.set(PERIOD, periodRow());
    repository.source = fullSource();
    repository.closeResult = { outcome: "changed" };
    expect((await domainError(periods.close(OWNER, PERIOD, NOW))).code).toBe("ledger_period_changed");
    expect(audit).toEqual([]);
  });

  it("курсы запрашиваются пакетом: один вызов ядра курсов на всё закрытие, а не по проводке", async () => {
    const { periods, repository, fxCalls } = service();
    repository.rowMap.set(PERIOD, periodRow());
    repository.source = fullSource();
    await periods.close(OWNER, PERIOD, NOW);
    expect(fxCalls).toHaveLength(1);
  });
});

describe("сервис месяцев: снятие закрытия", () => {
  it("причина обязательна: короче трёх знаков — ошибка, ни базы, ни хука", async () => {
    const { periods, repository, hooks } = service();
    repository.rowMap.set(PERIOD, periodRow({ status: "closed" }));
    expect((await domainError(periods.reopen(OWNER, PERIOD, "  ", NOW))).code).toBe("validation_failed");
    expect((await domainError(periods.reopen(OWNER, PERIOD, "ой", NOW))).code).toBe("validation_failed");
    expect((await domainError(periods.reopen(OWNER, PERIOD, "а".repeat(501), NOW))).code).toBe("validation_failed");
    expect(repository.reopens).toEqual([]);
    expect(hooks.resets).toEqual([]);
  });

  it("снимает закрытие: план с номером раза и причиной, подтверждения сбрасываются, аудит с причиной", async () => {
    const { periods, repository, hooks, audit } = service();
    repository.rowMap.set(PERIOD, periodRow({ status: "closed", reopenedCount: 2 }));
    await periods.reopen(OWNER, PERIOD, "Участник оспорил отчёт", NOW);
    expect(repository.reopens).toEqual([{ period: PERIOD, round: 2, at: NOW, by: OWNER.accountId, reason: "Участник оспорил отчёт" }]);
    expect(hooks.resets).toEqual([PERIOD]);
    expect(audit).toEqual([expect.objectContaining({ actorAccountId: OWNER.accountId, action: "ledger.period.reopen", target: PERIOD, after: expect.objectContaining({ reason: "Участник оспорил отчёт", reversed: 3 }) })]);
  });

  it("после выплаты снять закрытие нельзя: 409, сторно не пишется, подтверждения не трогаются", async () => {
    const { periods, repository, hooks, audit } = service();
    repository.rowMap.set(PERIOD, periodRow({ status: "closed" }));
    hooks.payouts = true;
    expect((await domainError(periods.reopen(OWNER, PERIOD, "ошибка в расходах", NOW))).code).toBe("ledger_period_has_payouts");
    expect(repository.reopens).toEqual([]);
    expect(hooks.resets).toEqual([]);
    expect(audit).toEqual([]);
  });

  it("снять можно только закрытый месяц", async () => {
    const { periods, repository } = service();
    repository.rowMap.set(PERIOD, periodRow({ status: "review" }));
    expect((await domainError(periods.reopen(OWNER, PERIOD, "ошибка в расходах", NOW))).code).toBe("ledger_period_status");
    expect(repository.reopens).toEqual([]);
  });

  it("гонка снятия с повторным закрытием: проигравший получает 409", async () => {
    const { periods, repository, hooks } = service();
    repository.rowMap.set(PERIOD, periodRow({ status: "closed" }));
    repository.reopenResult = { outcome: "not_closed", status: "review" };
    expect((await domainError(periods.reopen(OWNER, PERIOD, "ошибка в расходах", NOW))).code).toBe("ledger_period_status");
    expect(hooks.resets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Замок закрытого месяца в журнале
// ---------------------------------------------------------------------------------------------------------------

describe("замок закрытого месяца в журнале", () => {
  const ACCOUNTS: StoredLedgerAccount[] = [
    { accountId: "bank.rub", type: "asset", currency: "RUB", name: "Банк", archivedAt: null },
    { accountId: "expense.vps.RUB", type: "expense", currency: "RUB", name: "Сервер", archivedAt: null },
  ];

  /**
   * Журнал в памяти с тем же договором замка, что у настоящего репозитория: закрытый месяц — `period_closed`,
   * проводка не записана; замок — внутри вставки, а не отдельным вопросом до неё.
   */
  class MemoryJournal implements LedgerRepository {
    readonly inserted: NewLedgerEntry[] = [];
    readonly byKey = new Map<string, StoredLedgerEntry>();
    readonly closedPeriods = new Set<string>();
    insertCalls = 0;

    async accounts(): Promise<StoredLedgerAccount[]> {
      return ACCOUNTS;
    }

    async entryBySource(sourceKey: string): Promise<StoredLedgerEntry | null> {
      return this.byKey.get(sourceKey) ?? null;
    }

    async insertEntry(entry: NewLedgerEntry, lines: readonly EntryLine[]): Promise<InsertResult> {
      this.insertCalls += 1;
      if (this.closedPeriods.has(entry.period)) return "period_closed";
      this.inserted.push(entry);
      this.byKey.set(entry.sourceKey, { ...entry, reversalOf: null, meta: null, createdAt: new Date(), lines: [...lines] });
      return "inserted";
    }

    async balances(): Promise<Map<string, bigint>> {
      return new Map();
    }

    async journal(): Promise<StoredLedgerEntry[]> {
      return [];
    }
  }

  const draft = (sourceKey: string, at: string, period?: string) => ({
    sourceKey,
    at: new Date(at),
    memo: "Оплата сервера",
    lines: [
      { accountId: "bank.rub", amount: -100_00n },
      { accountId: "expense.vps.RUB", amount: 100_00n },
    ],
    ...(period === undefined ? {} : { period }),
  });

  /** Журнал, у которого ноябрь закрыт. */
  const journalWithClosedNovember = () => {
    const journal = new MemoryJournal();
    journal.closedPeriods.add(PERIOD);
    return journal;
  };

  it("проводка с датой в закрытом месяце — 409 `ledger_period_closed`, в журнал не попадает", async () => {
    const journal = journalWithClosedNovember();
    const ledger = new LedgerService(journal);
    const error = await domainError(ledger.post(draft("op:1", "2026-11-10T12:00:00.000Z")));
    expect(error).toMatchObject({ code: "ledger_period_closed", status: 409 });
    expect(error.message).toContain("2026-11");
    expect(journal.inserted).toEqual([]);
    expect(journal.byKey.size).toBe(0);
  });

  it("«за какой месяц» решает: расход, оплаченный в декабре за закрытый ноябрь, — тоже 409", async () => {
    const journal = journalWithClosedNovember();
    const ledger = new LedgerService(journal);
    expect((await domainError(ledger.post(draft("op:2", "2026-12-03T12:00:00.000Z", PERIOD)))).code).toBe("ledger_period_closed");
    expect(journal.inserted).toEqual([]);
  });

  it("открытый месяц пишется как раньше; период проводки — месяц «за какой», если он указан", async () => {
    const journal = journalWithClosedNovember();
    const ledger = new LedgerService(journal);
    await ledger.post(draft("op:3", "2026-12-03T12:00:00.000Z"));
    await ledger.post(draft("op:4", "2026-12-03T12:00:00.000Z", "2026-10"));
    expect(journal.inserted.map((entry) => [entry.sourceKey, entry.period])).toEqual([
      ["op:3", "2026-12"],
      ["op:4", "2026-10"],
    ]);
  });

  it("повтор проводки, записанной до закрытия, замок не трогает: тот же ключ — та же проводка, до вставки дело не доходит", async () => {
    const journal = new MemoryJournal();
    const ledger = new LedgerService(journal);
    await ledger.post(draft("op:5", "2026-11-10T12:00:00.000Z"));
    journal.closedPeriods.add(PERIOD);
    expect(await ledger.post(draft("op:5", "2026-11-10T12:00:00.000Z"))).toMatchObject({ created: false });
    expect(journal.insertCalls).toBe(1);
  });

  it("отказ замка не занимает ключ: после снятия закрытия та же проводка записывается", async () => {
    const journal = journalWithClosedNovember();
    const ledger = new LedgerService(journal);
    expect((await domainError(ledger.post(draft("op:6", "2026-11-10T12:00:00.000Z")))).code).toBe("ledger_period_closed");
    journal.closedPeriods.delete(PERIOD);
    expect(await ledger.post(draft("op:6", "2026-11-10T12:00:00.000Z"))).toMatchObject({ created: true });
  });
});
