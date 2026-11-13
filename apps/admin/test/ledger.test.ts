import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  balanceCards,
  balancesSchema,
  entryNote,
  formatAmount,
  journalPageSchema,
  journalQuery,
  lineSign,
  lineTone,
  mergeEntries,
  paymentIdOf,
  revenueRows,
  type Balances,
  type JournalEntry,
} from "../src/api/ledger";
import { BalancesView } from "../src/screens/ledger/BalancesView";
import { JournalView } from "../src/screens/ledger/JournalView";

/**
 * Раздел «Бухгалтерия» (tasks/T-0459, Р219): разбор ответов сервера, раскладка остатков по местам хранения,
 * строки журнала со знаком и цветом, сторно и курсор «Показать ещё».
 */

const plain = (text: string) => text.replace(/[  ]/g, " ");

const BALANCES: Balances = {
  accounts: [
    { accountId: "stars.bot.hold", name: "Звёзды бота — в холде", type: "asset", currency: "XTR", balance: "61200", value: { usd: "795.60", rub: "73519.44" } },
    { accountId: "stars.bot.available", name: "Звёзды бота — доступно", type: "asset", currency: "XTR", balance: "34100", value: { usd: "443.30", rub: "40960.92" } },
    { accountId: "wallet.ton", name: "Кошелёк TON", type: "asset", currency: "GRAM", balance: "0", value: { usd: "0.00", rub: "0.00" } },
    { accountId: "exchange.usdt", name: "Биржа или USDT", type: "asset", currency: "USDT", balance: "0.000000", value: { usd: "0.00", rub: "0.00" } },
    { accountId: "bank.rub", name: "Банк, ₽", type: "asset", currency: "RUB", balance: "0.00", value: { usd: "0.00", rub: "0.00" } },
    { accountId: "revenue.shop.telegram", name: "Выручка: магазин, Telegram", type: "revenue", currency: "XTR", balance: "80000", value: { usd: "1040.00", rub: "96096.00" } },
    { accountId: "revenue.vip.telegram", name: "Выручка: VIP, Telegram", type: "revenue", currency: "XTR", balance: "15300", value: { usd: "198.90", rub: "18376.36" } },
  ],
  rates: { at: "2026-11-13T09:00:00.000Z" },
  totalUsd: "1238.90",
  totalRub: "114480.36",
};

const WITHOUT_RATES: Balances = {
  accounts: BALANCES.accounts.map((account) => ({ ...account, value: null })),
  rates: null,
  totalUsd: null,
  totalRub: null,
};

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    entryId: "00000000-0000-4000-8000-000000000001",
    sourceKey: "purchase:42:paid",
    at: "2026-11-01T12:00:00.000Z",
    period: "2026-11",
    memo: "Набор «Старт»",
    reversalOf: null,
    createdBy: null,
    meta: null,
    lines: [
      { accountId: "stars.bot.hold", accountName: "Звёзды бота — в холде", currency: "XTR", amount: "50" },
      { accountId: "revenue.shop.telegram", accountName: "Выручка: магазин, Telegram", currency: "XTR", amount: "-50" },
    ],
    ...overrides,
  };
}

describe("ответы сервера", () => {
  it("остатки разбираются схемой, оценка и курсы могут быть null", () => {
    expect(balancesSchema.parse(BALANCES).totalUsd).toBe("1238.90");
    const parsed = balancesSchema.parse(WITHOUT_RATES);
    expect(parsed.rates).toBeNull();
    expect(parsed.accounts[0]?.value).toBeNull();
  });

  it("журнал разбирается схемой, мусор отклоняется", () => {
    expect(journalPageSchema.parse({ entries: [entry()], next: "abc" }).entries[0]?.lines).toHaveLength(2);
    expect(journalPageSchema.parse({ entries: [], next: null }).next).toBeNull();
    expect(journalPageSchema.safeParse({ entries: [{ entryId: 5 }], next: null }).success).toBe(false);
    expect(balancesSchema.safeParse({ accounts: "нет" }).success).toBe(false);
  });
});

describe("остатки по местам хранения", () => {
  it("звёзды бота — отдельно в холде и доступно, прочие активы — карточками по порядку", () => {
    const cards = balanceCards(BALANCES.accounts);
    expect(cards.stars.hold?.balance).toBe("61200");
    expect(cards.stars.available?.balance).toBe("34100");
    expect(cards.others.map((account) => account.accountId)).toEqual(["wallet.ton", "exchange.usdt", "bank.rub"]);
  });

  it("выручка по статьям — только счета выручки", () => {
    expect(revenueRows(BALANCES.accounts).map((account) => account.accountId)).toEqual(["revenue.shop.telegram", "revenue.vip.telegram"]);
  });

  it("звёзд в плане нет — не ломается", () => {
    const cards = balanceCards(BALANCES.accounts.filter((account) => !account.accountId.startsWith("stars.")));
    expect(cards.stars).toEqual({ hold: null, available: null });
  });

  it("сумма в родной валюте: разряды, запятая, знак валюты", () => {
    expect(plain(formatAmount("61200", "XTR"))).toBe("61 200 ⭐");
    expect(plain(formatAmount("114576.00", "RUB"))).toBe("114 576,00 ₽");
    expect(plain(formatAmount("0.000000", "USDT"))).toBe("0,000000 USDT");
    expect(plain(formatAmount("9007199.254740993", "GRAM"))).toBe("9 007 199,254740993 GRAM");
    expect(plain(formatAmount("-1500", "XTR"))).toBe("−1 500 ⭐");
  });

  it("экран с курсами: итог в $ и ₽, холд и доступно, курс с датой", () => {
    const html = plain(renderToStaticMarkup(createElement(BalancesView, { data: BALANCES })));
    expect(html).toContain("1 238,90 $");
    expect(html).toContain("114 480,36 ₽");
    expect(html).toContain("в холде");
    expect(html).toContain("61 200 ⭐");
    expect(html).toContain("795,60 $");
    expect(html).toContain("доступно");
    expect(html).toContain("за всё время");
    expect(html).toContain("Кошелёк TON");
  });

  it("экран без курсов: только родная валюта, подсказка про «Курсы», без знака «≈»", () => {
    const html = plain(renderToStaticMarkup(createElement(BalancesView, { data: WITHOUT_RATES })));
    expect(html).toContain("61 200 ⭐");
    expect(html).toContain("Курсов нет");
    expect(html).not.toContain("≈");
    expect(html).not.toContain("1 238,90");
  });
});

