import { describe, expect, it } from "vitest";
import { ChartRuleError, articleAccountId, feeOf, feeTemplateProblem, placeAccountId, slugify } from "../src/modules/ledger/ledger-chart.js";

/**
 * Чистые правила мест хранения и статей учёта (Р220, tasks/T-0460; docs/37-accounting.md §3, §6): идентификатор
 * из названия, идентификатор счёта статьи в валюте, комиссия по шаблону места. Базы здесь нет — как правила
 * ложатся на таблицы, проверяет `ledger-chart.integration.test.ts`.
 */

const GRAM = { code: "GRAM", decimals: 9 };
const XTR = { code: "XTR", decimals: 0 };

describe("slugify: идентификатор из названия", () => {
  it("«Карта Т-Банка» → «karta-t-banka»: кириллица транслитом, дефис остаётся", () => {
    expect(slugify("Карта Т-Банка")).toBe("karta-t-banka");
  });

  it("регистр и знаки: строчные латиница и цифры, всё остальное — один дефис, без дефисов по краям", () => {
    expect(slugify("  Сервер (VPS), №2!  ")).toBe("server-vps-2");
    expect(slugify("Binance Pay")).toBe("binance-pay");
    expect(slugify("Щука, Ёж и Юла")).toBe("shchuka-ezh-i-yula");
  });

  it("точка идентификатора не часть: она разделяет сегменты счёта, поэтому в слаге её нет", () => {
    expect(slugify("Сервер v1.2")).toBe("server-v1-2");
  });

  it("пустое название и название без букв и цифр — исключение", () => {
    expect(() => slugify("")).toThrow(ChartRuleError);
    expect(() => slugify("   ")).toThrow(ChartRuleError);
    expect(() => slugify("!!! ???")).toThrow(ChartRuleError);
  });

  it("короче трёх знаков — исключение: «ИИ» не годится как идентификатор", () => {
    expect(() => slugify("ИИ")).toThrow(ChartRuleError);
    expect(slugify("ИИИ")).toBe("iii");
  });

  it("200 знаков — исключение, а не молчаливая обрезка: два длинных названия слиплись бы в один идентификатор", () => {
    expect(() => slugify("а".repeat(200))).toThrow(ChartRuleError);
  });

  it("48 знаков — последний допустимый, 49 — уже нет", () => {
    expect(slugify("a".repeat(48))).toHaveLength(48);
    expect(() => slugify("a".repeat(49))).toThrow(ChartRuleError);
  });
});

describe("идентификаторы счетов", () => {
  it("счёт статьи в валюте: расход — expense.<статья>.<валюта>, поступление — income.<статья>.<валюта>", () => {
    expect(articleAccountId("vps", "expense", "USD")).toBe("expense.vps.USD");
    expect(articleAccountId("vps", "expense", "RUB")).toBe("expense.vps.RUB");
    expect(articleAccountId("ads_adsgram", "income", "USDT")).toBe("income.ads_adsgram.USDT");
  });

  it("счёт места — по виду валюты: банк для обычных, кошелёк для крипты, «звёзды» для платформенной", () => {
    expect(placeAccountId("karta-t-banka", "fiat")).toBe("bank.karta-t-banka");
    expect(placeAccountId("ledger-nano", "crypto")).toBe("wallet.ledger-nano");
    expect(placeAccountId("bot-2", "platform")).toBe("stars.bot-2");
  });
});

