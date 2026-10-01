import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { codeKey } from "../src/modules/promo-codes/promo-code-rules.js";
import { PrismaPromoCodesRepository, type NewPromoCampaign } from "../src/modules/promo-codes/promo-codes.repository.js";
import { PrismaPartnersRepository } from "../src/modules/partners/partners.repository.js";
import { PrismaReferralsRepository } from "../src/modules/referrals/referrals.repository.js";

/**
 * Партнёры на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск): слот источника один на рефералку и
 * партнёров и под гонкой, а статистика партнёра считает только живые
 * оплаты после привязки.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(Date.UTC(2026, 9, 2, 9));

describe.skipIf(DATABASE_URL === "")("партнёры на живом Postgres", () => {
  let prisma: PrismaClient;
  let promo: PrismaPromoCodesRepository;
  let partners: PrismaPartnersRepository;
  let referrals: PrismaReferralsRepository;
  let accounts: PrismaAccountRepository;

  const uniqueCode = () => `P${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const player = async () => (await accounts.upsert({ platform: "telegram", platformUserId: String(Math.floor(Math.random() * 1e12)), displayName: "Игрок", username: null, photoUrl: null }, NOW.getTime())).accountId;

  async function partner(name = "Канал") {
    const partnerId = randomUUID();
    await partners.create({ partnerId, name, contact: "@channel", note: null, createdBy: randomUUID(), createdAt: NOW, updatedAt: NOW });
    return partnerId;
  }

  async function campaign(partnerId: string | null, patch: Partial<NewPromoCampaign> = {}) {
    const display = uniqueCode();
    const row: NewPromoCampaign = {
      campaignId: randomUUID(),
      title: "Код канала",
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
      ...patch,
    };
    const outcome = await promo.create(row, [{ code: codeKey(display), display }], null);
    if (outcome.status !== "created") throw new Error("код занят");
    return { ...outcome.row, key: codeKey(display), display };
  }

  const redeem = (accountId: string, code: { campaignId: string; key: string }, partnerId: string | null, at = NOW) =>
    promo.redeem({ campaignId: code.campaignId, accountId, code: code.key, batch: false, partnerId, at });

  beforeAll(() => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 12, connectionTimeoutMillis: 30_000 }) });
    promo = new PrismaPromoCodesRepository(prisma);
    partners = new PrismaPartnersRepository(prisma);
    referrals = new PrismaReferralsRepository(prisma);
    accounts = new PrismaAccountRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("код партнёра привязывает игрока; повторно и чужим кодом — не перепривязывает", async () => {
    const first = await partner("Первый");
    const second = await partner("Второй");
    const own = await campaign(first);
    const other = await campaign(second);
    const me = await player();
    expect(await redeem(me, own, first)).toEqual({ status: "redeemed", bound: true });
    expect(await redeem(me, other, second)).toEqual({ status: "redeemed", bound: false });
    expect(await partners.bindingOf(me)).toMatchObject({ partnerId: first, name: "Первый", campaignTitle: "Код канала", code: own.display });
    // Привязка без кода партнёра (`partnerId = null`) не пишется вовсе.
    const plain = await campaign(null);
    const newbie = await player();
    expect(await redeem(newbie, plain, null)).toEqual({ status: "redeemed", bound: false });
    expect(await partners.bindingOf(newbie)).toBeNull();
  });

  it("слот источника один: друг первым — партнёр не привязывает; партнёр первым — друг не привязывает", async () => {
    const partnerId = await partner();
    const code = await campaign(partnerId);
    const referrer = await player();

    const invited = await player();
    expect(await referrals.bind(invited, referrer, "bound", null)).toBe(true);
    expect(await redeem(invited, code, partnerId)).toEqual({ status: "redeemed", bound: false });

    // Отклонённая антифродом привязка друга слот тоже занимает.
    const suspicious = await player();
    expect(await referrals.bind(suspicious, referrer, "rejected", "same_network")).toBe(true);
    expect(await redeem(suspicious, code, partnerId)).toEqual({ status: "redeemed", bound: false });

    const brought = await player();
    expect(await redeem(brought, code, partnerId)).toEqual({ status: "redeemed", bound: true });
    expect(await referrals.bind(brought, referrer, "bound", null)).toBe(false);
    expect(await referrals.binding(brought)).toBeNull();
  });

  it("друг и код партнёра разом у десяти игроков — у каждого ровно одна привязка", async () => {
    const partnerId = await partner();
    const code = await campaign(partnerId);
    const referrer = await player();
    const players = await Promise.all(Array.from({ length: 10 }, player));
    const results = await Promise.all(players.map(async (accountId) => Promise.all([referrals.bind(accountId, referrer, "bound", null), redeem(accountId, code, partnerId)])));
    for (const [index, [byFriend, byCode]] of results.entries()) {
      const accountId = players[index] ?? "";
      const bound = byCode.status === "redeemed" && byCode.bound;
      expect(Number(byFriend) + Number(bound), accountId).toBe(1);
      expect((await referrals.binding(accountId)) !== null).toBe(byFriend);
      expect((await partners.bindingOf(accountId)) !== null).toBe(bound);
    }
  });

  it("статистика: привязанные, сыгравшие, платившие после привязки живыми звёздами; коды и их привязки", async () => {
    const partnerId = await partner("Блогер");
    const shared = await campaign(partnerId);
    const paused = await campaign(partnerId, { title: "Старый код" });
    await promo.setPaused(paused.campaignId, NOW, NOW);
    const [a, b, c] = await Promise.all([player(), player(), player()]);
    await redeem(a, shared, partnerId);
    await redeem(b, shared, partnerId);
    await redeem(c, paused, null);

    await prisma.$executeRaw`INSERT INTO account_funnel (account_id, first_run_finished_at) VALUES (${a}::uuid, ${NOW})`;
    const purchase = (accountId: string, stars: number, mode: "live" | "test", status: "paid" | "refunded", paidAt: Date) => prisma.$executeRaw`
      INSERT INTO purchase (purchase_id, account_id, product, sku, price_stars, charged_stars, mode, status, invoiced_at, paid_at)
      VALUES (${randomUUID()}::uuid, ${accountId}::uuid, 'shop_item', 'gems_60', ${stars}, ${stars}, ${mode}::"PaymentMode", ${status}::"PurchaseStatus", ${paidAt}, ${paidAt})`;
    await purchase(a, 50, "live", "paid", new Date(NOW.getTime() + HOUR));
    await purchase(a, 250, "live", "paid", new Date(NOW.getTime() + 2 * HOUR));
    // Не засчитываются: тестовая оплата, возвращённая и купленное до привязки.
    await purchase(b, 1, "test", "paid", new Date(NOW.getTime() + HOUR));
    await purchase(b, 500, "live", "refunded", new Date(NOW.getTime() + HOUR));
    await purchase(b, 700, "live", "paid", new Date(NOW.getTime() - DAY));

    const view = await partners.byId(partnerId, NOW);
    expect(view?.stats).toEqual({ codes: 2, activeCodes: 1, redeemed: 3, bound: 2, played: 1, payers: 1, stars: 300 });
    expect((await partners.list(500, NOW)).find((row) => row.partnerId === partnerId)?.stats.bound).toBe(2);
    const codes = await partners.campaigns(partnerId);
    expect(codes.map((code) => [code.title, code.redeemed, code.bound])).toEqual(
      expect.arrayContaining([
        ["Код канала", 2, 2],
        ["Старый код", 1, 0],
      ]),
    );
    expect(await partners.daily(partnerId, new Date(NOW.getTime() - DAY))).toEqual([{ day: "2026-10-02", count: 2 }]);
  });

  it("правка партнёра — с прежним видом; партнёра с кодами база удалить не даст", async () => {
    const partnerId = await partner("Старое имя");
    await campaign(partnerId);
    const changed = await partners.update(partnerId, { name: "Новое имя", contact: null, note: "договор до декабря" }, NOW);
    expect(changed).toMatchObject({ before: { name: "Старое имя", contact: "@channel" }, after: { name: "Новое имя", contact: null, note: "договор до декабря" } });
    expect(await partners.update(randomUUID(), { name: "x1", contact: null, note: null }, NOW)).toBeNull();
    expect((await partners.names()).some((row) => row.partnerId === partnerId && row.name === "Новое имя")).toBe(true);
    await expect(prisma.$executeRaw`DELETE FROM partner WHERE partner_id = ${partnerId}::uuid`).rejects.toThrow();
  });
});
