import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { promoProblem, type PromoInput } from "../src/modules/shop/shop-promo-rules.js";
import { PrismaShopPromoRepository } from "../src/modules/shop/shop-promo.repository.js";

/**
 * Акции магазина на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск): две вкладки панели не заведут
 * пересекающиеся акции разом, снятая уходит из витрины, а база сама не
 * примет скидку вне пределов и акцию, кончившуюся до начала.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(Date.UTC(2026, 9, 1, 9));

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

describe.skipIf(DATABASE_URL === "")("акции магазина на живом Postgres", () => {
  let prisma: PrismaClient;
  let promos: PrismaShopPromoRepository;

  // Свой товар на каждый тест: база товар не сверяет с каталогом, а чужие акции не мешают.
  const sku = () => `t_${randomUUID().slice(0, 8)}`;
  const input = (patch: Partial<PromoInput> = {}): PromoInput & { promoId: string; createdBy: string } => ({
    sku: "gems_60",
    percent: 20,
    startsAt: at(0),
    endsAt: at(3 * DAY),
    title: null,
    promoId: randomUUID(),
    createdBy: randomUUID(),
    ...patch,
  });

  beforeAll(() => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 10, connectionTimeoutMillis: 30_000 }) });
    promos = new PrismaShopPromoRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("пять одновременных заявок на один товар — заведена одна, остальным мешает она", async () => {
    const id = sku();
    const results = await Promise.all(Array.from({ length: 5 }, () => promos.create(input({ sku: id }), NOW, (nearby) => promoProblem(input(), nearby, NOW))));
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(results.filter((result) => result?.code === "promo_overlap")).toHaveLength(4);
    expect((await promos.list(500)).filter((row) => row.sku === id)).toHaveLength(1);
  });

  it("идущие и начинающиеся в окне — в выборке; снятая — нет, и снять второй раз нечего", async () => {
    const id = sku();
    const promo = input({ sku: id, title: "Неделя самоцветов" });
    expect(await promos.create(promo, NOW, () => null)).toBeNull();
    const soon = input({ sku: sku(), startsAt: at(10_000), endsAt: at(DAY) });
    expect(await promos.create(soon, NOW, () => null)).toBeNull();

    const current = await promos.current(NOW, at(30_000));
    expect(current.find((row) => row.sku === id)).toMatchObject({ promoId: promo.promoId, percent: 20, title: "Неделя самоцветов", cancelledAt: null });
    expect(current.some((row) => row.sku === soon.sku)).toBe(true);
    expect((await promos.current(NOW, at(5_000))).some((row) => row.sku === soon.sku)).toBe(false);

    const actor = randomUUID();
    expect(await promos.cancel(promo.promoId, actor, at(HOUR))).toMatchObject({ cancelledAt: at(HOUR), cancelledBy: actor });
    expect(await promos.cancel(promo.promoId, actor, at(2 * HOUR))).toBeNull();
    expect((await promos.current(at(2 * HOUR), at(2 * HOUR + 30_000))).some((row) => row.sku === id)).toBe(false);
    // Кончившуюся снять нельзя: в истории она шла до конца.
    expect(await promos.cancel(soon.promoId, actor, at(2 * DAY))).toBeNull();
  });

  it("выборка соседей — с запасом на отдых: акция за 14 дней до начала новой в неё попадает", async () => {
    const id = sku();
    await promos.create(input({ sku: id, startsAt: at(-5 * DAY), endsAt: at(-3 * DAY) }), at(-5 * DAY), () => null);
    let seen = 0;
    await promos.create(input({ sku: id, startsAt: at(0), endsAt: at(DAY) }), NOW, (nearby) => {
      seen = nearby.length;
      return promoProblem(input(), nearby, NOW);
    });
    expect(seen).toBe(1);
  });

  it("база не примет скидку вне пределов, конец раньше начала и снятие без того, кто снял", async () => {
    const id = sku();
    for (const percent of [0, 4, 81, 100]) {
      await expect(promos.create(input({ sku: id, percent }), NOW, () => null), String(percent)).rejects.toThrow();
    }
    await expect(promos.create(input({ sku: id, startsAt: at(DAY), endsAt: at(0) }), NOW, () => null)).rejects.toThrow();
    const promo = input({ sku: id });
    await promos.create(promo, NOW, () => null);
    await expect(prisma.$executeRaw`UPDATE shop_promo SET cancelled_at = now() WHERE promo_id = ${promo.promoId}::uuid`).rejects.toThrow();
  });
});
