import { describe, expect, it } from "vitest";
import { computeWaterfall, type WaterfallInput } from "../src/waterfall.js";

/** Центы: 1 000,00 $ = 100000n. Дробные доллары округляются, чтобы 172,8 не дало 17279,999. */
const usd = (dollars: number): bigint => BigInt(Math.round(dollars * 100));

function input(patch: Partial<WaterfallInput> = {}): WaterfallInput {
  return {
    revenue: [{ key: "ads.telegram", amount: usd(1000) }],
    otherIncome: [],
    expenses: [{ key: "servers", amount: usd(200) }],
    tax: usd(32),
    loans: [{ loanId: "loan-1", remaining: usd(500), repaymentBp: 2500 }],
    shares: [{ accountId: "member-1", bp: 3000 }],
    ...patch,
  };
}

describe("computeWaterfall: сценарий из спецификации", () => {
  it("1 000 выручка, 200 расходы, 32 налог, займ 500 под 25 %, участник 30 %", () => {
    const result = computeWaterfall(input());
    expect(result.grossRevenue).toBe(usd(1000));
    expect(result.totalExpenses).toBe(usd(200));
    expect(result.profitBeforeTax).toBe(usd(800));
    expect(result.tax).toBe(usd(32));
    expect(result.netProfit).toBe(usd(768));
    expect(result.tranches).toEqual([{ loanId: "loan-1", amount: usd(192), remainingAfter: usd(308) }]);
    expect(result.toDistribute).toBe(usd(576));
    expect(result.payouts).toEqual([{ accountId: "member-1", bp: 3000, amount: usd(172.8) }]);
    expect(result.ownerAmount).toBe(usd(403.2));
    expect(result.noDistribution).toBe(false);
  });

  it("прочие доходы входят в прибыль до налога, выручка суммируется по ключам", () => {
    const result = computeWaterfall(
      input({
        revenue: [
          { key: "ads.telegram", amount: usd(600) },
          { key: "pay.telegram", amount: usd(300) },
        ],
        otherIncome: [{ key: "interest", amount: usd(100) }],
      }),
    );
    expect(result.grossRevenue).toBe(usd(900));
    expect(result.profitBeforeTax).toBe(usd(800));
  });

  it("без займов и долей всё к разделу достаётся владельцу", () => {
    const result = computeWaterfall(input({ loans: [], shares: [] }));
    expect(result.tranches).toEqual([]);
    expect(result.payouts).toEqual([]);
    expect(result.toDistribute).toBe(usd(768));
    expect(result.ownerAmount).toBe(usd(768));
  });
});

describe("computeWaterfall: убыток и ноль", () => {
  it("убыток: выплат и траншей нет, нули, noDistribution", () => {
    const result = computeWaterfall(input({ revenue: [{ key: "ads", amount: usd(100) }] }));
    expect(result.profitBeforeTax).toBe(usd(-100));
    expect(result.netProfit).toBe(usd(-132));
    expect(result.noDistribution).toBe(true);
    expect(result.toDistribute).toBe(0n);
    expect(result.ownerAmount).toBe(0n);
    expect(result.tranches).toEqual([{ loanId: "loan-1", amount: 0n, remainingAfter: usd(500) }]);
    expect(result.payouts).toEqual([{ accountId: "member-1", bp: 3000, amount: 0n }]);
  });

  it("ноль: прибыль после налога ровно 0 — выплат нет", () => {
    const result = computeWaterfall(input({ revenue: [{ key: "ads", amount: usd(232) }] }));
    expect(result.netProfit).toBe(0n);
    expect(result.noDistribution).toBe(true);
    expect(result.toDistribute).toBe(0n);
    expect(result.ownerAmount).toBe(0n);
    expect(result.tranches[0]?.amount).toBe(0n);
  });

  it("без выручки и расходов — ноль и noDistribution", () => {
    const result = computeWaterfall({ revenue: [], otherIncome: [], expenses: [], tax: 0n, loans: [], shares: [] });
    expect(result.grossRevenue).toBe(0n);
    expect(result.noDistribution).toBe(true);
  });

  it("налог съедает прибыль: остаток после налога делится, ноль после налога — нет", () => {
    const small = computeWaterfall(input({ expenses: [{ key: "x", amount: usd(990) }], tax: usd(5) }));
    expect(small.profitBeforeTax).toBe(usd(10));
    expect(small.netProfit).toBe(usd(5));
    expect(small.noDistribution).toBe(false);
    const none = computeWaterfall(input({ expenses: [{ key: "x", amount: usd(995) }], tax: usd(5) }));
    expect(none.netProfit).toBe(0n);
    expect(none.noDistribution).toBe(true);
  });
});

