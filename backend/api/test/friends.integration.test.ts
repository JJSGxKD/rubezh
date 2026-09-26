import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { orderedPair, PrismaFriendsRepository } from "../src/modules/friends/friends.repository.js";

/**
 * Дружба на живом Postgres (docs/35-stage4-plan.md, WP14): миграция с
 * проверками пары, потолок под блокировкой строк, заявки, ссылка. Без
 * TEST_DATABASE_URL — пропуск: локально базы нет, тест гоняет CI.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

describe.skipIf(DATABASE_URL === "")("дружба на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let friends: PrismaFriendsRepository;
  const marker = `fr${Date.now().toString(36)}`;

  async function account(): Promise<string> {
    const platformUserId = String(930_000_000 + Math.floor(Math.random() * 60_000_000));
    const created = await accounts.upsert({ platform: "telegram", platformUserId, displayName: `Друг ${marker}`, username: null, photoUrl: null }, Date.now());
    return created.accountId;
  }

  beforeAll(() => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
    accounts = new PrismaAccountRepository(prisma);
    friends = new PrismaFriendsRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("ссылка одна и постоянная, код ведёт к владельцу", async () => {
    const owner = await account();
    const [first, again] = await Promise.all([friends.linkOf(owner), friends.linkOf(owner)]);
    expect(again).toBe(first);
    expect(await friends.ownerOf(first)).toBe(owner);
    expect(await friends.ownerOf("NoSuchCode99")).toBeNull();
  });

  it("дружба — одна строка на пару в любом порядке, повтор — «уже», заявки между ними исполнены", async () => {
    const a = await account();
    const b = await account();
    expect(await friends.request(b, a, { maxIncoming: 5, maxOutgoing: 5 })).toBe("sent");
    expect(await friends.befriend(a, b, "request", 10)).toEqual({ outcome: "added" });
    expect(await friends.befriend(b, a, "link", 10)).toEqual({ outcome: "already" });
    expect(await friends.hasRequest(b, a)).toBe(false);

    const [accountA, accountB] = orderedPair(a, b);
    expect(await prisma.friendship.count({ where: { accountA, accountB } })).toBe(1);
    expect((await friends.friends(a, 10))[0]).toMatchObject({ accountId: b, source: "request", displayName: `Друг ${marker}` });
    expect((await friends.friends(b, 10))[0]?.accountId).toBe(a);
    expect(await friends.count(a)).toBe(1);

    expect(await friends.remove(b, a)).toBe(true);
    expect(await friends.areFriends(a, b)).toBe(false);
  });

  it("база сама не даёт перевёрнутую пару и заявку самому себе", async () => {
    const a = await account();
    const b = await account();
    const [low, high] = orderedPair(a, b);
    await expect(prisma.friendship.create({ data: { accountA: high, accountB: low, source: "link" } })).rejects.toThrow();
    await expect(prisma.friendRequest.create({ data: { fromAccountId: a, toAccountId: a } })).rejects.toThrow();
  });

  it("потолок друзей держится и при одновременных дружбах", async () => {
    const star = await account();
    const guests = await Promise.all(Array.from({ length: 6 }, () => account()));
    const outcomes = await Promise.all(guests.map((guest) => friends.befriend(star, guest, "link", 3)));
    expect(outcomes.filter((result) => result.outcome === "added")).toHaveLength(3);
    expect(outcomes.filter((result) => result.outcome === "limit")).toHaveLength(3);
    expect(await friends.friends(star, 10)).toHaveLength(3);
  });

  it("подарки: раз в сутки, ожидание, пометка и счёт забранных за сутки", async () => {
    const giver = await account();
    const receiver = await account();
    expect(await friends.sendGift(giver, receiver)).toBe(true);
    expect(await friends.sendGift(giver, receiver)).toBe(false);
    expect(await friends.giftedToday(giver)).toEqual([receiver]);

    const [pending] = await friends.pendingGifts(receiver, 7, 10);
    expect(pending?.fromAccountId).toBe(giver);
    expect(pending?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await friends.pendingGiftCount(receiver, 7)).toBe(1);
    expect(await friends.claimedToday(receiver)).toBe(0);

    await friends.markClaimed(giver, receiver, pending?.day ?? "");
    expect(await friends.pendingGifts(receiver, 7, 10)).toEqual([]);
    expect(await friends.claimedToday(receiver)).toBe(1);

    // Старый подарок за пределом срока — не ждёт.
    await prisma.$executeRaw`INSERT INTO friend_gift (from_account_id, to_account_id, day) VALUES (${receiver}::uuid, ${giver}::uuid, current_date - 30)`;
    expect(await friends.pendingGiftCount(giver, 7)).toBe(0);
  });

  it("заявки: повтор — «есть», потолки входящих и исходящих, отклонение", async () => {
    const target = await account();
    const [first, second, third] = await Promise.all([account(), account(), account()]);
    const limits = { maxIncoming: 2, maxOutgoing: 5 };
    expect(await friends.request(first, target, limits)).toBe("sent");
    expect(await friends.request(first, target, limits)).toBe("exists");
    expect(await friends.request(second, target, limits)).toBe("sent");
    expect(await friends.request(third, target, limits)).toBe("incoming_full");
    expect((await friends.incoming(target, 10)).map((row) => row.accountId).sort()).toEqual([first, second].sort());
    expect((await friends.outgoing(first, 10)).map((row) => row.accountId)).toEqual([target]);
    expect(await friends.request(first, third, { maxIncoming: 5, maxOutgoing: 1 })).toBe("outgoing_full");
    expect(await friends.dropRequest(first, target)).toBe(true);
    expect(await friends.dropRequest(first, target)).toBe(false);
  });

  it("бонус: засчитан только друг с честным забегом, ступень отмечается один раз", async () => {
    const owner = await account();
    const run = async (accountId: string, patch: { status?: "started" | "finished"; cheats?: boolean; verdict?: "ok" | "rejected" | null } = {}) => {
      const status = patch.status ?? "finished";
      await prisma.run.create({
        data: {
          runId: `run-${randomUUID()}`,
          accountId,
          status,
          difficulty: "easy",
          startingWeaponId: "bolt",
          contentHash: "c",
          finishedAt: status === "finished" ? new Date() : null,
          cheats: patch.cheats ?? false,
          verdict: patch.verdict === undefined ? "ok" : patch.verdict,
        },
      });
    };
    const befriend = async (): Promise<string> => {
      const friend = await account();
      expect(await friends.befriend(owner, friend, "link", 100)).toEqual({ outcome: "added" });
      return friend;
    };

    const honest = await befriend();
    await run(honest);
    await run(honest);
    const unchecked = await befriend();
    await run(unchecked, { verdict: null });
    await run(await befriend(), { cheats: true });
    await run(await befriend(), { verdict: "rejected" });
    await run(await befriend(), { status: "started" });
    const banned = await befriend();
    await run(banned);
    await accounts.setBan(banned, { at: new Date(), reason: "накрутка" });
    await run(await account());

    expect(await friends.qualifiedCount(owner)).toBe(2);
    expect(await friends.qualifiedCount(honest)).toBe(0);

    expect(await friends.bonusClaimed(owner)).toEqual([]);
    await friends.markBonusClaimed(owner, 1, 50);
    await friends.markBonusClaimed(owner, 1, 70);
    expect(await friends.bonusClaimed(owner)).toEqual([1]);
    expect((await prisma.friendBonus.findFirst({ where: { accountId: owner } }))?.coins).toBe(50);
  });
});
