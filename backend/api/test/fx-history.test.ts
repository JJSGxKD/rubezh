import { decimal, type CurrencyCode, type ManualRatePurpose } from "@bh/fx";
import { describe, expect, it } from "vitest";
import { rateAt, ratesAt, STALE_AFTER_MS, type FxHistoryStore, type HistoryRow, type ManualRow } from "../src/modules/fx/fx-history.js";

/**
 * Курс на прошлую дату (docs/35-stage4-plan.md, §3.12, Р219, Р222): рыночные
 * валюты — из истории принятых курсов, звезда — по заданному курсу выплаты на
 * дату. Хранилище подставное и считает обращения: пакетный запрос не вправе
 * ходить в базу в цикле.
 */

const DAY_MS = 86_400_000;
const at = (iso: string): Date => new Date(iso);

interface MarketLine extends HistoryRow {
  currency: CurrencyCode;
}
interface ManualLine extends ManualRow {
  currency: CurrencyCode;
  purpose: ManualRatePurpose;
}

/** Хранилище в памяти: те же границы, что у базы, — «не позже даты» включает саму дату. */
class FakeHistory implements FxHistoryStore {
  calls = 0;
  constructor(
    private readonly market: readonly MarketLine[] = [],
    private readonly manual: readonly ManualLine[] = [],
  ) {}

  async historyAt(currency: CurrencyCode, when: Date): Promise<HistoryRow | null> {
    this.calls += 1;
    const rows = this.market.filter((row) => row.currency === currency && row.at <= when).sort((a, b) => b.at.getTime() - a.at.getTime());
    return rows[0] ?? null;
  }

  async historySpan(currency: CurrencyCode, from: Date, to: Date): Promise<HistoryRow[]> {
    this.calls += 1;
    const own = this.market.filter((row) => row.currency === currency).sort((a, b) => a.at.getTime() - b.at.getTime());
    const base = own.filter((row) => row.at <= from).at(-1);
    return [...(base === undefined ? [] : [base]), ...own.filter((row) => row.at > from && row.at < to)];
  }

  async manualAt(currency: CurrencyCode, purpose: ManualRatePurpose, when: Date): Promise<ManualRow | null> {
    this.calls += 1;
    const rows = this.manual.filter((row) => row.currency === currency && row.purpose === purpose && row.setAt <= when).sort((a, b) => b.setAt.getTime() - a.setAt.getTime());
    return rows[0] ?? null;
  }

  async manualSpan(currency: CurrencyCode, purpose: ManualRatePurpose, from: Date, to: Date): Promise<ManualRow[]> {
    this.calls += 1;
    const own = this.manual.filter((row) => row.currency === currency && row.purpose === purpose).sort((a, b) => a.setAt.getTime() - b.setAt.getTime());
    const base = own.filter((row) => row.setAt <= from).at(-1);
    return [...(base === undefined ? [] : [base]), ...own.filter((row) => row.setAt > from && row.setAt < to)];
  }
}

function market(currency: CurrencyCode, iso: string, usdPerUnit: string): MarketLine {
  return { currency, at: at(iso), usdPerUnit: decimal(usdPerUnit) };
}

function payout(price: string, quote: CurrencyCode, setIso: string, days = 30, purpose: ManualRatePurpose = "payout"): ManualLine {
  const setAt = at(setIso);
  return { currency: "XTR", purpose, price: decimal(price), quote, setAt, expiresAt: new Date(setAt.getTime() + days * DAY_MS) };
}

