import { describe, expect, it } from "vitest";
import { Decimal } from "../src/decimal.js";
import { availableMethods, DEFAULT_PAYMENT_METHODS, findPaymentMethodProblems, type PaymentMethod } from "../src/pricing/payment-method.js";
import { canSellWith, computePriceList, DEFAULT_PRICING_RULES, priceFor, shouldReprice } from "../src/pricing/price-list.js";
import { baseUsd, findProductProblems, PRICE_TIERS, type Product } from "../src/pricing/product.js";
import { settle, SettlementError } from "../src/pricing/revenue.js";
import { DEFAULT_ROUNDING, findRoundingProblems, roundPrice } from "../src/pricing/rounding.js";
import { DEFAULT_FRESHNESS } from "../src/rates/freshness.js";
import type { AcceptedRate } from "../src/rates/rate.js";
import { createSnapshot, type RateSnapshot } from "../src/rates/snapshot.js";

// Слой цен (docs/35-stage4-plan.md §3.12, Р33): одна базовая цена → цена
// каждого способа по снимку с правилом округления валюты; цены не прыгают от
// каждого обновления курса; платёж несёт снимок, и выручка считается из него.

const NOW = Date.UTC(2026, 8, 25, 12);
const HOUR = 3_600_000;

function accepted(currency: AcceptedRate["currency"], usdPerUnit: string, overrides: Partial<AcceptedRate> = {}): AcceptedRate {
  return { currency, purpose: "price", usdPerUnit: Decimal.of(usdPerUnit), sources: ["test"], acceptedAt: NOW, fixed: false, ...overrides };
}

function snapshot(id: string, at: number, rub = "92.5", gram = "3.2"): RateSnapshot {
  return createSnapshot({
    id,
    at,
    accepted: [
      accepted("RUB", Decimal.ONE.div(rub, 18).toString()),
      accepted("EUR", "1.08"),
      accepted("GRAM", gram),
      accepted("USDT", "0.9998"),
      accepted("XTR", "0.02", { fixed: true, validUntil: at + 30 * 24 * HOUR, sources: ["fixed"] }),
      accepted("XTR", "0.013", { purpose: "revenue", fixed: true, validUntil: at + 30 * 24 * HOUR, sources: ["fixed"] }),
    ],
    freshness: DEFAULT_FRESHNESS,
  });
}

const SNAPSHOT = snapshot("s1", NOW);
const METHODS = DEFAULT_PAYMENT_METHODS;
const method = (id: string): PaymentMethod => METHODS.find((entry) => entry.id === id)!;

describe("округление по валюте", () => {
  it.each([
    ["0.4", "1"],
    ["1.5", "2"],
    ["49.5", "50"],
    ["49.49", "49"],
  ])("звёзды: %s → %s, целые и не меньше одной", (raw, expected) => {
    expect(roundPrice(Decimal.of(raw), DEFAULT_ROUNDING.XTR).toString()).toBe(expected);
  });

  it.each([
    ["3", "9"],
    ["12", "9"],
    ["14", "19"],
    ["43", "39"],
    ["44", "49"],
    ["95", "99"],
    ["99.5", "99"],
    ["120", "99"],
    ["148", "99"],
    ["149", "199"],
    ["250", "299"],
    ["1234", "1199"],
    ["1250", "1299"],
  ])("рубли: %s → %s, на «…9» до сотни и на «…99» дальше", (raw, expected) => {
    expect(roundPrice(Decimal.of(raw), DEFAULT_ROUNDING.RUB).toString()).toBe(expected);
  });

  it("Gram, USDT и фиат отчётности — два знака", () => {
    expect(roundPrice(Decimal.of("1.2349"), DEFAULT_ROUNDING.GRAM).toString()).toBe("1.23");
    expect(roundPrice(Decimal.of("1.235"), DEFAULT_ROUNDING.USDT).toString()).toBe("1.24");
    expect(roundPrice(Decimal.of("0.005"), DEFAULT_ROUNDING.USD).toString()).toBe("0.01");
    expect(findRoundingProblems(DEFAULT_ROUNDING)).toEqual([]);
    expect(findRoundingProblems({ ...DEFAULT_ROUNDING, XTR: { kind: "integer", min: Decimal.ZERO }, GRAM: { kind: "decimals", places: 19 } })).toEqual([
      "округление XTR: минимум должен быть больше нуля",
      "округление GRAM: число знаков вне 0..18",
    ]);
  });
});

