import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentStatements } from "../src/platforms/ports/payment-statement.js";
import { TelegramStarStatement } from "../src/platforms/telegram/telegram-star-statement.js";

// Выписка звёзд бота (docs/35-stage4-plan.md, Р209, WP53): адаптер Telegram
// переводит операции getStarTransactions в платформенно-нейтральную выписку.

const CHARGE_ID = `stx${"a".repeat(128)}`;
const DATE = 1_762_000_000;

/** Подставной API: запоминает вызовы и отдаёт заданный ответ. */
class FakeStatementApi {
  readonly calls: Array<{ offset: number; limit: number }> = [];

  constructor(private readonly response: unknown) {}

  async getStarTransactions(offset: number, limit: number): Promise<unknown> {
    this.calls.push({ offset, limit });
    return this.response;
  }
}

function statementOf(transactions: unknown[]): { api: FakeStatementApi; statement: TelegramStarStatement } {
  const api = new FakeStatementApi({ transactions });
  return { api, statement: new TelegramStarStatement(api) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("выписка звёзд Telegram", () => {
  it("оплата игрока — payment с игроком и идентификатором покупки", async () => {
    const { statement } = statementOf([
      { id: CHARGE_ID, amount: 50, date: DATE, source: { type: "user", transaction_type: "invoice_payment", user: { id: 123 }, invoice_payload: "9b2f" } },
    ]);
    expect(await statement.page(0, 10)).toEqual([
      { id: CHARGE_ID, kind: "payment", amount: 50, at: new Date(DATE * 1000), payerId: "123", payload: "9b2f", subscriptionPeriodSec: null },
    ]);
  });

  it("оплата без invoice_payload — payload null", async () => {
    const { statement } = statementOf([{ id: "s1", amount: 5, date: DATE, source: { type: "user", transaction_type: "invoice_payment", user: { id: 7 } } }]);
    expect((await statement.page(0, 10))[0]?.payload).toBeNull();
  });

  it("оплата подписки несёт период", async () => {
    const { statement } = statementOf([
      {
        id: "s2",
        amount: 100,
        date: DATE,
        source: { type: "user", transaction_type: "invoice_payment", user: { id: 123 }, invoice_payload: "p", subscription_period: 2_592_000 },
      },
    ]);
    expect((await statement.page(0, 10))[0]?.subscriptionPeriodSec).toBe(2_592_000);
  });

  it("возврат — refund: игрок из получателя, идентификатор исходной оплаты", async () => {
    const { statement } = statementOf([
      { id: CHARGE_ID, amount: 50, date: DATE, receiver: { type: "user", transaction_type: "invoice_payment", user: { id: 123 }, invoice_payload: "9b2f" } },
    ]);
    expect(await statement.page(0, 10)).toEqual([
      { id: CHARGE_ID, kind: "refund", amount: 50, at: new Date(DATE * 1000), payerId: "123", payload: "9b2f", subscriptionPeriodSec: null },
    ]);
  });

  it("вывод через Fragment — other без игрока и счёта", async () => {
    const { statement } = statementOf([{ id: "f1", amount: 1000, date: DATE, receiver: { type: "fragment" } }]);
    expect(await statement.page(0, 10)).toEqual([
      { id: "f1", kind: "other", amount: 1000, at: new Date(DATE * 1000), payerId: null, payload: null, subscriptionPeriodSec: null },
    ]);
  });

  it("пользовательская операция другого типа — other", async () => {
    const { statement } = statementOf([{ id: "g1", amount: 5, date: DATE, source: { type: "user", transaction_type: "gift_purchase", user: { id: 1 } } }]);
    expect(await statement.page(0, 10)).toEqual([
      { id: "g1", kind: "other", amount: 5, at: new Date(DATE * 1000), payerId: null, payload: null, subscriptionPeriodSec: null },
    ]);
  });

  it("битая строка среди хороших — other по её id, страница не падает, в лог идёт позиция", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const good = (id: string) => ({ id, amount: 5, date: DATE, source: { type: "user", transaction_type: "invoice_payment", user: { id: 1 } } });
    const { statement } = statementOf([good("a"), { id: "broken", date: DATE }, good("c")]);
    const entries = await statement.page(0, 10);
    expect(entries.map((entry) => [entry.id, entry.kind])).toEqual([
      ["a", "payment"],
      ["broken", "other"],
      ["c", "payment"],
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ module: "telegram", event: "star_statement_row_skipped", position: 1 });
  });

  it("битая строка без id пропускается", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { statement } = statementOf([{ amount: 1 }, "мусор", null]);
    expect(await statement.page(0, 10)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("ответ без transactions — исключение", async () => {
    const statement = new TelegramStarStatement(new FakeStatementApi({}));
    await expect(statement.page(0, 10)).rejects.toThrow("выписка Telegram без transactions");
  });

  it("не объект вместо ответа — исключение", async () => {
    const statement = new TelegramStarStatement(new FakeStatementApi(null));
    await expect(statement.page(0, 10)).rejects.toThrow("выписка Telegram без transactions");
  });

  it("страница зажимается в 1–100, смещение — не меньше нуля", async () => {
    const { api, statement } = statementOf([]);
    await statement.page(-5, 500);
    await statement.page(3, 0);
    expect(api.calls).toEqual([
      { offset: 0, limit: 100 },
      { offset: 3, limit: 1 },
    ]);
    expect(statement.pageMax).toBe(100);
    expect(statement.platform).toBe("telegram");
  });
});

describe("выписки площадок", () => {
  it("находит выписку по площадке, у площадки без выписки — null", () => {
    const statement = new TelegramStarStatement(new FakeStatementApi({ transactions: [] }));
    const statements = new PaymentStatements([statement]);
    expect(statements.for("telegram")).toBe(statement);
    expect(statements.for("max")).toBeNull();
    expect(statements.list()).toEqual([statement]);
  });

  it("пустой реестр ничего не находит", () => {
    const statements = new PaymentStatements([]);
    expect(statements.for("telegram")).toBeNull();
    expect(statements.list()).toEqual([]);
  });
});