describe("курс на дату: рыночные валюты", () => {
  it("доллар — единица в любой день, без обращения к хранилищу", async () => {
    const store = new FakeHistory();
    const rate = await rateAt(store, "USD", at("2026-11-01T12:00:00Z"));
    expect(rate).toMatchObject({ stale: false });
    expect(rate?.usdPerUnit.toFixed()).toBe("1");
    expect(store.calls).toBe(0);
  });

  it("берёт последнюю запись не позже даты, а не ближайшую и не позднюю", async () => {
    const store = new FakeHistory([
      market("EUR", "2026-10-30T08:00:00Z", "1.10"),
      market("EUR", "2026-11-01T08:00:00Z", "1.12"),
      market("EUR", "2026-11-01T20:00:00Z", "1.13"),
    ]);
    const rate = await rateAt(store, "EUR", at("2026-11-01T12:00:00Z"));
    expect(rate?.usdPerUnit.toFixed()).toBe("1.12");
    expect(rate?.at.toISOString()).toBe("2026-11-01T08:00:00.000Z");
    expect(rate).toMatchObject({ stale: false, source: "market" });
  });

  it("запись ровно на дату входит", async () => {
    const store = new FakeHistory([market("EUR", "2026-11-01T12:00:00.000Z", "1.12")]);
    expect((await rateAt(store, "EUR", at("2026-11-01T12:00:00.000Z")))?.usdPerUnit.toFixed()).toBe("1.12");
  });

  it("курс старше семи дней до даты помечен stale, ровно семь дней — нет", async () => {
    const row = market("RUB", "2026-10-25T12:00:00Z", "0.0125");
    const store = new FakeHistory([row]);
    expect(STALE_AFTER_MS).toBe(7 * DAY_MS);
    expect(await rateAt(store, "RUB", at("2026-11-01T12:00:00Z"))).toMatchObject({ stale: false });
    expect(await rateAt(store, "RUB", at("2026-11-01T12:00:00.001Z"))).toMatchObject({ stale: true });
    // Курс при этом отдаётся: закрытие предупреждает, а не гадает.
    expect((await rateAt(store, "RUB", at("2026-12-01T00:00:00Z")))?.usdPerUnit.toFixed()).toBe("0.0125");
  });

  it("до первой записи истории курса нет — null", async () => {
    const store = new FakeHistory([market("RUB", "2026-03-01T00:00:00Z", "0.0125")]);
    expect(await rateAt(store, "RUB", at("2026-01-02T00:00:00Z"))).toBeNull();
    expect(await rateAt(store, "GRAM", at("2026-11-01T00:00:00Z"))).toBeNull();
  });
});

describe("курс на дату: звезда", () => {
  it("курс выплаты, заданный 28 октября, на 1 ноября — не просрочен", async () => {
    const store = new FakeHistory([], [payout("0.013", "USD", "2026-10-28T09:00:00Z")]);
    const rate = await rateAt(store, "XTR", at("2026-11-01T12:00:00Z"));
    expect(rate?.usdPerUnit.toFixed()).toBe("0.013");
    expect(rate).toMatchObject({ stale: false, source: "manual" });
    expect(rate?.at.toISOString()).toBe("2026-10-28T09:00:00.000Z");
  });

  it("берёт именно выплату: курс цены игрока и более поздний курс не годятся", async () => {
    const store = new FakeHistory(
      [],
      [
        payout("0.013", "USD", "2026-10-01T00:00:00Z"),
        payout("0.015", "USD", "2026-11-05T00:00:00Z"),
        payout("0.02", "USD", "2026-10-20T00:00:00Z", 30, "price"),
      ],
    );
    expect((await rateAt(store, "XTR", at("2026-11-01T00:00:00Z")))?.usdPerUnit.toFixed()).toBe("0.013");
  });

  it("срок курса на дату истёк — stale, а курс отдаётся", async () => {
    const store = new FakeHistory([], [payout("0.013", "USD", "2026-09-01T00:00:00Z", 30)]);
    const rate = await rateAt(store, "XTR", at("2026-11-01T00:00:00Z"));
    expect(rate).toMatchObject({ stale: true });
    expect(rate?.usdPerUnit.toFixed()).toBe("0.013");
    // Ровно в момент истечения курс ещё действует.
    expect(await rateAt(store, "XTR", at("2026-10-01T00:00:00Z"))).toMatchObject({ stale: false });
  });

  it("курс выплаты задан позже даты — null", async () => {
    const store = new FakeHistory([], [payout("0.013", "USD", "2026-11-05T00:00:00Z")]);
    expect(await rateAt(store, "XTR", at("2026-11-01T00:00:00Z"))).toBeNull();
  });

  it("цена в рублях пересчитывается через рубль на ту же дату, а не на сегодня", async () => {
    const store = new FakeHistory(
      [market("RUB", "2026-10-31T00:00:00Z", "0.0125"), market("RUB", "2026-11-02T00:00:00Z", "0.02")],
      [payout("1.72", "RUB", "2026-10-28T00:00:00Z")],
    );
    const rate = await rateAt(store, "XTR", at("2026-11-01T12:00:00Z"));
    expect(rate?.usdPerUnit.toFixed()).toBe("0.0215");
    expect(rate).toMatchObject({ stale: false, source: "manual" });
  });

  it("рубля на дату нет — null: курс звезды оценить не из чего", async () => {
    const store = new FakeHistory([market("RUB", "2026-11-02T00:00:00Z", "0.02")], [payout("1.72", "RUB", "2026-10-28T00:00:00Z")]);
    expect(await rateAt(store, "XTR", at("2026-11-01T12:00:00Z"))).toBeNull();
  });

  it("рубль на дату устарел — курс звезды тоже stale", async () => {
    const store = new FakeHistory([market("RUB", "2026-10-01T00:00:00Z", "0.0125")], [payout("1.72", "RUB", "2026-10-28T00:00:00Z")]);
    expect(await rateAt(store, "XTR", at("2026-11-01T12:00:00Z"))).toMatchObject({ stale: true });
  });
});

