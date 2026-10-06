import { describe, expect, it } from "vitest";
import { acceptQuotes, median } from "../src/accept.js";
import { Decimal } from "../src/decimal.js";
import { freshness } from "../src/freshness.js";
import { ACCEPT_POLICY, FRESHNESS_POLICY } from "../src/policy.js";
import { quoteInUsd, type Quote } from "../src/quote.js";
import { rateOf } from "../src/rates.js";
import { matchBySourceId } from "../src/sources.js";

/**
 * Приём курса (docs/35-stage4-plan.md, WP9): ошибка одного источника не
 * переписывает цены, скачок без подтверждения уходит в алерт, молчащий
 * источник не выдаёт старый курс за свежий.
 */

const NOW = new Date("2026-09-25T12:00:00Z");
const MINUTE = 60_000;
const crypto = ACCEPT_POLICY.crypto;

const quote = (source: string, usd: string, agoMs = MINUTE): Quote => quoteInUsd("GRAM", usd, source, new Date(NOW.getTime() - agoMs));
const previous = (usd: string) => rateOf("GRAM", usd, ["coingecko"], new Date(NOW.getTime() - 10 * MINUTE));

describe("приём котировок", () => {
  it("первый курс принимается и от одного источника", () => {
    const decision = acceptQuotes({ currency: "GRAM", previous: null, quotes: [quote("coingecko", "5.2")], now: NOW, policy: crypto });
    expect(decision).toMatchObject({ status: "accepted", confirmedJump: false });
    expect(decision.status === "accepted" && decision.rate.usdPerUnit.toString()).toBe("5.2");
  });

  it("обычное движение рынка проходит без подтверждения", () => {
    const decision = acceptQuotes({ currency: "GRAM", previous: previous("5.2"), quotes: [quote("coingecko", "5.6")], now: NOW, policy: crypto });
    expect(decision.status).toBe("accepted");
  });

  it("скачок от одного источника не принимается — цены стоят", () => {
    const decision = acceptQuotes({ currency: "GRAM", previous: previous("5.2"), quotes: [quote("coingecko", "2.6")], now: NOW, policy: crypto });
    expect(decision).toMatchObject({ status: "rejected", reason: "jump_unconfirmed" });
  });

  it("скачок, который подтвердил второй источник, принимается", () => {
    const decision = acceptQuotes({ currency: "GRAM", previous: previous("5.2"), quotes: [quote("coingecko", "2.6"), quote("tonapi", "2.62")], now: NOW, policy: crypto });
    expect(decision).toMatchObject({ status: "accepted", confirmedJump: true });
    expect(decision.status === "accepted" && decision.rate.sources).toEqual(["coingecko", "tonapi"]);
  });

  it("повтор опроса одного источника не подтверждает его же скачок", () => {
    const decision = acceptQuotes({
      currency: "GRAM",
      previous: previous("5.2"),
      quotes: [quote("coingecko", "2.6", 2 * MINUTE), quote("coingecko", "2.6", MINUTE)],
      now: NOW,
      policy: crypto,
    });
    expect(decision).toMatchObject({ status: "rejected", reason: "jump_unconfirmed" });
  });

  it("медиана трёх источников не сдвигается одним сошедшим с ума, и он не в опорах", () => {
    const decision = acceptQuotes({
      currency: "GRAM",
      previous: previous("5.2"),
      quotes: [quote("coingecko", "5.21"), quote("tonapi", "5.19"), quote("exchange", "0.52")],
      now: NOW,
      policy: crypto,
    });
    expect(decision.status === "accepted" && decision.rate.usdPerUnit.toString()).toBe("5.19");
    expect(decision.status === "accepted" && decision.rate.sources).toEqual(["coingecko", "tonapi"]);
  });

  it("два несогласных источника без прежнего курса — не среднее, а отказ", () => {
    const decision = acceptQuotes({ currency: "GRAM", previous: null, quotes: [quote("coingecko", "5.2"), quote("exchange", "2.6")], now: NOW, policy: crypto });
    expect(decision).toMatchObject({ status: "rejected", reason: "sources_disagree" });
  });

  it("два несогласных при прежнем курсе — ближний к нему, без подтверждения", () => {
    const decision = acceptQuotes({ currency: "GRAM", previous: previous("5.2"), quotes: [quote("coingecko", "5.3"), quote("exchange", "2.6")], now: NOW, policy: crypto });
    expect(decision.status === "accepted" && decision.rate.usdPerUnit.toString()).toBe("5.3");
    expect(decision.status === "accepted" && decision.rate.sources).toEqual(["coingecko"]);
  });

  it("старые котировки и котировки из будущего не участвуют", () => {
    const stale = acceptQuotes({ currency: "GRAM", previous: previous("5.2"), quotes: [quote("coingecko", "5.3", 31 * MINUTE)], now: NOW, policy: crypto });
    const future = acceptQuotes({ currency: "GRAM", previous: previous("5.2"), quotes: [quote("coingecko", "5.3", -6 * MINUTE)], now: NOW, policy: crypto });
    expect(stale).toEqual({ status: "no_quotes" });
    expect(future).toEqual({ status: "no_quotes" });
  });

  it("котировки чужой валюты в приём не попадают", () => {
    const decision = acceptQuotes({ currency: "GRAM", previous: null, quotes: [quoteInUsd("USDT", "1", "coingecko", NOW)], now: NOW, policy: crypto });
    expect(decision).toEqual({ status: "no_quotes" });
  });

  it("курс не свежее своей старейшей опоры", () => {
    const decision = acceptQuotes({ currency: "GRAM", previous: null, quotes: [quote("coingecko", "5.2", 5 * MINUTE), quote("tonapi", "5.2", MINUTE)], now: NOW, policy: crypto });
    expect(decision.status === "accepted" && decision.rate.observedAt).toEqual(new Date(NOW.getTime() - 5 * MINUTE));
  });

  it("медиана чётного набора — среднее двух средних", () => {
    expect(median(["1", "4", "2", "3"].map((value) => new Decimal(value))).toString()).toBe("2.5");
    expect(() => median([])).toThrow(RangeError);
  });
});

