import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { codeKey } from "../src/modules/promo-codes/promo-code-rules.js";
import { PrismaPromoCodesRepository, type NewPromoCampaign } from "../src/modules/promo-codes/promo-codes.repository.js";
import type { PartnerRow } from "../src/modules/partners/partner-rules.js";
import { PrismaPartnersRepository } from "../src/modules/partners/partners.repository.js";
import { PrismaReferralsRepository } from "../src/modules/referrals/referrals.repository.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Партнёры на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск): слот источника один на рефералку и
 * партнёров и под гонкой, а статистика партнёра считает только живые
 * оплаты после привязки. Привязывает новых игроков только партнёр со
 * статусом «активен» (T-0066), TG id партнёра уникален.
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

  async function partner(name = "Канал", terms: Partial<PartnerRow> = {}) {
    const partnerId = randomUUID();
    await partners.create({ partnerId, name, contact: "@channel", note: null, createdBy: randomUUID(), createdAt: NOW, updatedAt: NOW, ...terms });
    return partnerId;
  }

  /** Свободный TG id: число до двадцати цифр, не повторяется между прогонами на общей базе. */
  const freshTelegramId = () => String(Math.floor(Math.random() * 1e15) + 1e15);

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
    prisma = testPrisma(DATABASE_URL, 12);
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

  it("игрок под отдельной доской в кабинете партнёра и выплатах считается как обычный (T-0115)", async () => {
    const partnerId = await partner("Канал с доской");
    const shared = await campaign(partnerId);
    const [plain, marked] = await Promise.all([player(), player()]);
    await redeem(plain, shared, partnerId);
    await redeem(marked, shared, partnerId);
    await prisma.accountRestriction.create({ data: { accountId: marked, kind: "separate_board", startsAt: new Date(NOW.getTime() - DAY), reason: "other", notify: false } });
    for (const accountId of [plain, marked]) {
      await prisma.$executeRaw`INSERT INTO account_funnel (account_id, first_run_finished_at) VALUES (${accountId}::uuid, ${NOW})`;
      await prisma.$executeRaw`
        INSERT INTO purchase (purchase_id, account_id, product, sku, price_stars, charged_stars, mode, status, invoiced_at, paid_at)
        VALUES (${randomUUID()}::uuid, ${accountId}::uuid, 'shop_item', 'gems_60', 50, 50, 'live'::"PaymentMode", 'paid'::"PurchaseStatus", ${new Date(NOW.getTime() + HOUR)}, ${new Date(NOW.getTime() + HOUR)})`;
    }

    const view = await partners.byId(partnerId, NOW);
    expect(view?.stats).toEqual({ codes: 1, activeCodes: 1, redeemed: 2, bound: 2, played: 2, payers: 2, stars: 100 });
  });

  it("условия партнёра: записаны и читаются; без них партнёр активен, а процент хранится с двумя знаками", async () => {
    const telegramId = freshTelegramId();
    const full = await partner("С условиями", { telegramId, status: "applied", country: "KZ", payoutCurrency: "USDT", payoutMethod: "USDT TRC-20 на T9yX", sharePercent: "12.50" });
    expect(await partners.byId(full, NOW)).toMatchObject({ telegramId, status: "applied", country: "KZ", payoutCurrency: "USDT", payoutMethod: "USDT TRC-20 на T9yX", sharePercent: "12.50" });
    expect((await partners.list(500, NOW)).find((row) => row.partnerId === full)).toMatchObject({ telegramId, status: "applied", sharePercent: "12.50" });

    const plain = await partner("Без условий");
    expect(await partners.byId(plain, NOW)).toMatchObject({ telegramId: null, status: "active", country: null, payoutCurrency: null, payoutMethod: null, sharePercent: null });
    // Ровно сто процентов помещаются в колонку, как и ноль.
    const edge = await partner("Край", { sharePercent: "100.00" });
    expect((await partners.byId(edge, NOW))?.sharePercent).toBe("100.00");
  });

  it("TG id уникален: второй партнёр с тем же id получает отказ с именем первого — и при создании, и при правке, и под гонкой", async () => {
    const telegramId = freshTelegramId();
    await partner("Первый", { telegramId });
    await expect(partner("Второй", { telegramId })).rejects.toMatchObject({ code: "partner_telegram_taken", status: 409, message: "Этот TG id уже у партнёра «Первый»" });

    const second = await partner("Без id");
    await expect(partners.update(second, { telegramId }, NOW)).rejects.toMatchObject({ code: "partner_telegram_taken" });
    expect((await partners.byId(second, NOW))?.telegramId).toBeNull();

    const raced = freshTelegramId();
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => partner(`Гонка ${String(index)}`, { telegramId: raced })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "partner_telegram_taken" });
  });

  it("правка меняет только названные поля: null стирает, не названное остаётся; статус — той же правкой", async () => {
    const telegramId = freshTelegramId();
    const partnerId = await partner("Блогер", { telegramId, country: "RU", payoutCurrency: "RUB", payoutMethod: "карта", sharePercent: "10.00" });

    const first = await partners.update(partnerId, { sharePercent: "7.50", country: null }, NOW);
    expect(first).toMatchObject({
      before: { telegramId, country: "RU", sharePercent: "10.00", status: "active", name: "Блогер" },
      after: { telegramId, country: null, sharePercent: "7.50", status: "active", name: "Блогер", payoutCurrency: "RUB", payoutMethod: "карта" },
    });

    const paused = await partners.update(partnerId, { status: "paused" }, NOW);
    expect(paused).toMatchObject({ before: { status: "active" }, after: { status: "paused", sharePercent: "7.50" } });
    expect(await partners.update(partnerId, { telegramId: null }, NOW)).toMatchObject({ after: { telegramId: null, status: "paused" } });
    expect(await partners.byId(partnerId, NOW)).toMatchObject({ telegramId: null, status: "paused", payoutCurrency: "RUB", sharePercent: "7.50" });
    expect(await partners.update(randomUUID(), { status: "paused" }, NOW)).toBeNull();
  });

  it("код партнёра не в статусе «активен» награду даёт, но игрока к партнёру не привязывает; прежних привязок статус не трогает", async () => {
    const partnerId = await partner("Блогер");
    const code = await campaign(partnerId);
    const earlier = await player();
    expect(await redeem(earlier, code, partnerId)).toEqual({ status: "redeemed", bound: true });

    let redeemed = 1;
    for (const status of ["paused", "applied", "rejected"] as const) {
      await partners.update(partnerId, { status }, NOW);
      const newbie = await player();
      expect(await redeem(newbie, code, partnerId), status).toEqual({ status: "redeemed", bound: false });
      redeemed += 1;
      // Награда кода не потеряна — активация записана, — а привязки нет.
      expect(await promo.redemption(code.campaignId, newbie), status).toMatchObject({ rewardedAt: null });
      expect(await partners.bindingOf(newbie), status).toBeNull();
      // Приведённый раньше остаётся за партнёром при любом статусе.
      expect(await partners.bindingOf(earlier), status).toMatchObject({ partnerId, name: "Блогер" });
    }
    expect((await partners.byId(partnerId, NOW))?.stats).toMatchObject({ bound: 1, redeemed });

    await partners.update(partnerId, { status: "active" }, NOW);
    const later = await player();
    expect(await redeem(later, code, partnerId)).toEqual({ status: "redeemed", bound: true });
    expect((await partners.byId(partnerId, NOW))?.stats.bound).toBe(2);
  });

  it("отказ в привязке слот источника не занимает: игрок, введший код приостановленного партнёра, ещё привяжется к активному", async () => {
    const paused = await partner("Приостановленный", { status: "paused" });
    const active = await partner("Активный");
    const pausedCode = await campaign(paused);
    const activeCode = await campaign(active);
    const me = await player();

    expect(await redeem(me, pausedCode, paused)).toEqual({ status: "redeemed", bound: false });
    expect(await redeem(me, activeCode, active)).toEqual({ status: "redeemed", bound: true });
    expect(await partners.bindingOf(me)).toMatchObject({ partnerId: active });
    // И друг-пригласивший тоже: слот занимает только состоявшаяся привязка.
    const referrer = await player();
    const invited = await player();
    expect(await redeem(invited, pausedCode, paused)).toEqual({ status: "redeemed", bound: false });
    expect(await referrals.bind(invited, referrer, "bound", null)).toBe(true);
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