describe("курсы на много дат пакетом", () => {
  const history = [
    market("EUR", "2026-10-31T23:00:00Z", "1.10"),
    market("EUR", "2026-11-03T10:00:00Z", "1.11"),
    market("EUR", "2026-11-05T00:00:00Z", "1.12"),
    market("EUR", "2026-11-07T18:00:00Z", "1.13"),
    market("RUB", "2026-10-30T00:00:00Z", "0.0125"),
    market("RUB", "2026-11-04T12:00:00Z", "0.0120"),
    market("RUB", "2026-11-09T06:00:00Z", "0.0110"),
  ];
  const manual = [payout("1.72", "RUB", "2026-10-29T00:00:00Z", 60), payout("0.013", "USD", "2026-11-06T00:00:00Z", 60)];

  /** 200 проводок за десять суток: разное время внутри дня, три валюты. */
  function pairs(): { currency: CurrencyCode; at: Date }[] {
    const out: { currency: CurrencyCode; at: Date }[] = [];
    const currencies: CurrencyCode[] = ["EUR", "RUB", "XTR", "USD"];
    for (let i = 0; i < 200; i += 1) {
      const day = i % 10;
      const minutes = (i * 37) % 1440;
      out.push({ currency: currencies[i % 4] ?? "EUR", at: new Date(Date.UTC(2026, 10, 1 + day) + minutes * 60_000) });
    }
    return out;
  }

  it("отвечает так же, как по одной дате, и в том же порядке", async () => {
    const batch = await ratesAt(new FakeHistory(history, manual), pairs());
    expect(batch).toHaveLength(200);
    const single = new FakeHistory(history, manual);
    for (const [index, pair] of pairs().entries()) {
      const expected = await rateAt(single, pair.currency, pair.at);
      expect(batch[index]?.usdPerUnit.toFixed(), `${pair.currency} ${pair.at.toISOString()}`).toBe(expected?.usdPerUnit.toFixed());
      expect(batch[index]?.stale).toBe(expected?.stale);
      expect(batch[index]?.at.getTime()).toBe(expected?.at.getTime());
    }
  });

  it("не больше обращений, чем валют × уникальных суток", async () => {
    const store = new FakeHistory(history, manual);
    await ratesAt(store, pairs());
    // Участвуют EUR, RUB (и сам по себе, и как котировка звезды) и XTR — три
    // источника за десять суток.
    expect(store.calls).toBeLessThanOrEqual(3 * 10);
  });

  it("повторы одной пары не умножают обращений", async () => {
    const store = new FakeHistory(history, manual);
    const same = Array.from({ length: 200 }, () => ({ currency: "EUR" as const, at: at("2026-11-04T12:00:00Z") }));
    const result = await ratesAt(store, same);
    expect(result.every((rate) => rate?.usdPerUnit.toFixed() === "1.11")).toBe(true);
    expect(store.calls).toBe(1);
  });

  it("пустой список — пустой ответ без обращений", async () => {
    const store = new FakeHistory(history, manual);
    expect(await ratesAt(store, [])).toEqual([]);
    expect(store.calls).toBe(0);
  });

  it("курса на дату нет — null на своём месте, остальные считаются", async () => {
    const store = new FakeHistory(history, manual);
    const result = await ratesAt(store, [
      { currency: "EUR", at: at("2026-10-01T00:00:00Z") },
      { currency: "EUR", at: at("2026-11-04T00:00:00Z") },
    ]);
    expect(result[0]).toBeNull();
    expect(result[1]?.usdPerUnit.toFixed()).toBe("1.11");
  });
});