describe("computeWaterfall: займы", () => {
  it("транш больше остатка займа — равен остатку, remainingAfter = 0", () => {
    const result = computeWaterfall(input({ loans: [{ loanId: "loan-1", remaining: usd(50), repaymentBp: 2500 }] }));
    expect(result.tranches).toEqual([{ loanId: "loan-1", amount: usd(50), remainingAfter: 0n }]);
    expect(result.toDistribute).toBe(usd(718));
  });

  it("погашенный заём (остаток 0) — транш 0", () => {
    const result = computeWaterfall(input({ loans: [{ loanId: "loan-1", remaining: 0n, repaymentBp: 2500 }] }));
    expect(result.tranches).toEqual([{ loanId: "loan-1", amount: 0n, remainingAfter: 0n }]);
    expect(result.toDistribute).toBe(result.netProfit);
  });

  it("два займа — по очереди входа, итог не больше чистой прибыли", () => {
    const result = computeWaterfall(
      input({
        loans: [
          { loanId: "a", remaining: usd(10_000), repaymentBp: 6000 },
          { loanId: "b", remaining: usd(10_000), repaymentBp: 6000 },
        ],
      }),
    );
    // первый берёт 60 % от 768 = 460,80; второму из его 460,80 остаётся только 307,20
    expect(result.tranches).toEqual([
      { loanId: "a", amount: usd(460.8), remainingAfter: usd(10_000) - usd(460.8) },
      { loanId: "b", amount: usd(307.2), remainingAfter: usd(10_000) - usd(307.2) },
    ]);
    expect(result.toDistribute).toBe(0n);
    expect(result.ownerAmount).toBe(0n);
    expect(result.payouts[0]?.amount).toBe(0n);
    expect(result.noDistribution).toBe(false);
  });

  it("два займа, которые укладываются: оба по своей доле от чистой прибыли", () => {
    const result = computeWaterfall(
      input({
        loans: [
          { loanId: "a", remaining: usd(100), repaymentBp: 1000 },
          { loanId: "b", remaining: usd(1000), repaymentBp: 1000 },
        ],
      }),
    );
    expect(result.tranches.map((t) => t.amount)).toEqual([usd(76.8), usd(76.8)]);
    expect(result.toDistribute).toBe(usd(768) - usd(153.6));
  });

  it("доля займа считается вниз до цента", () => {
    // чистая 10 ц; 33,33 % = 3,333 -> 3 ц
    const result = computeWaterfall(
      input({
        revenue: [{ key: "r", amount: 242n }],
        expenses: [{ key: "e", amount: 200n }],
        tax: 32n,
        loans: [{ loanId: "a", remaining: 1000n, repaymentBp: 3333 }],
        shares: [],
      }),
    );
    expect(result.netProfit).toBe(10n);
    expect(result.tranches[0]?.amount).toBe(3n);
    expect(result.toDistribute).toBe(7n);
  });
});

