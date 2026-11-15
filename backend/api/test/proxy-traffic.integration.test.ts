import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaTrafficRepository } from "../src/modules/proxies/subscription/traffic/traffic.repository.js";
import type { TrafficRow } from "../src/modules/proxies/subscription/traffic/traffic.repository.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Часовые корзины трафика Xray на живом Postgres (docs/35-stage4-plan.md Р192,
 * tasks/T-0386): запись прибавлением без потерь при нескольких репликах,
 * сумма окна с последним названием узла, удаление только старого, CHECK
 * миграции. Без базы — пропуск.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const HOUR = new Date("2026-11-07T14:00:00.000Z");
const KEY1 = "0123456789abcdef";
const KEY2 = "fedcba9876543210";

const hoursFrom = (count: number): Date => new Date(HOUR.getTime() + count * 3_600_000);
const row = (patch: Partial<TrafficRow> = {}): TrafficRow => ({ hour: HOUR, subscriptionKey: "main", nodeKey: KEY1, nodeName: "Берлин", upBytes: 100n, downBytes: 1_000n, ...patch });

describe.skipIf(DATABASE_URL === "")("часовые корзины трафика Xray на живом Postgres", () => {
  let prisma: PrismaClient;
  let repository: PrismaTrafficRepository;

  const stored = () => prisma.proxyTrafficHour.findMany({ orderBy: [{ hour: "asc" }, { subscriptionKey: "asc" }, { nodeKey: "asc" }] });

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 5);
    repository = new PrismaTrafficRepository(prisma);
    await prisma.proxyTrafficHour.deleteMany();
  });

  afterEach(async () => {
    await prisma.proxyTrafficHour.deleteMany();
  });

  afterAll(async () => {
    await prisma.proxyTrafficHour.deleteMany();
    await prisma.$disconnect();
  });

  it("add: новая строка пишется как есть", async () => {
    await repository.add([row()]);
    expect(await stored()).toEqual([{ hour: HOUR, subscriptionKey: "main", nodeKey: KEY1, nodeName: "Берлин", upBytes: 100n, downBytes: 1_000n }]);
  });

  it("add дважды по одному ключу — сумма; название берётся последнее", async () => {
    await repository.add([row()]);
    await repository.add([row({ upBytes: 50n, downBytes: 5n, nodeName: "Берлин-2" })]);

    expect(await stored()).toEqual([{ hour: HOUR, subscriptionKey: "main", nodeKey: KEY1, nodeName: "Берлин-2", upBytes: 150n, downBytes: 1_005n }]);
  });

  it("две параллельные add одного ключа — сумма без потерь", async () => {
    await Promise.all(Array.from({ length: 12 }, () => repository.add([row({ upBytes: 1n, downBytes: 2n })])));

    const [only] = await stored();
    expect(only?.upBytes).toBe(12n);
    expect(only?.downBytes).toBe(24n);
  });

  it("add: один ключ повторён внутри одного вызова — строки складываются, а не падают на «второй раз тот же ряд»", async () => {
    await repository.add([row({ upBytes: 1n, downBytes: 1n }), row({ upBytes: 2n, downBytes: 3n }), row({ nodeKey: KEY2 })]);

    const rows = await stored();
    expect(rows.map((item) => [item.nodeKey, item.upBytes, item.downBytes])).toEqual([
      [KEY1, 3n, 4n],
      [KEY2, 100n, 1_000n],
    ]);
  });

  it("add: разные часы, подписки и узлы — разные строки; пустой список ничего не делает", async () => {
    await repository.add([]);
    expect(await stored()).toEqual([]);

    await repository.add([row(), row({ hour: hoursFrom(1) }), row({ subscriptionKey: "b2b2b2b2b2b2" }), row({ nodeKey: KEY2 })]);
    expect(await stored()).toHaveLength(4);
  });

  it("байты больше 2^53 хранятся без потерь", async () => {
    const big = 9_007_199_254_740_993n;
    await repository.add([row({ upBytes: big, downBytes: 2n ** 62n })]);
    const [only] = await stored();
    expect(only?.upBytes).toBe(big);
    expect(only?.downBytes).toBe(2n ** 62n);
  });

  it("report: сумма по подписке и узлу за окно, последнее название; часы до окна не входят", async () => {
    await repository.add([
      row({ hour: hoursFrom(-3), nodeName: "Старое", upBytes: 1n, downBytes: 1n }),
      row({ hour: hoursFrom(-2), nodeName: "Среднее", upBytes: 10n, downBytes: 10n }),
      row({ hour: HOUR, nodeName: "Новое", upBytes: 100n, downBytes: 100n }),
      row({ nodeKey: KEY2, nodeName: "Другой", upBytes: 5n, downBytes: 6n }),
      row({ subscriptionKey: "b2b2b2b2b2b2", nodeName: "Берлин", upBytes: 7n, downBytes: 8n }),
    ]);

    const report = await repository.report(hoursFrom(-2));
    const byKey = new Map(report.map((total) => [`${total.subscriptionKey}/${total.nodeKey}`, total]));

    expect(report).toHaveLength(3);
    expect(byKey.get(`main/${KEY1}`)).toEqual({ subscriptionKey: "main", nodeKey: KEY1, nodeName: "Новое", upBytes: 110n, downBytes: 110n });
    expect(byKey.get(`main/${KEY2}`)).toMatchObject({ nodeName: "Другой", upBytes: 5n, downBytes: 6n });
    expect(byKey.get(`b2b2b2b2b2b2/${KEY1}`)).toMatchObject({ upBytes: 7n, downBytes: 8n });
  });

  it("deleteBefore удаляет только старое и говорит, сколько", async () => {
    await repository.add([row({ hour: hoursFrom(-48) }), row({ hour: hoursFrom(-1) }), row({ hour: HOUR })]);

    const removed = await repository.deleteBefore(hoursFrom(-1));

    expect(removed).toBe(1);
    expect((await stored()).map((item) => item.hour.toISOString())).toEqual([hoursFrom(-1).toISOString(), HOUR.toISOString()]);
  });

  it("CHECK: час не на границе часа — отказ базы, ничего не записано", async () => {
    await expect(repository.add([row({ hour: new Date("2026-11-07T14:30:00.000Z") })])).rejects.toThrow();
    await expect(repository.add([row({ hour: new Date("2026-11-07T14:00:01.000Z") })])).rejects.toThrow();
    expect(await stored()).toEqual([]);
  });

  it("CHECK: отрицательные байты — отказ базы; ноль допустим", async () => {
    await expect(repository.add([row({ upBytes: -1n })])).rejects.toThrow();
    await expect(repository.add([row({ downBytes: -1n })])).rejects.toThrow();
    expect(await stored()).toEqual([]);

    await repository.add([row({ upBytes: 0n, downBytes: 0n })]);
    expect(await stored()).toHaveLength(1);
  });

  it("CHECK: прямая запись мимо репозитория тоже не пропускает нарушение", async () => {
    await expect(prisma.proxyTrafficHour.create({ data: { hour: new Date("2026-11-07T14:15:00.000Z"), subscriptionKey: "main", nodeKey: KEY1, nodeName: "Берлин", upBytes: 1n, downBytes: 1n } })).rejects.toThrow();
    await expect(prisma.proxyTrafficHour.create({ data: { hour: HOUR, subscriptionKey: "main", nodeKey: KEY1, nodeName: "Берлин", upBytes: -1n, downBytes: 1n } })).rejects.toThrow();
  });

  it("нарушение внутри пачки откатывает всю пачку", async () => {
    await expect(repository.add([row(), row({ nodeKey: KEY2, upBytes: -5n })])).rejects.toThrow();
    expect(await stored()).toEqual([]);
  });
});
