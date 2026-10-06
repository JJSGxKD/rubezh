import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaBroadcastsRepository } from "../src/modules/broadcasts/broadcasts.repository.js";
import { segmentSchema } from "../src/modules/broadcasts/segment.js";
import { newClickId, newLinkCode } from "../src/modules/links/link-code.js";

/**
 * Рассылки на живом Postgres (docs/29-admin-panel.md §7): условие сегмента,
 * набор получателей на старте, захват строк со сроком и итог. Без
 * TEST_DATABASE_URL — пропуск: локально базы нет, тест гоняет CI.
 *
 * База общая с другими тестами, поэтому аудитория ограничена своей
 * кампанией: чужие аккаунты в счёт не попадут.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

describe.skipIf(DATABASE_URL === "")("рассылки на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let broadcasts: PrismaBroadcastsRepository;
  const campaign = `bc${Date.now().toString(36)}`;
  const linkCode = newLinkCode();

  interface Player {
    platform?: "telegram" | "vk";
    canMessage?: boolean;
    banned?: boolean;
    appOpened?: boolean;
  }

  async function player(options: Player = {}): Promise<{ accountId: string; platformUserId: string }> {
    const platformUserId = String(950_000_000 + Math.floor(Math.random() * 40_000_000));
    const account = await accounts.upsert({ platform: options.platform ?? "telegram", platformUserId, displayName: `Игрок ${campaign}`, username: null, photoUrl: null }, Date.now());
    const now = new Date();
    const clickId = newClickId();
    await prisma.linkClick.create({ data: { clickId, linkCode } });
    await prisma.acquisition.create({ data: { accountId: account.accountId, firstAt: now, firstStartKind: "click", firstStartRef: clickId, firstDeviceClass: "mobile", lastSeenAt: now } });
    await prisma.accountMessaging.create({ data: { accountId: account.accountId, canMessage: options.canMessage ?? true, reason: "entered", changedAt: new Date(now.getTime() - 60_000) } });
    await prisma.accountFunnel.create({ data: { accountId: account.accountId, enteredAt: now, appOpenedAt: options.appOpened === false ? null : now } });
    if (options.banned === true) await accounts.setBan(account.accountId, { at: now, reason: "тест" });
    return { accountId: account.accountId, platformUserId };
  }

  beforeAll(async () => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
    accounts = new PrismaAccountRepository(prisma);
    broadcasts = new PrismaBroadcastsRepository(prisma);
    await prisma.link.create({ data: { code: linkCode, campaign, platform: "telegram" } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("сегмент, старт, захват строк и итог", async () => {
    const reached = await player();
    const fresh = await player({ appOpened: false });
    await player({ canMessage: false });
    await player({ banned: true });
    await player({ platform: "vk" });

    const mine = (patch: object) => segmentSchema.parse({ campaign, skipRecentDays: 0, ...patch });
    expect(await broadcasts.count("telegram", mine({}))).toBe(2);
    expect(await broadcasts.count("telegram", mine({ reached: ["app_opened"] }))).toBe(1);
    expect(await broadcasts.count("telegram", mine({ notReached: ["app_opened"] }))).toBe(1);
    expect(await broadcasts.count("telegram", mine({ startKinds: ["organic"] }))).toBe(0);
    expect(await broadcasts.count("telegram", mine({ registeredWithinDays: 1, activeWithinDays: 1 }))).toBe(2);
    expect(await broadcasts.count("telegram", mine({ inactiveForDays: 1 }))).toBe(0);
    expect(await broadcasts.count("vk", mine({}))).toBe(1);

    const broadcastId = randomUUID();
    const created = await broadcasts.create({
      broadcastId,
      title: "Тест",
      platform: "telegram",
      text: "Привет",
      buttonText: null,
      buttonUrl: null,
      linkCode: null,
      segment: mine({}),
      createdBy: reached.accountId,
    });
    expect(created).toMatchObject({ status: "draft", segment: mine({}) });
    expect(await broadcasts.approve(broadcastId, fresh.accountId)).toBe(true);
    expect((await broadcasts.updateDraft(broadcastId, { title: "Тест 2", text: "Привет", buttonText: null, segment: mine({}) }))?.approvedBy).toBeNull();

    expect(await broadcasts.start(broadcastId, reached.accountId, new Date())).toBe(2);
    expect(await broadcasts.start(broadcastId, reached.accountId, new Date())).toBeNull();
    expect(await broadcasts.updateDraft(broadcastId, { title: "Поздно", text: "x", buttonText: null, segment: mine({}) })).toBeNull();
    expect(await broadcasts.sending()).toContain(broadcastId);

    const [first] = await broadcasts.claim(broadcastId, 1, 60);
    const [second] = await broadcasts.claim(broadcastId, 1, 60);
    expect(await broadcasts.claim(broadcastId, 10, 60)).toEqual([]);
    expect(new Set([first?.accountId, second?.accountId])).toEqual(new Set([reached.accountId, fresh.accountId]));
    expect([first?.platformUserId, second?.platformUserId].sort()).toEqual([reached.platformUserId, fresh.platformUserId].sort());

    const sentAt = new Date();
    await broadcasts.record(broadcastId, reached.accountId, { status: "sent", at: sentAt });
    expect(await broadcasts.defer(broadcastId, fresh.accountId)).toBe(1);
    expect((await broadcasts.claim(broadcastId, 10, 60)).map((row) => row.accountId)).toEqual([fresh.accountId]);
    await broadcasts.release(broadcastId, [fresh.accountId]);
    expect((await broadcasts.claim(broadcastId, 10, 60)).map((row) => row.accountId)).toEqual([fresh.accountId]);

    await prisma.accountMessaging.update({ where: { accountId: reached.accountId }, data: { canMessage: false, reason: "blocked", changedAt: new Date(sentAt.getTime() + 1000) } });
    expect(await broadcasts.stats(broadcastId)).toEqual({ queued: 1, sent: 1, blocked: 0, failed: 0, blockedAfter: 1 });

    // Получивший рассылку недавно — вне аудитории следующей по умолчанию.
    await prisma.accountMessaging.update({ where: { accountId: reached.accountId }, data: { canMessage: true, reason: "unblocked" } });
    expect(await broadcasts.count("telegram", mine({ skipRecentDays: 3 }))).toBe(1);

    await broadcasts.record(broadcastId, fresh.accountId, { status: "failed", error: "400" });
    expect(await broadcasts.transition(broadcastId, ["sending"], "done", new Date())).toBe(true);
    expect(await broadcasts.transition(broadcastId, ["sending"], "done", new Date())).toBe(false);
    expect((await broadcasts.byId(broadcastId))?.finishedAt).toBeInstanceOf(Date);
    expect(await broadcasts.sending()).not.toContain(broadcastId);
  });
});