describe("computeWaterfall: доли и копейки", () => {
  it("три доли по 33,33 % — вниз, остаток с копейками владельцу, сумма точная", () => {
    const result = computeWaterfall(
      input({
        loans: [],
        shares: [
          { accountId: "m1", bp: 3333 },
          { accountId: "m2", bp: 3333 },
          { accountId: "m3", bp: 3333 },
        ],
      }),
    );
    // к разделу 768,00 = 76800 ц; 33,33 % = 25597,44 -> 25597
    expect(result.payouts.map((p) => p.amount)).toEqual([25597n, 25597n, 25597n]);
    const sum = result.payouts.reduce((acc, p) => acc + p.amount, 0n);
    expect(result.ownerAmount).toBe(76800n - sum);
    expect(sum + result.ownerAmount).toBe(result.toDistribute);
  });

  it("сумма выплат и доли владельца равна прибыли к разделу при любых входах", () => {
    for (let revenue = 1; revenue < 400; revenue += 7) {
      const result = computeWaterfall(
        input({
          revenue: [{ key: "r", amount: BigInt(revenue * 137 + 3) }],
          expenses: [{ key: "e", amount: 11n }],
          tax: 5n,
          loans: [{ loanId: "a", remaining: 9_999n, repaymentBp: 1234 }],
          shares: [
            { accountId: "m1", bp: 3333 },
            { accountId: "m2", bp: 4999 },
          ],
        }),
      );
      const paid = result.payouts.reduce((acc, p) => acc + p.amount, 0n);
      const tranches = result.tranches.reduce((acc, t) => acc + t.amount, 0n);
      expect(paid + result.ownerAmount).toBe(result.toDistribute);
      expect(tranches + result.toDistribute).toBe(result.netProfit);
      expect(result.ownerAmount >= 0n).toBe(true);
    }
  });

  it("доли ровно 100 % — владельцу остаётся только округление", () => {
    const result = computeWaterfall(input({ loans: [], shares: [{ accountId: "m1", bp: 10_000 }] }));
    expect(result.payouts[0]?.amount).toBe(usd(768));
    expect(result.ownerAmount).toBe(0n);
  });

  it("нулевая доля допустима, выплата 0", () => {
    const result = computeWaterfall(input({ shares: [{ accountId: "m1", bp: 0 }] }));
    expect(result.payouts).toEqual([{ accountId: "m1", bp: 0, amount: 0n }]);
  });
});

describe("computeWaterfall: недопустимые входы — исключение", () => {
  it("сумма долей больше 100 %", () => {
    expect(() =>
      computeWaterfall(
        input({
          shares: [
            { accountId: "m1", bp: 6000 },
            { accountId: "m2", bp: 4001 },
          ],
        }),
      ),
    ).toThrow(RangeError);
  });

  it("отрицательный вход: выручка, прочий доход, расход, налог, остаток займа", () => {
    expect(() => computeWaterfall(input({ revenue: [{ key: "r", amount: -1n }] }))).toThrow(RangeError);
    expect(() => computeWaterfall(input({ otherIncome: [{ key: "o", amount: -1n }] }))).toThrow(RangeError);
    expect(() => computeWaterfall(input({ expenses: [{ key: "e", amount: -1n }] }))).toThrow(RangeError);
    expect(() => computeWaterfall(input({ tax: -1n }))).toThrow(RangeError);
    expect(() => computeWaterfall(input({ loans: [{ loanId: "a", remaining: -1n, repaymentBp: 100 }] }))).toThrow(RangeError);
  });

  it("bp вне 0…10 000 или не целый — у займа и у доли", () => {
    expect(() => computeWaterfall(input({ shares: [{ accountId: "m", bp: -1 }] }))).toThrow(RangeError);
    expect(() => computeWaterfall(input({ shares: [{ accountId: "m", bp: 10_001 }] }))).toThrow(RangeError);
    expect(() => computeWaterfall(input({ shares: [{ accountId: "m", bp: 12.5 }] }))).toThrow(RangeError);
    expect(() => computeWaterfall(input({ loans: [{ loanId: "a", remaining: 1n, repaymentBp: 10_001 }] }))).toThrow(RangeError);
    expect(() => computeWaterfall(input({ loans: [{ loanId: "a", remaining: 1n, repaymentBp: -5 }] }))).toThrow(RangeError);
  });

  it("вход не меняется", () => {
    const original = input();
    const copy = structuredClone(original);
    computeWaterfall(original);
    expect(original).toEqual(copy);
  });
});
