import { expect, it } from "vitest";
import { Decimal } from "../src/decimal.js";
import { manualRate } from "../src/manual.js";
import { quoteInUsd } from "../src/quote.js";
import { rateOf } from "../src/rates.js";
import type { RateStore } from "../src/store.js";

/**
 * Контракт порта хранилища курсов (docs/35-stage4-plan.md, WP9). Его
 * проходят хранилище в памяти (здесь) и Postgres бэкенда
 * (`backend/api/test/fx.integration.test.ts`): ядро не знает про Prisma, и
 * совместимость держит этот тест, а не договорённость.
 *
 * `fresh()` отдаёт пустое хранилище — у Postgres это чистые таблицы или
 * уникальные метки источников.
 */
export function rateStoreContract(fresh: () => Promise<{ store: RateStore; source: (name: string) => string }>): void {
  const T0 = new Date("2026-09-25T12:00:00Z");
  const later = (ms: number) => new Date(T0.getTime() + ms);

  it("у источника по валюте — одна последняя котировка, у разных источников — свои", async () => {
    const { store, source } = await fresh();
    const a = source("a");
    const b = source("b");
    await store.saveQuotes([quoteInUsd("GRAM", "1.40", a, T0), quoteInUsd("USDT", "1", a, T0)]);
    await store.saveQuotes([quoteInUsd("GRAM", "1.43", a, later(60_000)), quoteInUsd("GRAM", "1.42", b, T0)]);

    const quotes = (await store.latestQuotes("GRAM")).filter((quote) => quote.source === a || quote.source === b);
    const bySource = new Map(quotes.map((quote) => [quote.source, quote]));
    expect(quotes).toHaveLength(2);
    expect(bySource.get(a)?.usdPerUnit.toString()).toBe("1.43");
    expect(bySource.get(a)?.observedAt).toEqual(later(60_000));
    expect(bySource.get(b)?.usdPerUnit.toString()).toBe("1.42");
  });

  it("курс хранится без потери точности, текущий заменяется, история копится", async () => {
    const { store, source } = await fresh();
    const tag = source("s");
    const precise = "0.011778563291741337466598407291741337";
    await store.setCurrentRate(rateOf("RUB", precise, [tag], T0), T0);
    await store.appendHistory(rateOf("RUB", precise, [tag], T0), T0);
    await store.setCurrentRate(rateOf("RUB", "0.0118", [tag, "x"], later(1000)), later(1000));

    const current = await store.currentRate("RUB");
    expect(current?.usdPerUnit.toString()).toBe("0.0118");
    expect(current?.sources).toEqual([tag, "x"]);
    expect(current?.acceptedAt).toEqual(later(1000));
    expect(await store.lastHistoryAt("RUB")).toEqual(T0);
  });

  it("точность истории и снимка — до последнего знака", async () => {
    const { store, source } = await fresh();
    const precise = new Decimal("0.011778563291741337466598407291741337");
    const snapshot = await store.saveSnapshot({
      takenAt: T0,
      rates: new Map([["RUB", rateOf("RUB", precise, [source("s")], T0)]]),
      payout: new Map([["XTR", rateOf("XTR", "0.0105", ["manual:x"], later(86_400_000))]]),
    });
    const loaded = await store.snapshot(snapshot.id);
    expect(loaded?.rates.get("RUB")?.usdPerUnit.equals(precise)).toBe(true);
    expect(loaded?.payout.get("XTR")?.usdPerUnit.toString()).toBe("0.0105");
    expect(loaded?.takenAt).toEqual(T0);
    expect(await store.snapshot("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("состояние источника — бюджет и следующий опрос", async () => {
    const { store, source } = await fresh();
    const id = source("budget");
    expect(await store.sourceState(id)).toBeNull();
    await store.saveSourceState(id, { usage: { month: "2026-09", used: 3, pausedUntil: later(900_000) }, nextPollAt: later(900_000) });
    await store.saveSourceState(id, { usage: { month: "2026-09", used: 4, pausedUntil: null }, nextPollAt: later(300_000) });
    expect(await store.sourceState(id)).toEqual({ usage: { month: "2026-09", used: 4, pausedUntil: null }, nextPollAt: later(300_000) });
  });

  it("действующий заданный курс — последний поставленный по валюте и цели", async () => {
    const { store, source } = await fresh();
    const who = source("owner");
    const base = { currency: "XTR" as const, setBy: who, expiresAt: later(30 * 86_400_000), note: "" };
    await store.appendManual(manualRate({ ...base, purpose: "price", usdPerUnit: "0.013", setAt: T0 }));
    await store.appendManual(manualRate({ ...base, purpose: "payout", usdPerUnit: "0.0105", setAt: later(1000) }));
    await store.appendManual(manualRate({ ...base, purpose: "price", usdPerUnit: "0.0135", setAt: later(2000) }));

    expect((await store.currentManual("XTR", "price"))?.usdPerUnit.toString()).toBe("0.0135");
    expect((await store.currentManual("XTR", "payout"))?.usdPerUnit.toString()).toBe("0.0105");
  });
}