describe("реестр способов оплаты", () => {
  it("проходит проверку, в Telegram только звёзды, в вебе выбор по стране", () => {
    expect(findPaymentMethodProblems(METHODS)).toEqual([]);
    expect(availableMethods(METHODS, { platform: "telegram" }).map((entry) => entry.id)).toEqual(["telegram_stars"]);
    expect(availableMethods(METHODS, { platform: "web", country: "RU" }).map((entry) => entry.id)).toEqual(["web_card_rub", "web_sbp_rub", "web_ton_gram", "web_ton_usdt"]);
    expect(availableMethods(METHODS, { platform: "web", country: "DE" }).map((entry) => entry.id)).toEqual(["web_ton_gram", "web_ton_usdt"]);
    expect(availableMethods(METHODS, { platform: "web" }).map((entry) => entry.id)).toEqual(["web_ton_gram", "web_ton_usdt"]);
    expect(availableMethods(METHODS, { platform: "vk" })).toEqual([]);
  });

  it("называет способ и поле в ошибке", () => {
    const broken: PaymentMethod[] = [
      ...METHODS,
      { ...method("max_rub"), id: "max_rub", fee: { rate: Decimal.of("1"), mode: "inside" }, platformShare: Decimal.of("-0.1"), min: Decimal.of(100), max: Decimal.of(10), countries: ["ru"] },
    ];
    const problems = findPaymentMethodProblems(broken);
    expect(problems).toContain("способ оплаты max_rub: идентификатор повторяется");
    expect(problems).toContain("способ оплаты max_rub: комиссия должна быть в [0, 1)");
    expect(problems).toContain("способ оплаты max_rub: доля площадки должна быть в [0, 1)");
    expect(problems).toContain("способ оплаты max_rub: верхний предел меньше нижнего");
    expect(problems).toContain("способ оплаты max_rub: порядок 1 на площадке max уже занят");
    expect(problems).toContain("способ оплаты max_rub: код страны ru не ISO 3166-1 alpha-2");
  });
});

