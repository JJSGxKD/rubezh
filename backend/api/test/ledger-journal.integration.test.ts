import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaLedgerRepository } from "../src/modules/ledger/ledger.repository.js";
import { LedgerService } from "../src/modules/ledger/ledger.service.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Журнал учёта на живом Postgres (docs/17-testing-strategy.md §4.2; адрес — TEST_DATABASE_URL, без него
 * пропуск; Р219, tasks/T-0457): начальный план счетов после миграции, ключ источника уникален и под гонкой,
 * журнал не правится ни кодом, ни прямым запросом, остатки, страницы по курсору и суммы за пределом 2^53.
 *
 * Журнал не стирается — триггер этого не позволит, — поэтому тест ничего не убирает: каждый прогон берёт
 * свой префикс ключей и свои счета (`it.<прогон>.…`) и проверяет только их. Реальные счета плана тронуты
 * одной проверкой остатков — по разнице до и после.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

/** Начальный план счетов — таблица решения Р219: id, тип, валюта, название. */
const INITIAL_PLAN = [
  ["stars.bot.hold", "asset", "XTR", "Звёзды бота — в холде"],
  ["stars.bot.available", "asset", "XTR", "Звёзды бота — доступно"],
  ["wallet.ton", "asset", "GRAM", "Кошелёк TON"],
  ["exchange.usdt", "asset", "USDT", "Биржа или USDT"],
  ["bank.rub", "asset", "RUB", "Банк, ₽"],
  ["revenue.shop.telegram", "revenue", "XTR", "Выручка: магазин, Telegram"],
  ["revenue.continue.telegram", "revenue", "XTR", "Выручка: второй шанс, Telegram"],
  ["revenue.vip.telegram", "revenue", "XTR", "Выручка: VIP, Telegram"],
  ["revenue.donation.telegram", "revenue", "XTR", "Донаты, Telegram"],
] as const;

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("ожидалась доменная ошибка, а вызов прошёл");
}

