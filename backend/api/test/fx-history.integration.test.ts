import { decimal } from "@bh/fx";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { rateAt, ratesAt } from "../src/modules/fx/fx-history.js";
import { PrismaRateStore } from "../src/modules/fx/fx.store.js";

/**
 * Курс на дату на живом Postgres (docs/35-stage4-plan.md, §3.12, Р222; адрес —
 * TEST_DATABASE_URL, без него пропуск). Память границ не покажет: запись ровно
 * на дату входит, запись на миг позже — нет, суточное окно не теряет курс,
 * принятый до его начала, а число в `numeric(80, 50)` доходит без потерь.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const at = (iso: string): Date => new Date(iso);

describe.skipIf(DATABASE_URL === "")("курс на дату на живом Postgres", () => {
  let prisma: PrismaClient;
  let store: PrismaRateStore;

  beforeAll(() => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
    store = new PrismaRateStore(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE fx_rate_history, fx_manual_rate`;
  });

  async function history(currency: string, acceptedAt: string, usdPerUnit: string): Promise<void> {
    await prisma.fxRateHistory.create({ data: { currency, usdPerUnit, sources: ["test"], observedAt: at(acceptedAt), acceptedAt: at(acceptedAt) } });
  }

  async function payout(price: string, quote: string, setAt: string, expiresAt: string, purpose = "payout"): Promise<void> {
    await prisma.fxManualRate.create({ data: { currency: "XTR", purpose, price, quote, setBy: "test", setAt: at(setAt), expiresAt: at(expiresAt), note: "тест" } });
  }

  it("запись истории ровно на дату входит, на миг позже — нет", async () => {
    await history("EUR", "2026-11-01T00:00:00.000Z", "1.10");
    await history("EUR", "2026-11-01T12:00:00.000Z", "1.12");
    expect((await store.historyAt("EUR", at("2026-11-01T12:00:00.000Z")))?.usdPerUnit.toFixed()).toBe("1.12");
    expect((await store.historyAt("EUR", at("2026-11-01T11:59:59.999Z")))?.usdPerUnit.toFixed()).toBe("1.10");
    expect(await store.historyAt("EUR", at("2026-10-31T23:59:59.999Z"))).toBeNull();
    expect(await store.historyAt("RUB", at("2026-11-01T12:00:00.000Z"))).toBeNull();
  });

  it("заданный курс ровно на дату входит, чужая цель и валюта — нет", async () => {
    await payout("0.013", "USD", "2026-10-28T09:00:00.000Z", "2026-11-27T09:00:00.000Z");
    await payout("0.02", "USD", "2026-10-30T00:00:00.000Z", "2026-11-27T09:00:00.000Z", "price");
    expect((await store.manualAt("XTR", "payout", at("2026-10-28T09:00:00.000Z")))?.price.toFixed()).toBe("0.013");
    expect(await store.manualAt("XTR", "payout", at("2026-10-28T08:59:59.999Z"))).toBeNull();
    expect((await store.manualAt("XTR", "price", at("2026-11-01T00:00:00.000Z")))?.price.toFixed()).toBe("0.02");
  });

  it("суточное окно: действовавшая на начало суток и принятые внутри, граница суток — в следующие", async () => {
    await history("EUR", "2026-10-20T00:00:00.000Z", "1.00");
    await history("EUR", "2026-11-01T00:00:00.000Z", "1.10");
    await history("EUR", "2026-11-01T12:00:00.000Z", "1.12");
    await history("EUR", "2026-11-02T00:00:00.000Z", "1.20");
    const rows = await store.historySpan("EUR", at("2026-11-01T00:00:00.000Z"), at("2026-11-02T00:00:00.000Z"));
    // Запись ровно на начало суток — действовавшая, а не «внутри»; запись на конец суток — уже следующих.
    expect(rows.map((row) => row.usdPerUnit.toFixed())).toEqual(["1.1", "1.12"]);
    const noBase = await store.historySpan("EUR", at("2026-10-19T00:00:00.000Z"), at("2026-10-20T00:00:00.000Z"));
    expect(noBase.map((row) => row.usdPerUnit.toFixed())).toEqual(["1"]);
    const carried = await store.historySpan("EUR", at("2026-10-25T00:00:00.000Z"), at("2026-10-26T00:00:00.000Z"));
    expect(carried.map((row) => row.at.toISOString())).toEqual(["2026-10-20T00:00:00.000Z"]);
  });

  it("суточное окно заданных курсов", async () => {
    await payout("0.013", "USD", "2026-10-28T09:00:00.000Z", "2026-11-27T09:00:00.000Z");
    await payout("0.014", "USD", "2026-11-01T12:00:00.000Z", "2026-12-01T09:00:00.000Z");
    const rows = await store.manualSpan("XTR", "payout", at("2026-11-01T00:00:00.000Z"), at("2026-11-02T00:00:00.000Z"));
    expect(rows.map((row) => row.price.toFixed())).toEqual(["0.013", "0.014"]);
  });

  it("курс на дату: рубль и звезда в рублях — из базы, пакет совпадает с одиночным запросом", async () => {
    await history("RUB", "2026-10-31T00:00:00.000Z", "0.0125000000000000000000000000000000000001");
    await history("RUB", "2026-11-02T00:00:00.000Z", "0.02");
    await payout("1.72", "RUB", "2026-10-28T00:00:00.000Z", "2026-11-27T00:00:00.000Z");
    const when = at("2026-11-01T12:00:00.000Z");
    const single = await rateAt(store, "XTR", when);
    expect(single).toMatchObject({ stale: false, source: "manual" });
    expect(single?.usdPerUnit.equals(decimal("1.72").mul(decimal("0.0125000000000000000000000000000000000001")))).toBe(true);
    const [batch, missing] = await ratesAt(store, [
      { currency: "XTR", at: when },
      { currency: "RUB", at: at("2026-01-02T00:00:00.000Z") },
    ]);
    expect(batch?.usdPerUnit.equals(single?.usdPerUnit ?? decimal(0))).toBe(true);
    expect(missing).toBeNull();
  });
});
