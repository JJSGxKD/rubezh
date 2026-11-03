import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaNotificationsRepository } from "../src/modules/notifications/notifications.repository.js";
import { NotificationsService } from "../src/modules/notifications/notifications.service.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Лента уведомлений на живом Postgres (docs/17-testing-strategy.md §4.2;
 * адрес — TEST_DATABASE_URL, без него пропуск): уникальный ключ события,
 * порядок и курсор со строками одного мгновения, прочитанное, чистка.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

describe.skipIf(DATABASE_URL === "")("уведомления на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let repository: PrismaNotificationsRepository;
  let service: NotificationsService;

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(770_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Лента", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  const gift = (to: string, key: string, at: Date) =>
    service.notify({ accountId: to, kind: "friend_gift", payload: { fromAccountId: to, fromName: "Дым" }, dedupeKey: key, at });

  beforeAll(() => {
    prisma = testPrisma(DATABASE_URL, 10);
    accounts = new PrismaAccountRepository(prisma);
    repository = new PrismaNotificationsRepository(prisma);
    service = new NotificationsService(repository);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("одно событие — одна строка даже под гонкой", async () => {
    const me = await account();
    const at = new Date();
    const results = await Promise.all(Array.from({ length: 8 }, () => gift(me, "friend_gift:x:2026-09-30", at)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await prisma.notification.count({ where: { accountId: me } })).toBe(1);
  });

  it("исход дубля в бота пишется один раз, чужую строку не трогает", async () => {
    const me = await account();
    let created = "";
    service.onCreated("integration", async (row) => {
      created = row.notificationId;
    });
    await gift(me, "bot:1", new Date());

    await service.markBot(created, "blocked", new Date(Date.UTC(2026, 8, 30, 9)));
    await service.markBot(created, "sent", new Date(Date.UTC(2026, 8, 30, 10)));
    const row = await prisma.notification.findUniqueOrThrow({ where: { notificationId: created } });
    expect(row.botOutcome).toBe("blocked");
    expect(row.botAt?.toISOString()).toBe("2026-09-30T09:00:00.000Z");
  });

  it("пачка: один запрос, без дублей под гонкой, пропускает несуществующий аккаунт", async () => {
    const ids = [await account(), await account(), await account()];
    const ghost = "00000000-0000-4000-8000-00000000dead";
    const heard: string[] = [];
    service.onCreated("integration", async (row) => {
      heard.push(row.accountId);
    });
    const batch = (accountIds: string[]) => service.deliverMany({ accountIds, kind: "team_message", payload: { text: "Вышла 0.6.0" }, dedupeKey: "release:0.6.0" });

    const written = await Promise.all([batch([...ids, ghost]), batch([ids[0] ?? "", ids[2] ?? ""]), batch(ids)]);
    expect(written.reduce((sum, count) => sum + count, 0)).toBe(3);
    expect(heard.sort()).toEqual([...ids].sort());
    for (const id of ids) expect(await prisma.notification.count({ where: { accountId: id, dedupeKey: "release:0.6.0" } })).toBe(1);
    expect(await prisma.notification.count({ where: { accountId: ghost } })).toBe(0);
  });

  it("строки одного мгновения на границе страницы не теряются и не повторяются", async () => {
    const me = await account();
    const same = new Date(Date.UTC(2026, 8, 29, 12));
    for (let index = 0; index < 5; index++) await gift(me, `same:${String(index)}`, same);
    await gift(me, "newer", new Date(same.getTime() + 1_000));

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.feed(me, cursor, 2);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it("прочитанное — до увиденного, счёт непрочитанного — свой", async () => {
    const me = await account();
    const other = await account();
    await gift(me, "a", new Date(Date.UTC(2026, 8, 29, 10)));
    await gift(me, "b", new Date(Date.UTC(2026, 8, 29, 11)));
    await gift(other, "c", new Date(Date.UTC(2026, 8, 29, 11)));
    const [newest, oldest] = (await service.feed(me, undefined, 10)).items;
    expect(await service.read(me, oldest?.id)).toEqual({ unread: 1 });
    expect(newest?.read).toBe(false);
    expect(await service.read(me, undefined)).toEqual({ unread: 0 });
    expect(await service.unread(other)).toBe(1);
  });

  describe("прочитанное действием", () => {
    const request = (to: string, from: string, key: string) =>
      service.notify({ accountId: to, kind: "friend_request", payload: { fromAccountId: from, fromName: "Дым" }, dedupeKey: key });
    const readAtOf = async (accountId: string, from: string, kind: string) =>
      (await prisma.notification.findMany({ where: { accountId, kind }, select: { readAt: true, payload: true } })).find((row) => (row.payload as { fromAccountId: string }).fromAccountId === from)?.readAt;

    it("с совпадением гасит только названных, число — сколько погашено", async () => {
      const me = await account();
      const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
      for (const from of [a, b, c]) await request(me, from, `req:${from}`);

      expect(await repository.markReadOf(me, "friend_request", { key: "fromAccountId", values: [b] }, new Date())).toBe(1);

      expect(await service.unread(me)).toBe(2);
      expect(await readAtOf(me, a, "friend_request")).toBeNull();
      expect(await readAtOf(me, b, "friend_request")).not.toBeNull();
      expect(await readAtOf(me, c, "friend_request")).toBeNull();
    });

    it("без совпадения гасит весь вид, другой вид остаётся", async () => {
      const me = await account();
      await request(me, randomUUID(), "req:1");
      await request(me, randomUUID(), "req:2");
      await gift(me, "gift:1", new Date());

      expect(await repository.markReadOf(me, "friend_request", undefined, new Date())).toBe(2);

      expect(await service.unread(me)).toBe(1);
    });

    it("прочитанное повторно не трогается", async () => {
      const me = await account();
      const from = randomUUID();
      await request(me, from, "req:1");
      const first = new Date(Date.UTC(2026, 9, 24, 10));
      expect(await repository.markReadOf(me, "friend_request", undefined, first)).toBe(1);

      expect(await repository.markReadOf(me, "friend_request", undefined, new Date())).toBe(0);
      expect((await readAtOf(me, from, "friend_request"))?.toISOString()).toBe(first.toISOString());
    });

    it("чужой аккаунт не задет, пустой список — ноль", async () => {
      const me = await account();
      const other = await account();
      const from = randomUUID();
      await request(me, from, "req:1");
      await request(other, from, "req:1");

      expect(await repository.markReadOf(me, "friend_request", { key: "fromAccountId", values: [] }, new Date())).toBe(0);
      expect(await repository.markReadOf(me, "friend_request", { key: "fromAccountId", values: [from] }, new Date())).toBe(1);

      expect(await service.unread(other)).toBe(1);
    });

    it("сервис: readFor гасит, а при сбое базы не бросает", async () => {
      const me = await account();
      await request(me, randomUUID(), "req:1");
      await service.readFor(me, "friend_request");
      expect(await service.unread(me)).toBe(0);

      const broken = new NotificationsService({
        markReadOf: async () => {
          throw new Error("сбой");
        },
      } as unknown as PrismaNotificationsRepository);
      await expect(broken.readFor(me, "friend_request")).resolves.toBeUndefined();
    });
  });

  it("чистка — только старше границы и не больше пачки", async () => {
    const me = await account();
    const before = new Date(Date.UTC(2020, 0, 1));
    for (let index = 0; index < 3; index++) await gift(me, `ancient:${String(index)}`, new Date(before.getTime() - 1_000 * (index + 1)));
    await gift(me, "recent", new Date());
    // Чужие древние строки на общей базе тоже могут попасть под чистку — считаем свои.
    while ((await repository.purge(before, 2)) > 0);
    expect((await prisma.notification.findMany({ where: { accountId: me }, select: { dedupeKey: true } })).map((row) => row.dedupeKey)).toEqual(["recent"]);
  });
});