describe("товары и прайс-лист", () => {
  const gems: Product = { id: "gems_small", base: { usd: Decimal.of("0.99") }, manual: {} };
  const starter: Product = { id: "starter", base: { tier: 2 }, manual: { telegram_stars: Decimal.of(50) } };

  it("берёт цену из ступени и проверяет товары", () => {
    expect(baseUsd(starter).toString()).toBe("2.99");
    expect(PRICE_TIERS.every((tier, index) => index === 0 || tier.gt(PRICE_TIERS[index - 1]!))).toBe(true);
    expect(findProductProblems([gems, starter], METHODS)).toEqual([]);
    const problems = findProductProblems([gems, { id: "gems_small", base: { tier: 99 }, manual: { nope: Decimal.ZERO } }, { id: "free", base: { usd: Decimal.ZERO }, manual: {} }], METHODS);
    expect(problems).toContain("товар gems_small: идентификатор повторяется");
    expect(problems).toContain(`товар gems_small: ступени 99 нет (всего ${PRICE_TIERS.length})`);
    expect(problems).toContain("товар gems_small: ручная цена для неизвестного способа nope");
    expect(problems).toContain("товар gems_small: ручная цена для nope должна быть больше нуля");
    expect(problems).toContain("товар free: базовая цена должна быть больше нуля");
  });

  it("считает цену каждого способа из одной базовой по правилам валюты", () => {
    const list = computePriceList([gems], METHODS, SNAPSHOT, DEFAULT_PRICING_RULES);
    const by = Object.fromEntries(list.prices.map((price) => [price.methodId, price]));
    expect(list.snapshotId).toBe("s1");
    // 0.99 $ = 49.5 ⭐ → 50; = 91.575 ₽ → 89; = 0.309375 Gram → 0.31; = 0.9902 USDT → 0.99.
    expect(by.telegram_stars).toMatchObject({ currency: "XTR", manual: false, clamped: null, minorUnits: 50n });
    expect(by.telegram_stars?.amount.toString()).toBe("50");
    expect(by.max_rub?.amount.toString()).toBe("89");
    expect(by.web_card_rub?.minorUnits).toBe(8900n);
    expect(by.web_ton_gram?.amount.toString()).toBe("0.31");
    expect(by.web_ton_gram?.minorUnits).toBe(310_000_000n);
    expect(by.web_ton_usdt?.amount.toString()).toBe("0.99");
  });

  it("ручная цена берётся как есть, предел способа поджимает цену и помечает это", () => {
    const manual = priceFor(starter, method("telegram_stars"), SNAPSHOT, DEFAULT_PRICING_RULES);
    expect(manual).toMatchObject({ manual: true, minorUnits: 50n });
    expect(manual.amount.toString()).toBe("50");

    const tiny: Product = { id: "tiny", base: { usd: Decimal.of("0.01") }, manual: {} };
    const clampedMin = priceFor(tiny, method("max_rub"), SNAPSHOT, DEFAULT_PRICING_RULES);
    expect(clampedMin).toMatchObject({ clamped: "min" });
    expect(clampedMin.amount.toString()).toBe("10");

    const huge: Product = { id: "huge", base: { usd: Decimal.of("1000") }, manual: {} };
    const clampedMax = priceFor(huge, method("telegram_stars"), SNAPSHOT, DEFAULT_PRICING_RULES);
    expect(clampedMax).toMatchObject({ clamped: "max" });
    expect(clampedMax.amount.toString()).toBe("10000");
  });

  it("комиссия сверху входит в цену, внутри — нет", () => {
    const onTop: PaymentMethod = { ...method("web_card_rub"), id: "web_card_on_top", fee: { rate: Decimal.of("0.1"), mode: "on_top" }, order: 9 };
    const ten: Product = { id: "ten", base: { usd: Decimal.of("10") }, manual: {} };
    expect(priceFor(ten, method("web_card_rub"), SNAPSHOT, DEFAULT_PRICING_RULES).amount.toString()).toBe("899");
    expect(priceFor(ten, onTop, SNAPSHOT, DEFAULT_PRICING_RULES).amount.toString()).toBe("999");
  });

  it("не пересчитывает цены от каждого обновления курса — только по сроку или скачку", () => {
    const current = computePriceList([gems], METHODS, SNAPSHOT, DEFAULT_PRICING_RULES);
    const slightly = snapshot("s2", NOW + HOUR, "94", "3.3");
    expect(shouldReprice({ current, currentSnapshot: SNAPSHOT, latest: slightly, methods: METHODS, now: NOW + HOUR, rules: DEFAULT_PRICING_RULES })).toEqual({ reprice: false, reason: null, jumped: [] });

    const jumped = snapshot("s3", NOW + HOUR, "92.5", "3.5");
    expect(shouldReprice({ current, currentSnapshot: SNAPSHOT, latest: jumped, methods: METHODS, now: NOW + HOUR, rules: DEFAULT_PRICING_RULES })).toEqual({ reprice: true, reason: "rate_jump", jumped: ["GRAM"] });

    // Скачок у валюты, которой нет ни у одного включённого способа, пересчёта не требует.
    const disabledGram = METHODS.map((entry) => (entry.currency === "GRAM" ? { ...entry, enabled: false } : entry));
    expect(shouldReprice({ current, currentSnapshot: SNAPSHOT, latest: jumped, methods: disabledGram, now: NOW + HOUR, rules: DEFAULT_PRICING_RULES }).reprice).toBe(false);

    expect(shouldReprice({ current, currentSnapshot: SNAPSHOT, latest: slightly, methods: METHODS, now: NOW + 24 * HOUR, rules: DEFAULT_PRICING_RULES })).toMatchObject({ reprice: true, reason: "aged" });
    expect(shouldReprice({ current: null, currentSnapshot: null, latest: slightly, methods: METHODS, now: NOW, rules: DEFAULT_PRICING_RULES })).toMatchObject({ reprice: true, reason: "no_prices" });
  });

  it("по устаревшему курсу продаёт не дольше заданного срока", () => {
    const stale = createSnapshot({ id: "stale", at: NOW + 2 * HOUR, accepted: [accepted("GRAM", "3.2"), accepted("RUB", "0.0108")], freshness: DEFAULT_FRESHNESS });
    expect(stale.quotes.GRAM?.stale).toBe(true);
    expect(canSellWith(stale, "GRAM", NOW + 2 * HOUR, DEFAULT_PRICING_RULES)).toEqual({ ok: true });
    expect(canSellWith(stale, "GRAM", NOW + 73 * HOUR, DEFAULT_PRICING_RULES)).toEqual({ ok: false, reason: "stale_too_long" });
    expect(canSellWith(stale, "RUB", NOW + 73 * HOUR, DEFAULT_PRICING_RULES)).toEqual({ ok: true });
    expect(canSellWith(stale, "XTR", NOW, DEFAULT_PRICING_RULES)).toEqual({ ok: false, reason: "missing_rate" });
  });
});

