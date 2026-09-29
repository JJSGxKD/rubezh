import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaNotificationsRepository } from "../src/modules/notifications/notifications.repository.js";
import { NotificationsService } from "../src/modules/notifications/notifications.service.js";

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
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 10, connectionTimeoutMillis: 30_000 }) });
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