describe("сопоставление валют источника", () => {
  const mapping = [{ currency: "GRAM" as const, sourceId: "the-open-network" }];

  it("посторонний жетон с тикером GRAM не подменяет курс Gram", () => {
    const matched = matchBySourceId(mapping, [
      ["gram-imposter", { symbol: "GRAM", usd: 0.004 }],
      ["the-open-network", { symbol: "GRAM", usd: 5.2 }],
    ]);
    expect(matched.get("GRAM")).toEqual({ symbol: "GRAM", usd: 5.2 });
  });

  it("нашей метки в ответе нет — курса нет, а не курс самозванца", () => {
    const matched = matchBySourceId(mapping, [["gram-imposter", { symbol: "GRAM", usd: 0.004 }]]);
    expect(matched.has("GRAM")).toBe(false);
  });
});

describe("свежесть", () => {
  it("крипта устаревает через полчаса и перестаёт продаваться через сутки после этого", () => {
    const policy = FRESHNESS_POLICY.crypto;
    const at = (agoMs: number) => freshness(new Date(NOW.getTime() - agoMs), NOW, policy);
    expect(at(30 * MINUTE)).toBe("fresh");
    expect(at(30 * MINUTE + 1)).toBe("stale");
    expect(at(30 * MINUTE + 24 * 60 * MINUTE)).toBe("stale");
    expect(at(30 * MINUTE + 24 * 60 * MINUTE + 1)).toBe("expired");
  });

  it("заданный курс устаревает в срок годности, а не через время после", () => {
    const expiresAt = new Date(NOW.getTime() - 1);
    expect(freshness(expiresAt, NOW, FRESHNESS_POLICY.platform)).toBe("stale");
    expect(freshness(new Date(NOW.getTime() + MINUTE), NOW, FRESHNESS_POLICY.platform)).toBe("fresh");
  });
});
