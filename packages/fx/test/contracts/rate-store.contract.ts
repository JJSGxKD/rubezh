import { describe, expect, it } from "vitest";
import { Decimal } from "../../src/decimal.js";
import type { RateStore } from "../../src/ports/store.js";
import type { AcceptedRate } from "../../src/rates/rate.js";
import { createSnapshot } from "../../src/rates/snapshot.js";
import { DEFAULT_FRESHNESS } from "../../src/rates/freshness.js";

/**
 * Контракт хранилища курсов: один набор проверок для памяти и для
 * Postgres-адаптера модуля бэкенда (docs/35-stage4-plan.md, WP9, «Тесты»).
 * Пакет не знает про Prisma — адаптер обязан вести себя так же, как память.
 */
export function describeRateStoreContract(name: string, factory: () => Promise<RateStore> | RateStore): void {
  const NOW = Date.UTC(2026, 8, 25, 12);
  const rate = (overrides: Partial<AcceptedRate> = {}): AcceptedRate => ({
    currency: "RUB",
    purpose: "price",
    usdPerUnit: Decimal.of("0.0108"),
    sources: ["cbr"],
    acceptedAt: NOW,
    fixed: false,
    ...overrides,
  });

  describe(`хранилище курсов: ${name}`, () => {
    it("начинает пустым", async () => {
      const store = await factory();
      expect(await store.latestAccepted()).toEqual([]);
      expect(await store.latestSnapshot()).toBeNull();
      expect(await store.getSnapshot("нет")).toBeNull();
      expect(await store.sourceState("cbr")).toBeNull();
      expect(await store.fixedRates()).toEqual([]);
      expect(await store.countRequests("cbr", 0, NOW)).toBe(0);
    });

    it("заменяет принятый курс по паре валюта–назначение и не трогает остальные", async () => {
      const store = await factory();
      await store.saveAccepted([rate(), rate({ currency: "GRAM", usdPerUnit: Decimal.of("3.2") }), rate({ currency: "XTR", purpose: "revenue", usdPerUnit: Decimal.of("0.013"), fixed: true })]);
      await store.saveAccepted([rate({ usdPerUnit: Decimal.of("0.0109"), acceptedAt: NOW + 1 })]);

      const latest = await store.latestAccepted();
      expect(latest).toHaveLength(3);
      expect(latest.find((entry) => entry.currency === "RUB")?.usdPerUnit.toString()).toBe("0.0109");
      expect(latest.find((entry) => entry.currency === "GRAM")?.usdPerUnit.toString()).toBe("3.2");
      expect(latest.find((entry) => entry.purpose === "revenue")?.fixed).toBe(true);
    });

    it("хранит историю наблюдений только добавлением и отдаёт её с момента", async () => {
      const store = await factory();
      await store.appendObservations([
        { currency: "RUB", sourceId: "cbr", sourceCurrencyId: "R01235", usdPerUnit: Decimal.of("0.0108"), observedAt: NOW },
        { currency: "RUB", sourceId: "open-er-api", sourceCurrencyId: "RUB", usdPerUnit: Decimal.of("0.0109"), observedAt: NOW + 1000 },
        { currency: "GRAM", sourceId: "coingecko", sourceCurrencyId: "the-open-network", usdPerUnit: Decimal.of("3.2"), observedAt: NOW },
      ]);
      await store.appendObservations([{ currency: "RUB", sourceId: "cbr", sourceCurrencyId: "R01235", usdPerUnit: Decimal.of("0.0108"), observedAt: NOW + 2000 }]);

      expect((await store.observations("RUB", 0)).map((entry) => entry.sourceId)).toEqual(["cbr", "open-er-api", "cbr"]);
      expect((await store.observations("RUB", NOW + 1000)).map((entry) => entry.observedAt)).toEqual([NOW + 1000, NOW + 2000]);
      expect(await store.observations("EUR", 0)).toEqual([]);
    });

    it("считает запросы к источнику в окне [от, до)", async () => {
      const store = await factory();
      await store.logRequest({ sourceId: "coingecko", at: NOW, ok: true, status: 200 });
      await store.logRequest({ sourceId: "coingecko", at: NOW + 1, ok: false, status: 429 });
      await store.logRequest({ sourceId: "coingecko", at: NOW + 2, ok: false, status: null });
      await store.logRequest({ sourceId: "tonapi", at: NOW, ok: true, status: 200 });

      expect(await store.countRequests("coingecko", NOW, NOW + 3)).toBe(3);
      expect(await store.countRequests("coingecko", NOW, NOW + 2)).toBe(2);
      expect(await store.countRequests("coingecko", NOW + 1, NOW + 3)).toBe(2);
      expect(await store.countRequests("tonapi", NOW, NOW + 3)).toBe(1);
    });

    it("хранит состояние источника между циклами", async () => {
      const store = await factory();
      const state = { sourceId: "coingecko", pausedUntil: NOW + 5000, consecutiveRateLimits: 2, lastPolledAt: NOW, lastSucceededAt: null };
      await store.saveSourceState(state);
      expect(await store.sourceState("coingecko")).toEqual(state);
      await store.saveSourceState({ ...state, pausedUntil: null, consecutiveRateLimits: 0 });
      expect(await store.sourceState("coingecko")).toMatchObject({ pausedUntil: null, consecutiveRateLimits: 0 });
    });

    it("отдаёт снимок по идентификатору и последний по времени", async () => {
      const store = await factory();
      const first = createSnapshot({ id: "s1", at: NOW, accepted: [rate()], freshness: DEFAULT_FRESHNESS });
      const second = createSnapshot({ id: "s2", at: NOW + 10, accepted: [rate({ usdPerUnit: Decimal.of("0.011") })], freshness: DEFAULT_FRESHNESS });
      await store.saveSnapshot(second);
      await store.saveSnapshot(first);

      expect((await store.getSnapshot("s1"))?.quotes.RUB?.usdPerUnit.toString()).toBe("0.0108");
      expect((await store.getSnapshot("s1"))?.quotes.USD?.usdPerUnit.eq(1)).toBe(true);
      expect((await store.latestSnapshot())?.id).toBe("s2");
    });

    it("хранит заданные курсы вместе с аудитом по порядку", async () => {
      const store = await factory();
      const fixed = { currency: "XTR" as const, purpose: "price" as const, usdPerUnit: Decimal.of("0.02"), validFrom: NOW, validUntil: NOW + 1000, setBy: "admin-1", reason: "старт" };
      await store.saveFixedRate(fixed, { currency: "XTR", purpose: "price", previous: null, next: fixed.usdPerUnit, by: "admin-1", at: NOW, reason: "старт" });
      await store.saveFixedRate({ ...fixed, validFrom: NOW + 500, usdPerUnit: Decimal.of("0.021") }, { currency: "XTR", purpose: "price", previous: fixed.usdPerUnit, next: Decimal.of("0.021"), by: "admin-2", at: NOW + 500, reason: "подняли" });

      expect((await store.fixedRates()).map((entry) => entry.usdPerUnit.toString()).sort()).toEqual(["0.02", "0.021"]);
      const audit = await store.fixedRateAudit("XTR", "price");
      expect(audit.map((entry) => entry.by)).toEqual(["admin-1", "admin-2"]);
      expect(audit[1]?.previous?.toString()).toBe("0.02");
      expect(await store.fixedRateAudit("XTR", "revenue")).toEqual([]);
    });

    it("отдаёт копии: правка результата не меняет хранилище", async () => {
      const store = await factory();
      await store.saveAccepted([rate()]);
      const latest = await store.latestAccepted();
      (latest[0] as { acceptedAt: number }).acceptedAt = 0;
      expect((await store.latestAccepted())[0]?.acceptedAt).toBe(NOW);
    });
  });
}
