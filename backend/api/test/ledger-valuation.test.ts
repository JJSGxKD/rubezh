import { Decimal, type CurrencyCode, type Rate } from "@bh/fx";
import { describe, expect, it } from "vitest";
import { totalAssets, valueOf, type ValuationSnapshot } from "../src/modules/ledger/ledger-valuation.js";
import type { AccountBalanceView } from "../src/modules/ledger/ledger-view.js";

/**
 * Оценка остатков в долларах и рублях (Р219, О45–О46, tasks/T-0459): звёзды — по курсу выплаты, остальные
 * валюты — по рыночному; вниз до цента и до копейки; нет курса — `null`, а не ноль.
 */

const AT = new Date("2026-11-13T09:00:00Z");

function rate(currency: CurrencyCode, usdPerUnit: string): Rate {
  return { currency, usdPerUnit: new Decimal(usdPerUnit), sources: ["test"], observedAt: AT };
}

/** Рыночные: рубль — 1/100 доллара (1 $ = 100 ₽), Gram — 2,5 $, USDT — 1 $; выплата звезды — 0,013 $. */
function snapshot(overrides: { rates?: Rate[]; payout?: Rate[] } = {}): ValuationSnapshot {
  const rates = overrides.rates ?? [rate("RUB", "0.01"), rate("GRAM", "2.5"), rate("USDT", "1")];
  const payout = overrides.payout ?? [rate("XTR", "0.013")];
  return {
    rates: new Map(rates.map((item) => [item.currency, item])),
    payout: new Map(payout.map((item) => [item.currency, item])),
  };
}

describe("valueOf", () => {
  it("звёзды — по курсу выплаты, а не по рыночному", () => {
    const withMarketStar = snapshot({ rates: [rate("RUB", "0.01"), rate("XTR", "0.02")] });
    expect(valueOf("61200", "XTR", withMarketStar)).toEqual({ usd: "795.60", rub: "79560.00" });
  });

  it("Gram и рубль — по рыночному курсу", () => {
    expect(valueOf("10", "GRAM", snapshot())).toEqual({ usd: "25.00", rub: "2500.00" });
    expect(valueOf("114576.00", "RUB", snapshot())).toEqual({ usd: "1145.76", rub: "114576.00" });
    expect(valueOf("7", "USD", snapshot())).toEqual({ usd: "7.00", rub: "700.00" });
  });

  it("округляет вниз: до цента и до копейки", () => {
    // 3 × 0,013 = 0,039 $ → 0,03; в рублях 3,9 ₽
    expect(valueOf("3", "XTR", snapshot())).toEqual({ usd: "0.03", rub: "3.90" });
    // 0,999999999 GRAM × 2,5 = 2,4999999975 $ → 2,49; 249,99999975 ₽ → 249,99
    expect(valueOf("0.999999999", "GRAM", snapshot())).toEqual({ usd: "2.49", rub: "249.99" });
  });

  it("нет нужного курса — null: звёзд без курса выплаты, валюты без рыночного, рубля для пересчёта", () => {
    expect(valueOf("50", "XTR", snapshot({ payout: [] }))).toBeNull();
    expect(valueOf("1", "GRAM", snapshot({ rates: [rate("RUB", "0.01")] }))).toBeNull();
    expect(valueOf("1", "GRAM", snapshot({ rates: [rate("GRAM", "2.5")] }))).toBeNull();
    expect(valueOf("1", "ABC", snapshot())).toBeNull();
  });

  it("нечитаемая сумма — null, а не исключение", () => {
    expect(valueOf("много", "XTR", snapshot())).toBeNull();
  });
});

describe("totalAssets", () => {
  const account = (accountId: string, type: AccountBalanceView["type"], currency: string, balance: string): AccountBalanceView => ({
    accountId,
    name: accountId,
    type,
    currency,
    balance,
  });

  it("складывает только активы, уже округлённые поштучно", () => {
    const accounts = [
      account("stars.bot.hold", "asset", "XTR", "3"),
      account("stars.bot.available", "asset", "XTR", "3"),
      account("revenue.shop.telegram", "revenue", "XTR", "6"),
    ];
    // по одному 0,03 $, а не 0,078 → 0,07 от суммы
    expect(totalAssets(accounts, snapshot())).toEqual({ usd: "0.06", rub: "7.80" });
  });

  it("хотя бы у одного актива нет оценки — итога нет", () => {
    const accounts = [account("stars.bot.hold", "asset", "XTR", "50"), account("wallet.ton", "asset", "GRAM", "1")];
    expect(totalAssets(accounts, snapshot({ rates: [rate("RUB", "0.01")] }))).toBeNull();
  });

  it("активов нет — итог ноль, снимка нет — итога нет", () => {
    expect(totalAssets([], snapshot())).toEqual({ usd: "0.00", rub: "0.00" });
    expect(totalAssets([account("bank.rub", "asset", "RUB", "1")], null)).toBeNull();
  });
});