describe.skipIf(DATABASE_URL === "")("журнал учёта на живом Postgres", () => {
  let prisma: PrismaClient;
  let service: LedgerService;
  /** Префикс прогона: ключи и счета этого запуска не пересекаются ни с прошлыми запусками, ни с соседними файлами. */
  const run = randomUUID().slice(0, 8);
  const key = (name: string) => `it:${run}:${name}`;
  const account = (name: string) => `it.${run}.${name}`;
  const AT = new Date("2026-11-13T12:00:00Z");

  /** Проводка между двумя тестовыми счетами: первый дебетуется, второй кредитуется. */
  const pair = (sourceKey: string, debit: string, credit: string, amount: bigint, at: Date = AT) => ({
    sourceKey,
    at,
    memo: "проверка журнала",
    lines: [
      { accountId: debit, amount },
      { accountId: credit, amount: -amount },
    ],
  });

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 12);
    service = new LedgerService(new PrismaLedgerRepository(prisma));
    await prisma.ledgerAccount.createMany({
      data: [
        { accountId: account("hold"), type: "asset", currency: "XTR", name: "Тест: холд" },
        { accountId: account("revenue"), type: "revenue", currency: "XTR", name: "Тест: выручка" },
        { accountId: account("cursor.a"), type: "asset", currency: "XTR", name: "Тест: страницы, дебет" },
        { accountId: account("cursor.b"), type: "revenue", currency: "XTR", name: "Тест: страницы, кредит" },
        { accountId: account("gram.a"), type: "asset", currency: "GRAM", name: "Тест: Gram, дебет" },
        { accountId: account("gram.b"), type: "revenue", currency: "GRAM", name: "Тест: Gram, кредит" },
      ],
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("начальный план счетов на месте после миграции: девять счетов из решения Р219", async () => {
    const rows = await prisma.ledgerAccount.findMany({ where: { accountId: { in: INITIAL_PLAN.map(([id]) => id) } } });

    expect(rows).toHaveLength(INITIAL_PLAN.length);
    for (const [accountId, type, currency, name] of INITIAL_PLAN) {
      expect(rows.find((row) => row.accountId === accountId), accountId).toMatchObject({ type, currency, name, archivedAt: null });
    }
  });

  it("проводка пишется одной транзакцией: запись и обе строки, период по UTC, автор — null или аккаунт", async () => {
    const actor = randomUUID();

    const result = await service.post(pair(key("one"), account("hold"), account("revenue"), 50n, new Date("2026-10-31T23:59:59Z")), { accountId: actor });

    expect(result.created).toBe(true);
    const stored = await prisma.ledgerEntry.findUnique({ where: { entryId: result.entryId }, include: { lines: true } });
    expect(stored).toMatchObject({ sourceKey: key("one"), period: "2026-10", createdBy: actor, reversalOf: null, memo: "проверка журнала" });
    expect(stored?.lines.map((line) => [line.accountId, line.amount]).sort()).toEqual([
      [account("hold"), 50n],
      [account("revenue"), -50n],
    ]);
  });

  it("две и больше параллельных вставок одного ключа — одна проводка, остальные created: false", async () => {
    const draft = pair(key("race"), account("hold"), account("revenue"), 70n);

    const results = await Promise.all(Array.from({ length: 6 }, () => service.post(draft)));

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.entryId)).size).toBe(1);
    expect(await prisma.ledgerEntry.count({ where: { sourceKey: key("race") } })).toBe(1);
    expect(await prisma.ledgerLine.count({ where: { entry: { sourceKey: key("race") } } })).toBe(2);
  });

  it("параллельные вставки одного ключа с разными строками — одна проходит, другая получает 409", async () => {
    const outcomes = await Promise.allSettled([service.post(pair(key("race-conflict"), account("hold"), account("revenue"), 10n)), service.post(pair(key("race-conflict"), account("hold"), account("revenue"), 20n))]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ code: "ledger_source_conflict", status: 409 });
    expect(await prisma.ledgerEntry.count({ where: { sourceKey: key("race-conflict") } })).toBe(1);
  });

  it("повтор с теми же строками — тот же ответ; с другими — 409, в базе прежние строки", async () => {
    const first = await service.post(pair(key("repeat"), account("hold"), account("revenue"), 50n));

    const same = await service.post(pair(key("repeat"), account("hold"), account("revenue"), 50n));
    const conflict = await domainError(service.post(pair(key("repeat"), account("hold"), account("revenue"), 60n)));

    expect(same).toEqual({ entryId: first.entryId, created: false });
    expect(conflict).toMatchObject({ code: "ledger_source_conflict", status: 409 });
    expect((await prisma.ledgerLine.findMany({ where: { entryId: first.entryId } })).map((line) => line.amount).sort()).toEqual([-50n, 50n]);
  });

  it("журнал не правится: UPDATE и DELETE проводки и строки — ошибка базы, и кодом, и прямым запросом", async () => {
    const { entryId } = await service.post(pair(key("immutable"), account("hold"), account("revenue"), 50n));
    const line = await prisma.ledgerLine.findFirstOrThrow({ where: { entryId } });
    const message = /Журнал учёта не правится/;

    await expect(prisma.$executeRaw`UPDATE ledger_entry SET memo = 'правка' WHERE entry_id = ${entryId}::uuid`).rejects.toThrow(message);
    await expect(prisma.$executeRaw`DELETE FROM ledger_entry WHERE entry_id = ${entryId}::uuid`).rejects.toThrow(message);
    await expect(prisma.$executeRaw`UPDATE ledger_line SET amount = 1 WHERE line_id = ${line.lineId}::uuid`).rejects.toThrow(message);
    await expect(prisma.$executeRaw`DELETE FROM ledger_line WHERE line_id = ${line.lineId}::uuid`).rejects.toThrow(message);
    await expect(prisma.ledgerEntry.update({ where: { entryId }, data: { memo: "правка" } })).rejects.toThrow(message);
    await expect(prisma.ledgerLine.update({ where: { lineId: line.lineId }, data: { amount: 99n } })).rejects.toThrow(message);
    await expect(prisma.ledgerLine.deleteMany({ where: { entryId } })).rejects.toThrow(message);
    await expect(prisma.ledgerEntry.deleteMany({ where: { entryId } })).rejects.toThrow(message);
    // обход через TRUNCATE тоже закрыт
    await expect(prisma.$executeRaw`TRUNCATE ledger_line, ledger_entry`).rejects.toThrow(message);

    const after = await prisma.ledgerEntry.findUniqueOrThrow({ where: { entryId }, include: { lines: true } });
    expect(after.memo).toBe("проверка журнала");
    expect(after.lines.map((row) => row.amount).sort()).toEqual([-50n, 50n]);
  });

  it("нулевая строка не принимается базой, а проводка откатывается целиком", async () => {
    const sourceKey = key("zero");

    await expect(
      prisma.ledgerEntry.create({
        data: {
          entryId: randomUUID(),
          sourceKey,
          at: AT,
          period: "2026-11",
          memo: "ноль",
          lines: {
            create: [
              { lineId: randomUUID(), accountId: account("hold"), amount: 0n },
              { lineId: randomUUID(), accountId: account("revenue"), amount: 0n },
            ],
          },
        },
      }),
    ).rejects.toThrow(/ledger_line_amount_check/);

    expect(await prisma.ledgerEntry.count({ where: { sourceKey } })).toBe(0);
  });

  it("строка по несуществующему счёту не принимается внешним ключом", async () => {
    await expect(
      prisma.ledgerEntry.create({
        data: {
          entryId: randomUUID(),
          sourceKey: key("ghost"),
          at: AT,
          period: "2026-11",
          memo: "нет счёта",
          lines: {
            create: [
              { lineId: randomUUID(), accountId: account("hold"), amount: 5n },
              { lineId: randomUUID(), accountId: account("ghost"), amount: -5n },
            ],
          },
        },
      }),
    ).rejects.toThrow();
    expect(await prisma.ledgerEntry.count({ where: { sourceKey: key("ghost") } })).toBe(0);
  });

  it("остатки после оплаты и сторно: звёзды в холде и выручка растут на 50, после сторно — возвращаются", async () => {
    const stars = async () => {
      const rows = await service.balances();
      return { hold: BigInt(rows.find((row) => row.accountId === "stars.bot.hold")?.balance ?? "x"), revenue: BigInt(rows.find((row) => row.accountId === "revenue.shop.telegram")?.balance ?? "x") };
    };
    const draft = (sourceKey: string) => pair(sourceKey, "stars.bot.hold", "revenue.shop.telegram", 50n);
    const before = await stars();

    await service.post(draft(key("paid")));
    const paid = await stars();
    await service.reverse(key("paid"), key("refunded"), AT, "Возврат звёзд");
    const refunded = await stars();

    expect(paid.hold - before.hold).toBe(50n);
    expect(paid.revenue - before.revenue).toBe(50n);
    expect(refunded).toEqual(before);
    const reversal = await prisma.ledgerEntry.findUniqueOrThrow({ where: { sourceKey: key("refunded") }, include: { lines: true, original: true } });
    expect(reversal.original?.sourceKey).toBe(key("paid"));
    expect(reversal.lines.map((line) => [line.accountId, line.amount]).sort()).toEqual([
      ["revenue.shop.telegram", 50n],
      ["stars.bot.hold", -50n],
    ]);
  });

  it("второе сторно той же проводки, в том числе параллельное, — 409 ledger_already_reversed: в базе уникален reversal_of", async () => {
    await service.post(pair(key("twice"), account("hold"), account("revenue"), 30n));

    const outcomes = await Promise.allSettled([service.reverse(key("twice"), key("twice-r1"), AT, "Возврат"), service.reverse(key("twice"), key("twice-r2"), AT, "Возврат ещё раз")]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ code: "ledger_already_reversed", status: 409 });
    const original = await prisma.ledgerEntry.findUniqueOrThrow({ where: { sourceKey: key("twice") } });
    expect(await prisma.ledgerEntry.count({ where: { reversalOf: original.entryId } })).toBe(1);
  });

  it("сумма больше 2^53 в нано-Gram хранится, читается и показывается без потерь", async () => {
    const nano = 9_007_199_254_740_993n;
    const { entryId } = await service.post(pair(key("gram"), account("gram.a"), account("gram.b"), nano));

    const lines = await prisma.ledgerLine.findMany({ where: { entryId } });
    const balances = await service.balances();
    const journal = await service.journal({ accountId: account("gram.a") }, null);

    expect(lines.map((line) => line.amount).sort()).toEqual([-nano, nano]);
    expect(balances.find((row) => row.accountId === account("gram.a"))?.balance).toBe("9007199.254740993");
    expect(balances.find((row) => row.accountId === account("gram.b"))?.balance).toBe("9007199.254740993");
    expect(journal.entries[0]?.lines.map((line) => line.amount).sort()).toEqual(["-9007199.254740993", "9007199.254740993"]);
  });

  describe("страницы журнала на 120 проводках", () => {
    /** Шаг 18 часов и по две проводки на момент: тест ловит и ничью по времени, и смену месяца. */
    const START = Date.UTC(2026, 7, 20, 6);
    const expected: { sourceKey: string; at: Date; period: string; entryId: string }[] = [];

    beforeAll(async () => {
      for (let index = 0; index < 120; index += 1) {
        const at = new Date(START + Math.floor(index / 2) * 18 * 3_600_000);
        const sourceKey = key(`page:${String(index)}`);
        const { entryId } = await service.post(pair(sourceKey, account("cursor.a"), account("cursor.b"), BigInt(index + 1), at));
        expected.push({ sourceKey, at, period: at.toISOString().slice(0, 7), entryId });
      }
    });

    const newestFirst = (list: typeof expected) => [...list].sort((a, b) => b.at.getTime() - a.at.getTime() || (a.entryId < b.entryId ? 1 : -1));

    async function readAll(filter: Parameters<LedgerService["journal"]>[0], limit: number): Promise<string[]> {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 200; page += 1) {
        const result = await service.journal(filter, cursor, limit);
        seen.push(...result.entries.map((entry) => entry.entryId));
        cursor = result.next;
        if (cursor === null) return seen;
      }
      throw new Error("курсор не закончился");
    }

    it("по счёту: все 120, новые сверху, без пропусков и повторов; страницы по 25 и по 7", async () => {
      for (const limit of [25, 7]) {
        const ids = await readAll({ accountId: account("cursor.a") }, limit);
        expect(ids, `limit ${String(limit)}`).toHaveLength(120);
        expect(new Set(ids).size).toBe(120);
        expect(ids).toEqual(newestFirst(expected).map((entry) => entry.entryId));
      }
    });

    it("страница ровно по числу проводок не даёт пустой следующей", async () => {
      const page = await service.journal({ accountId: account("cursor.a") }, null, 100);
      expect(page.entries).toHaveLength(100);
      expect(page.next).not.toBeNull();
      const rest = await service.journal({ accountId: account("cursor.a") }, page.next, 100);
      expect(rest.entries).toHaveLength(20);
      expect(rest.next).toBeNull();
    });

    it("по счёту и периоду: только сентябрь; верхняя и нижняя границы включаются", async () => {
      const september = expected.filter((entry) => entry.period === "2026-09");
      const august = expected.filter((entry) => entry.period === "2026-08");
      expect(september.length).toBeGreaterThan(0);
      expect(august.length).toBeGreaterThan(0);

      expect(await readAll({ accountId: account("cursor.a"), from: "2026-09", to: "2026-09" }, 10)).toEqual(newestFirst(september).map((entry) => entry.entryId));
      expect(await readAll({ accountId: account("cursor.a"), to: "2026-08" }, 10)).toEqual(newestFirst(august).map((entry) => entry.entryId));
      expect(await readAll({ accountId: account("cursor.a"), from: "2026-08", to: "2026-09" }, 10)).toEqual(newestFirst([...august, ...september]).map((entry) => entry.entryId));
    });

    it("по валюте и по ключу источника с префиксом: «_» и «%» в префиксе — не шаблон", async () => {
      expect(await readAll({ accountId: account("cursor.b"), currency: "GRAM" }, 50)).toEqual([]);
      const tens = expected.filter((entry) => entry.sourceKey.startsWith(key("page:1")));
      expect(await readAll({ accountId: account("cursor.a"), sourcePrefix: key("page:1") }, 6)).toEqual(newestFirst(tens).map((entry) => entry.entryId));

      await service.post(pair(key("wild_1"), account("hold"), account("revenue"), 1n));
      await service.post(pair(key("wildx1"), account("hold"), account("revenue"), 1n));
      expect((await service.journal({ sourcePrefix: key("wild_") }, null)).entries.map((entry) => entry.sourceKey)).toEqual([key("wild_1")]);
      expect((await service.journal({ sourcePrefix: key("wild%") }, null)).entries).toEqual([]);
    });

    it("у проводок в ответе строки со знаком и подписью счёта", async () => {
      const [top] = (await service.journal({ accountId: account("cursor.a") }, null, 1)).entries;
      expect(top?.lines).toEqual([
        { accountId: account("cursor.a"), accountName: "Тест: страницы, дебет", currency: "XTR", amount: expect.stringMatching(/^\d+$/) },
        { accountId: account("cursor.b"), accountName: "Тест: страницы, кредит", currency: "XTR", amount: expect.stringMatching(/^-\d+$/) },
      ]);
    });
  });
});