describe("feeOf: комиссия по шаблону места", () => {
  it("2 % от 1 000 000 нано-Gram — 20 000", () => {
    expect(feeOf(1_000_000n, { percentBp: 200, fixed: null, fixedCurrency: null }, GRAM)).toEqual([{ kind: "percent", currency: "GRAM", amount: 20_000n }]);
  });

  it("процент даёт дробь — округляется вверх до единицы: комиссию не занижаем", () => {
    // 2,5 % от 99 звёзд = 2,475 → 3; от 100 = 2,5 → 3
    expect(feeOf(99n, { percentBp: 250, fixed: null, fixedCurrency: null }, XTR)).toEqual([{ kind: "percent", currency: "XTR", amount: 3n }]);
    expect(feeOf(100n, { percentBp: 250, fixed: null, fixedCurrency: null }, XTR)).toEqual([{ kind: "percent", currency: "XTR", amount: 3n }]);
    // делится нацело — лишней единицы не прибавляем
    expect(feeOf(400n, { percentBp: 250, fixed: null, fixedCurrency: null }, XTR)).toEqual([{ kind: "percent", currency: "XTR", amount: 10n }]);
  });

  it("сумма за пределом 2^53 не теряет точности: считается в bigint", () => {
    const amount = 9_007_199_254_740_993n;
    expect(feeOf(amount, { percentBp: 10_000, fixed: null, fixedCurrency: null }, GRAM)).toEqual([{ kind: "percent", currency: "GRAM", amount }]);
  });

  it("фикса в другой валюте — отдельная строка в её валюте", () => {
    expect(feeOf(100n, { percentBp: 200, fixed: 50_000_000n, fixedCurrency: "GRAM" }, XTR)).toEqual([
      { kind: "percent", currency: "XTR", amount: 2n },
      { kind: "fixed", currency: "GRAM", amount: 50_000_000n },
    ]);
  });

  it("одна фикса без процента — одна строка", () => {
    expect(feeOf(100n, { percentBp: null, fixed: 7n, fixedCurrency: "USDT" }, XTR)).toEqual([{ kind: "fixed", currency: "USDT", amount: 7n }]);
  });

  it("без шаблона — пусто; нулевой процент и нулевая фикса — тоже", () => {
    expect(feeOf(100n, { percentBp: null, fixed: null, fixedCurrency: null }, XTR)).toEqual([]);
    expect(feeOf(100n, { percentBp: 0, fixed: 0n, fixedCurrency: "GRAM" }, XTR)).toEqual([]);
  });

  it("сумма не больше нуля — исключение: комиссию считают от того, что переводят", () => {
    expect(() => feeOf(0n, { percentBp: 200, fixed: null, fixedCurrency: null }, XTR)).toThrow(RangeError);
    expect(() => feeOf(-5n, { percentBp: 200, fixed: null, fixedCurrency: null }, XTR)).toThrow(RangeError);
  });
});

describe("feeTemplateProblem: что не так с шаблоном", () => {
  it("корректные шаблоны проблем не дают", () => {
    expect(feeTemplateProblem({ percentBp: null, fixed: null, fixedCurrency: null })).toBeNull();
    expect(feeTemplateProblem({ percentBp: 0, fixed: null, fixedCurrency: null })).toBeNull();
    expect(feeTemplateProblem({ percentBp: 10_000, fixed: 1n, fixedCurrency: "GRAM" })).toBeNull();
  });

  it("процент вне 0…10 000 и нецелый — проблема", () => {
    expect(feeTemplateProblem({ percentBp: -1, fixed: null, fixedCurrency: null })).not.toBeNull();
    expect(feeTemplateProblem({ percentBp: 10_001, fixed: null, fixedCurrency: null })).not.toBeNull();
    expect(feeTemplateProblem({ percentBp: 1.5, fixed: null, fixedCurrency: null })).not.toBeNull();
  });

  it("фикса без валюты, валюта без фиксы, отрицательная фикса, валюта вне справочника — проблема", () => {
    expect(feeTemplateProblem({ percentBp: null, fixed: 5n, fixedCurrency: null })).not.toBeNull();
    expect(feeTemplateProblem({ percentBp: null, fixed: null, fixedCurrency: "GRAM" })).not.toBeNull();
    expect(feeTemplateProblem({ percentBp: null, fixed: -1n, fixedCurrency: "GRAM" })).not.toBeNull();
    expect(feeTemplateProblem({ percentBp: null, fixed: 5n, fixedCurrency: "ABC" })).not.toBeNull();
  });
});
