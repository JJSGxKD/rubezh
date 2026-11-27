import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { lockSourceSlot } from "../src/modules/attribution/source-slot.js";
import { PrismaTelegramAffiliateRepository } from "../src/modules/attribution/telegram-affiliate.repository.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { newLinkCode } from "../src/modules/links/link-code.js";
import { PrismaLinksRepository } from "../src/modules/links/links.repository.js";
import { PartnerLinkBinder } from "../src/modules/partners/partner-links.js";
import { PrismaPartnersRepository } from "../src/modules/partners/partners.repository.js";
import { codeKey } from "../src/modules/promo-codes/promo-code-rules.js";
import { PrismaPromoCodesRepository, type NewPromoCampaign } from "../src/modules/promo-codes/promo-codes.repository.js";
import { PrismaReferralsRepository } from "../src/modules/referrals/referrals.repository.js";
import { uniquePlatformUserId } from "./helpers/player-ids.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Метка партнёрки Telegram на живом Postgres (docs/35-stage4-plan.md Р97, T-0072; адрес —
 * TEST_DATABASE_URL, без него пропуск): метка одна и навсегда, слот источника общий с рефералом
 * и партнёром под одной блокировкой аккаунта, гонка метки и привязки даёт одного победителя.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const NOW = new Date(Date.UTC(2026, 9, 13, 14, 5, 0));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe.skipIf(DATABASE_URL === "")("метка партнёрки Telegram на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let marks: PrismaTelegramAffiliateRepository;
  let referrals: PrismaReferralsRepository;
  let promos: PrismaPromoCodesRepository;
  let partners: PrismaPartnersRepository;
  let links: PrismaLinksRepository;
  let linkBinder: PartnerLinkBinder;

  const player = async () => (await accounts.upsert({ platform: "telegram", platformUserId: uniquePlatformUserId(), displayName: "Игрок", username: null, photoUrl: null }, NOW.getTime())).accountId;
  const markOf = (accountId: string, ref = "x9Y-z") => marks.mark({ accountId, startParam: `_tgr_${ref}`, ref, at: NOW });
  const slotOf = (accountId: string) => prisma.$transaction((tx) => lockSourceSlot(tx, accountId));
  const uniqueCode = () => `T${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;

  /** Партнёр с общим кодом, который гасится с привязкой: так игрок занимает слот партнёром. */
  async function partnerCode(): Promise<{ partnerId: string; campaignId: string; code: string }> {
    const partnerId = randomUUID();
    await partners.create({ partnerId, name: "Блогер", contact: null, note: null, createdBy: randomUUID(), createdAt: NOW, updatedAt: NOW });
    const display = uniqueCode();
    const campaign: NewPromoCampaign = {
      campaignId: randomUUID(),
      title: "Стрим",
      kind: "shared",
      reward: { coins: 500, gems: 0, shard_common: 0, shard_uncommon: 0 },
      message: null,
      maxRedemptions: null,
      startsAt: new Date(NOW.getTime() - HOUR),
      endsAt: new Date(NOW.getTime() + DAY),
      newPlayersDays: null,
      platforms: [],
      note: null,
      partnerId,
      createdBy: randomUUID(),
      createdAt: NOW,
    };
    const created = await promos.create(campaign, [{ code: codeKey(display), display }], null);
    if (created.status !== "created") throw new Error(`код занят: ${display}`);
    return { partnerId, campaignId: created.row.campaignId, code: codeKey(display) };
  }

  beforeAll(() => {
    prisma = testPrisma(DATABASE_URL, 12);
    accounts = new PrismaAccountRepository(prisma);
    marks = new PrismaTelegramAffiliateRepository(prisma);
    referrals = new PrismaReferralsRepository(prisma);
    promos = new PrismaPromoCodesRepository(prisma);
    partners = new PrismaPartnersRepository(prisma);
    links = new PrismaLinksRepository(prisma);
    linkBinder = new PartnerLinkBinder(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("новый аккаунт: метка ставится, читается как записана, а слот источника становится «telegram»", async () => {
    const accountId = await player();
    expect(await marks.byAccount(accountId)).toBeNull();
    expect(await slotOf(accountId)).toBe("free");

    expect(await markOf(accountId)).toEqual({ status: "marked" });

    expect(await marks.byAccount(accountId)).toEqual({ startParam: "_tgr_x9Y-z", ref: "x9Y-z", markedAt: NOW });
    expect(await slotOf(accountId)).toBe("telegram");
  });

  it("повтор с другим идентификатором — «already», запись прежняя", async () => {
    const accountId = await player();
    await markOf(accountId);

    expect(await marks.mark({ accountId, startParam: "_tgr_other", ref: "other", at: new Date(NOW.getTime() + DAY) })).toEqual({ status: "already" });

    expect(await marks.byAccount(accountId)).toEqual({ startParam: "_tgr_x9Y-z", ref: "x9Y-z", markedAt: NOW });
  });

  it("слот занят приглашением друга — «slot_taken» со слотом referral, строки метки нет; отклонённая антифродом привязка слот тоже держит", async () => {
    const referrer = await player();
    const bound = await player();
    const rejected = await player();
    expect(await referrals.bind(bound, referrer, "bound", null)).toBe(true);
    expect(await referrals.bind(rejected, referrer, "rejected", "same_network")).toBe(true);

    expect(await markOf(bound)).toEqual({ status: "slot_taken", slot: "referral" });
    expect(await markOf(rejected)).toEqual({ status: "slot_taken", slot: "referral" });

    expect(await prisma.telegramAffiliateMark.findUnique({ where: { accountId: bound } })).toBeNull();
    expect(await prisma.telegramAffiliateMark.findUnique({ where: { accountId: rejected } })).toBeNull();
  });

  it("слот занят партнёром по коду — «slot_taken» со слотом partner, строки метки нет", async () => {
    const { partnerId, campaignId, code } = await partnerCode();
    const accountId = await player();
    expect(await promos.redeem({ campaignId, accountId, code, batch: false, partnerId, at: NOW })).toEqual({ status: "redeemed", bound: true });

    expect(await markOf(accountId)).toEqual({ status: "slot_taken", slot: "partner" });

    expect(await prisma.telegramAffiliateMark.findUnique({ where: { accountId } })).toBeNull();
  });

  it("помеченного игрока реферер не привязывает и партнёр по коду не привязывает, а код всё равно гасится", async () => {
    const referrer = await player();
    const accountId = await player();
    await markOf(accountId);

    expect(await referrals.bind(accountId, referrer, "bound", null)).toBe(false);
    expect(await prisma.referralBinding.findUnique({ where: { referredId: accountId } })).toBeNull();

    const { partnerId, campaignId, code } = await partnerCode();
    expect(await promos.redeem({ campaignId, accountId, code, batch: false, partnerId, at: NOW })).toEqual({ status: "redeemed", bound: false });
    expect(await prisma.partnerBinding.findUnique({ where: { accountId } })).toBeNull();
    expect(await marks.byAccount(accountId)).toMatchObject({ ref: "x9Y-z" });
  });

  it("помеченного игрока не привязывает и ссылка партнёра (T-0067): решение «слот занят», привязки нет", async () => {
    const partnerId = randomUUID();
    await partners.create({ partnerId, name: "Канал", contact: null, note: null, createdBy: randomUUID(), createdAt: NOW, updatedAt: NOW });
    const code = newLinkCode();
    await links.create({ code, platform: "telegram", campaign: "channel-post", source: null, medium: null, note: null, createdBy: null, network: null, registrationOn: "first_run", partnerId });
    const marked = await player();
    const free = await player();
    await markOf(marked);

    expect(await linkBinder.bindFromTouch({ accountId: marked, startKind: "link", startRef: code, at: NOW })).toBe("slot_taken");
    expect(await prisma.partnerBinding.findUnique({ where: { accountId: marked } })).toBeNull();
    // Контроль: тот же вход свободного игрока привязывается, так что отказ — от метки, а не от ссылки.
    expect(await linkBinder.bindFromTouch({ accountId: free, startKind: "link", startRef: code, at: NOW })).toBe("bind");
  });

  it("гонка метки и привязки реферала: в каждом раунде ровно один победитель, оба вместе — никогда", async () => {
    const referrer = await player();
    let marked = 0;
    let bound = 0;
    for (let round = 0; round < 20; round += 1) {
      const accountId = await player();
      const [outcome, referral] = await Promise.all([markOf(accountId), referrals.bind(accountId, referrer, "bound", null)]);

      const markWon = outcome.status === "marked";
      expect(markWon !== referral, `раунд ${String(round)}: метка ${outcome.status}, привязка ${String(referral)}`).toBe(true);
      expect(await prisma.telegramAffiliateMark.count({ where: { accountId } })).toBe(markWon ? 1 : 0);
      expect(await prisma.referralBinding.count({ where: { referredId: accountId } })).toBe(referral ? 1 : 0);
      if (markWon) marked += 1;
      else bound += 1;
    }
    expect(marked + bound).toBe(20);
  });

  it("две метки разом на одном аккаунте — одна запись, у второй «already»", async () => {
    const accountId = await player();

    const outcomes = await Promise.all(Array.from({ length: 5 }, (_unused, index) => markOf(accountId, `id${String(index)}`)));

    expect(outcomes.filter((outcome) => outcome.status === "marked")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "already")).toHaveLength(4);
    expect(await prisma.telegramAffiliateMark.count({ where: { accountId } })).toBe(1);
  });

  it("параметр длиннее 64 знаков база не принимает: метка не появляется", async () => {
    const accountId = await player();

    await expect(marks.mark({ accountId, startParam: `_tgr_${"a".repeat(60)}`, ref: "a".repeat(60), at: NOW })).rejects.toThrow();

    expect(await marks.byAccount(accountId)).toBeNull();
  });

  it("удаление аккаунта удаляет метку (onDelete: Cascade)", async () => {
    const accountId = await player();
    await markOf(accountId);

    await prisma.account.delete({ where: { accountId } });

    expect(await prisma.telegramAffiliateMark.findUnique({ where: { accountId } })).toBeNull();
  });
});
