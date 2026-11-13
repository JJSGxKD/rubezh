import { describe, expect, it } from "vitest";
import type { LedgerAccount } from "../src/accounts.js";
import { findEntryProblems, periodOf, reverse, type EntryDraft } from "../src/entries.js";

const AT = new Date("2026-11-01T10:00:00Z");

const ACCOUNTS: ReadonlyMap<string, LedgerAccount> = new Map(
  (
    [
      { id: "stars.bot.hold", type: "asset", currency: "XTR", name: "Звёзды бота — в холде" },
      { id: "stars.bot.available", type: "asset", currency: "XTR", name: "Звёзды бота — доступно" },
      { id: "revenue.shop.telegram", type: "revenue", currency: "XTR", name: "Выручка: магазин, Telegram" },
      { id: "exchange.xtr", type: "asset", currency: "XTR", name: "Обмен, звёзды" },
      { id: "exchange.gram", type: "asset", currency: "GRAM", name: "Обмен, Gram" },
      { id: "wallet.ton", type: "asset", currency: "GRAM", name: "Кошелёк TON" },
    ] satisfies LedgerAccount[]
  ).map((account) => [account.id, account]),
);

function draft(lines: EntryDraft["lines"], patch: Partial<EntryDraft> = {}): EntryDraft {
  return { sourceKey: "purchase:1:paid", at: AT, memo: "оплата набора", lines, ...patch };
}

const PAID = draft([
  { accountId: "stars.bot.hold", amount: 50n },
  { accountId: "revenue.shop.telegram", amount: -50n },
]);

describe("findEntryProblems", () => {
  it("оплата 50 звёзд — без проблем", () => {
    expect(findEntryProblems(PAID, ACCOUNTS)).toEqual([]);
  });

  it("пустой и слишком длинный ключ идемпотентности", () => {
    expect(findEntryProblems({ ...PAID, sourceKey: "" }, ACCOUNTS)).toContainEqual({ kind: "empty_source_key" });
    expect(findEntryProblems({ ...PAID, sourceKey: "   " }, ACCOUNTS)).toContainEqual({ kind: "empty_source_key" });
    expect(findEntryProblems({ ...PAID, sourceKey: "k".repeat(128) }, ACCOUNTS)).toEqual([]);
    expect(findEntryProblems({ ...PAID, sourceKey: "k".repeat(129) }, ACCOUNTS)).toContainEqual({ kind: "source_key_too_long" });
  });

  it("одна строка — too_few_lines", () => {
    const problems = findEntryProblems(draft([{ accountId: "stars.bot.hold", amount: 50n }]), ACCOUNTS);
    expect(problems).toContainEqual({ kind: "too_few_lines" });
  });

  it("пустая проводка — too_few_lines", () => {
    expect(findEntryProblems(draft([]), ACCOUNTS)).toContainEqual({ kind: "too_few_lines" });
  });

  it("строка с нулём — zero_line", () => {
    const problems = findEntryProblems(
      draft([
        { accountId: "stars.bot.hold", amount: 50n },
        { accountId: "revenue.shop.telegram", amount: -50n },
        { accountId: "stars.bot.available", amount: 0n },
      ]),
      ACCOUNTS,
    );
    expect(problems).toEqual([{ kind: "zero_line", accountId: "stars.bot.available" }]);
  });

  it("неизвестный счёт — unknown_account, и по нему баланс не считается", () => {
    const problems = findEntryProblems(
      draft([
        { accountId: "stars.bot.hold", amount: 50n },
        { accountId: "no.such", amount: -50n },
      ]),
      ACCOUNTS,
    );
    expect(problems).toContainEqual({ kind: "unknown_account", accountId: "no.such" });
    expect(problems.some((p) => p.kind === "unbalanced")).toBe(false);
  });

  it("две строки одного счёта — duplicate_account", () => {
    const problems = findEntryProblems(
      draft([
        { accountId: "stars.bot.hold", amount: 30n },
        { accountId: "stars.bot.hold", amount: 20n },
        { accountId: "revenue.shop.telegram", amount: -50n },
      ]),
      ACCOUNTS,
    );
    expect(problems).toEqual([{ kind: "duplicate_account", accountId: "stars.bot.hold" }]);
  });

  it("обмен в двух валютах: каждая сходится — без проблем", () => {
    const exchange = draft([
      { accountId: "stars.bot.available", amount: -10_000n },
      { accountId: "exchange.xtr", amount: 10_000n },
      { accountId: "exchange.gram", amount: -25_000_000_000n },
      { accountId: "wallet.ton", amount: 25_000_000_000n },
    ]);
    expect(findEntryProblems(exchange, ACCOUNTS)).toEqual([]);
  });

  it("одна валюта не сходится — unbalanced с суммой", () => {
    const broken = draft([
      { accountId: "stars.bot.available", amount: -10_000n },
      { accountId: "exchange.xtr", amount: 10_000n },
      { accountId: "exchange.gram", amount: -25n },
      { accountId: "wallet.ton", amount: 20n },
    ]);
    expect(findEntryProblems(broken, ACCOUNTS)).toEqual([{ kind: "unbalanced", currency: "GRAM", sum: -5n }]);
  });

  it("не сходится сумма и в звёздах — проблема на каждую валюту", () => {
    const broken = draft([
      { accountId: "stars.bot.hold", amount: 50n },
      { accountId: "revenue.shop.telegram", amount: -49n },
    ]);
    expect(findEntryProblems(broken, ACCOUNTS)).toEqual([{ kind: "unbalanced", currency: "XTR", sum: 1n }]);
  });
});

describe("reverse", () => {
  it("меняет знаки, ставит reversalOf, проверка проходит", () => {
    const at = new Date("2026-11-05T00:00:00Z");
    const back = reverse(PAID, "purchase:1:refunded", at, "возврат");
    expect(back.lines).toEqual([
      { accountId: "stars.bot.hold", amount: -50n },
      { accountId: "revenue.shop.telegram", amount: 50n },
    ]);
    expect(back.reversalOf).toBe("purchase:1:paid");
    expect(back.sourceKey).toBe("purchase:1:refunded");
    expect(back.at).toBe(at);
    expect(back.memo).toBe("возврат");
    expect(findEntryProblems(back, ACCOUNTS)).toEqual([]);
  });

  it("не меняет исходную проводку", () => {
    reverse(PAID, "purchase:1:refunded", AT, "возврат");
    expect(PAID.lines[0]?.amount).toBe(50n);
    expect(PAID.reversalOf).toBeUndefined();
  });

  it("сторно сторно — обычная проводка со знаками исходной", () => {
    const back = reverse(PAID, "r1", AT, "возврат");
    const again = reverse(back, "r2", AT, "отмена возврата");
    expect(again.lines).toEqual(PAID.lines);
    expect(again.reversalOf).toBe("r1");
    expect(findEntryProblems(again, ACCOUNTS)).toEqual([]);
  });
});

describe("periodOf", () => {
  it("период — календарный месяц по UTC", () => {
    expect(periodOf(new Date("2026-10-31T23:59:59.999Z"))).toBe("2026-10");
    expect(periodOf(new Date("2026-11-01T00:00:00.000Z"))).toBe("2026-11");
    expect(periodOf(new Date("2026-01-05T12:00:00Z"))).toBe("2026-01");
    expect(periodOf(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
  });
});
