import { describe, expect, it } from "vitest";
import { normalSign, type LedgerAccount } from "../src/accounts.js";
import { balances, trialBalance } from "../src/balances.js";
import { reverse, type EntryDraft } from "../src/entries.js";

const AT = new Date("2026-11-01T10:00:00Z");

const LIST: LedgerAccount[] = [
  { id: "stars.bot.hold", type: "asset", currency: "XTR", name: "Звёзды бота — в холде" },
  { id: "stars.bot.available", type: "asset", currency: "XTR", name: "Звёзды бота — доступно" },
  { id: "revenue.shop.telegram", type: "revenue", currency: "XTR", name: "Выручка: магазин, Telegram" },
  { id: "expense.withdraw.fee", type: "expense", currency: "XTR", name: "Расход: комиссия вывода" },
  { id: "liability.partner", type: "liability", currency: "XTR", name: "Партнёру" },
  { id: "equity.loan", type: "equity", currency: "XTR", name: "Заём участника" },
  { id: "exchange.xtr", type: "asset", currency: "XTR", name: "Обмен, звёзды" },
  { id: "exchange.gram", type: "asset", currency: "GRAM", name: "Обмен, Gram" },
  { id: "wallet.ton", type: "asset", currency: "GRAM", name: "Кошелёк TON" },
];
const ACCOUNTS: ReadonlyMap<string, LedgerAccount> = new Map(LIST.map((a) => [a.id, a]));

const PAID: EntryDraft = {
  sourceKey: "purchase:1:paid",
  at: AT,
  memo: "",
  lines: [
    { accountId: "stars.bot.hold", amount: 50n },
    { accountId: "revenue.shop.telegram", amount: -50n },
  ],
};

describe("normalSign", () => {
  it("актив и расход — плюс, остальные — минус", () => {
    expect(normalSign("asset")).toBe(1n);
    expect(normalSign("expense")).toBe(1n);
    expect(normalSign("revenue")).toBe(-1n);
    expect(normalSign("liability")).toBe(-1n);
    expect(normalSign("equity")).toBe(-1n);
  });
});

describe("balances", () => {
  it("после оплаты актив и выручка — оба 50", () => {
    const result = balances(PAID.lines, ACCOUNTS);
    expect(result.get("stars.bot.hold")).toBe(50n);
    expect(result.get("revenue.shop.telegram")).toBe(50n);
  });

  it("счёт без строк — ноль, счетов в результате ровно столько, сколько в справочнике", () => {
    const result = balances(PAID.lines, ACCOUNTS);
    expect(result.get("stars.bot.available")).toBe(0n);
    expect(result.size).toBe(LIST.length);
  });

  it("после сторно — нули", () => {
    const back = reverse(PAID, "purchase:1:refunded", AT, "возврат");
    const result = balances([...PAID.lines, ...back.lines], ACCOUNTS);
    expect(result.get("stars.bot.hold")).toBe(0n);
    expect(result.get("revenue.shop.telegram")).toBe(0n);
  });

  it("считает по нормальной стороне для каждого типа", () => {
    const result = balances(
      [
        { accountId: "expense.withdraw.fee", amount: 3n },
        { accountId: "liability.partner", amount: -3n },
        { accountId: "stars.bot.available", amount: 7n },
        { accountId: "equity.loan", amount: -7n },
      ],
      ACCOUNTS,
    );
    expect(result.get("expense.withdraw.fee")).toBe(3n);
    expect(result.get("liability.partner")).toBe(3n);
    expect(result.get("stars.bot.available")).toBe(7n);
    expect(result.get("equity.loan")).toBe(7n);
  });

  it("принимает любой итерируемый источник и копит по нескольким проводкам", () => {
    function* lines() {
      yield { accountId: "stars.bot.hold", amount: 50n };
      yield { accountId: "stars.bot.hold", amount: -50n };
      yield { accountId: "stars.bot.available", amount: 50n };
    }
    const result = balances(lines(), ACCOUNTS);
    expect(result.get("stars.bot.hold")).toBe(0n);
    expect(result.get("stars.bot.available")).toBe(50n);
  });

  it("строка с неизвестным счётом — исключение: журнал не должен молчать", () => {
    expect(() => balances([{ accountId: "no.such", amount: 1n }], ACCOUNTS)).toThrow(/no\.such/);
  });
});

describe("trialBalance", () => {
  it("журнал из нескольких проводок — ноль в каждой валюте", () => {
    const journal: EntryDraft[] = [
      PAID,
      {
        sourceKey: "hold:1:released",
        at: AT,
        memo: "",
        lines: [
          { accountId: "stars.bot.hold", amount: -50n },
          { accountId: "stars.bot.available", amount: 50n },
        ],
      },
      {
        sourceKey: "withdraw:1",
        at: AT,
        memo: "",
        lines: [
          { accountId: "stars.bot.available", amount: -50n },
          { accountId: "exchange.xtr", amount: 50n },
          { accountId: "exchange.gram", amount: -120n },
          { accountId: "wallet.ton", amount: 120n },
        ],
      },
    ];
    const result = trialBalance(journal.flatMap((entry) => entry.lines), ACCOUNTS);
    expect(result.get("XTR")).toBe(0n);
    expect(result.get("GRAM")).toBe(0n);
    expect(result.size).toBe(2);
  });

  it("несходящийся журнал показывает расхождение по валюте", () => {
    const result = trialBalance([{ accountId: "stars.bot.hold", amount: 5n }, { accountId: "wallet.ton", amount: -2n }], ACCOUNTS);
    expect(result.get("XTR")).toBe(5n);
    expect(result.get("GRAM")).toBe(-2n);
  });

  it("пустой журнал — ноль в каждой валюте справочника", () => {
    const result = trialBalance([], ACCOUNTS);
    expect(result.get("XTR")).toBe(0n);
    expect(result.get("GRAM")).toBe(0n);
  });
});