describe("строки журнала", () => {
  it("дебет — плюс и тон debit, кредит — минус и тон credit", () => {
    expect(lineSign("50")).toBe("+50");
    expect(lineSign("-50")).toBe("−50");
    expect(lineSign("0")).toBe("0");
    expect(lineTone("50")).toBe("debit");
    expect(lineTone("-50")).toBe("credit");
    expect(lineTone("0.00")).toBe("zero");
  });

  it("сторно — метка со ссылкой на ключ исходной; обычная проводка без метки", () => {
    expect(entryNote(entry())).toBeNull();
    expect(entryNote(entry({ sourceKey: "purchase:42:refund", reversalOf: "purchase:42:paid" }))).toEqual({ label: "сторно", original: "purchase:42:paid" });
  });

  it("ссылка на платёж — только у ключа покупки", () => {
    expect(paymentIdOf("purchase:42:paid")).toBe("42");
    expect(paymentIdOf("purchase:abc-1:release")).toBe("abc-1");
    expect(paymentIdOf("operation:7")).toBeNull();
  });

  it("журнал на экране: описание, ключ, строки со знаком, ссылка на платёж и метка сторно", () => {
    const entries = [entry(), entry({ entryId: "00000000-0000-4000-8000-000000000002", sourceKey: "purchase:42:refund", reversalOf: "purchase:42:paid", memo: "Возврат", lines: [{ accountId: "stars.bot.hold", accountName: "Звёзды бота — в холде", currency: "XTR", amount: "-50" }] })];
    const html = plain(
      renderToStaticMarkup(createElement(JournalView, { entries, next: "abc", filter: {}, loading: false, hasPayments: true, onMore: () => undefined, onSource: () => undefined })),
    );
    expect(html).toContain("Набор «Старт»");
    expect(html).toContain("purchase:42:paid");
    expect(html).toContain("+50");
    expect(html).toContain("−50");
    expect(html).toContain("сторно");
    expect(html).toContain("#/payments/42");
    expect(html).toContain("Показать ещё");
  });

  it("пустой журнал — подсказка про первый проход сверки; без следующей страницы кнопки нет", () => {
    const html = plain(renderToStaticMarkup(createElement(JournalView, { entries: [], next: null, filter: {}, loading: false, hasPayments: true, onMore: () => undefined, onSource: () => undefined })));
    expect(html).toContain("Проводок пока нет: оплаты появятся здесь после первого прохода сверки (раз в 10 минут)");
    expect(html).not.toContain("Показать ещё");
  });

  it("с фильтром пустой результат — «ничего не найдено», а не про сверку", () => {
    const html = plain(renderToStaticMarkup(createElement(JournalView, { entries: [], next: null, filter: { currency: "XTR" }, loading: false, hasPayments: true, onMore: () => undefined, onSource: () => undefined })));
    expect(html).toContain("По фильтру проводок нет");
    expect(html).not.toContain("первого прохода");
  });
});

describe("страницы журнала", () => {
  it("«Показать ещё» дописывает страницу без повторов по entryId, порядок сохраняется", () => {
    const a = entry({ entryId: "a" });
    const b = entry({ entryId: "b" });
    const c = entry({ entryId: "c" });
    expect(mergeEntries([a, b], [b, c]).map((item) => item.entryId)).toEqual(["a", "b", "c"]);
    expect(mergeEntries([], [a]).map((item) => item.entryId)).toEqual(["a"]);
    expect(mergeEntries([a], []).map((item) => item.entryId)).toEqual(["a"]);
  });

  it("запрос: пустые фильтры не уходят, курсор — отдельным параметром", () => {
    expect(journalQuery({}, null)).toEqual({});
    expect(journalQuery({ account: "stars.bot.hold", currency: "XTR", from: "2026-10", to: "2026-11", source: "purchase:42:paid" }, "abc")).toEqual({
      account: "stars.bot.hold",
      currency: "XTR",
      from: "2026-10",
      to: "2026-11",
      source: "purchase:42:paid",
      cursor: "abc",
    });
    expect(journalQuery({ account: "", currency: "" }, null)).toEqual({});
  });
});