describe("выручка платежа", () => {
  it("звёзды: выручка по курсу выручки, а не по цене игрока", () => {
    const settlement = settle({ amount: Decimal.of(50), currency: "XTR", methodId: "telegram_stars", snapshotId: "s1" }, method("telegram_stars"), SNAPSHOT, "USD");
    expect(settlement.gross.toString()).toBe("50");
    expect(settlement.providerFee.toString()).toBe("0");
    expect(settlement.net.toString()).toBe("50");
    // 50 ⭐ × 0.013 $ = 0.65 $, хотя игрок «заплатил» 50 × 0.02 = 1 $.
    expect(settlement.grossReporting.toString()).toBe("0.65");
    expect(settlement.netReporting.toString()).toBe("0.65");
    const inRub = settle({ amount: Decimal.of(50), currency: "XTR", methodId: "telegram_stars", snapshotId: "s1" }, method("telegram_stars"), SNAPSHOT, "RUB");
    // 0.65 $ × 92.5 = 60.125 ₽ → банковское округление даёт 60.12.
    expect(inRub.netReporting.toString()).toBe("60.12");
  });

  it("комиссия внутри и сверху, доля площадки, округление отчёта банковское", () => {
    const card = method("web_card_rub");
    const inside = settle({ amount: Decimal.of(899), currency: "RUB", methodId: card.id, snapshotId: "s1" }, card, SNAPSHOT, "USD");
    expect(inside.providerFee.toString()).toBe("31.46");
    expect(inside.net.toString()).toBe("867.54");
    expect(inside.grossReporting.toString()).toBe("9.72");
    expect(inside.netReporting.toString()).toBe("9.38");

    const onTop: PaymentMethod = { ...card, fee: { rate: Decimal.of("0.1"), mode: "on_top" }, platformShare: Decimal.of("0.3") };
    const top = settle({ amount: Decimal.of(110), currency: "RUB", methodId: card.id, snapshotId: "s1" }, onTop, SNAPSHOT, "RUB");
    expect(top.providerFee.toString()).toBe("10");
    expect(top.platformShare.toString()).toBe("30");
    expect(top.net.toString()).toBe("70");
    expect(top.grossReporting.toString()).toBe("110");
    expect(top.netReporting.toString()).toBe("70");
  });

  it("не считает платёж не тем способом, не в той валюте и не по тому снимку", () => {
    const stars = method("telegram_stars");
    expect(() => settle({ amount: Decimal.of(1), currency: "XTR", methodId: "max_rub", snapshotId: "s1" }, stars, SNAPSHOT, "USD")).toThrow(SettlementError);
    expect(() => settle({ amount: Decimal.of(1), currency: "RUB", methodId: stars.id, snapshotId: "s1" }, stars, SNAPSHOT, "USD")).toThrow(/принимает XTR/);
    expect(() => settle({ amount: Decimal.of(1), currency: "XTR", methodId: stars.id, snapshotId: "other" }, stars, SNAPSHOT, "USD")).toThrow(/снимок/);
    expect(() => settle({ amount: Decimal.ZERO, currency: "XTR", methodId: stars.id, snapshotId: "s1" }, stars, SNAPSHOT, "USD")).toThrow(/больше нуля/);
  });
});
