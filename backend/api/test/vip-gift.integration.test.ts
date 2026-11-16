import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { DomainError } from "../src/common/domain-error.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { PrismaAchievementsRepository } from "../src/modules/achievements/achievements.repository.js";
import { EMBLEM_IDS } from "../src/modules/achievements/emblem-rules.js";
import { PrismaEmblemsRepository, emblemHoldersSql } from "../src/modules/achievements/emblems.repository.js";
import { EmblemsService } from "../src/modules/achievements/emblems.service.js";
import { PrismaAppearanceRepository } from "../src/modules/appearance/appearance.repository.js";
import { AppearanceService } from "../src/modules/appearance/appearance.service.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaFriendsRepository } from "../src/modules/friends/friends.repository.js";
import { AdPasses } from "../src/modules/ads/ads-passes.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { NOTIFICATION_KINDS } from "../src/modules/notifications/notification-kinds.js";
import { PrismaNotificationsRepository } from "../src/modules/notifications/notifications.repository.js";
import { NotificationsService } from "../src/modules/notifications/notifications.service.js";
import { PaymentConfirmation } from "../src/modules/payments/payment-confirmation.js";
import { PaymentRefunds } from "../src/modules/payments/payment-refunds.js";
import { PaymentsHooks } from "../src/modules/payments/payments-hooks.js";
import { PaymentsQueue } from "../src/modules/payments/payments-queue.js";
import { PaymentsService } from "../src/modules/payments/payments.service.js";
import { PurchaseFulfillment } from "../src/modules/payments/purchase-fulfillment.js";
import { PurchaseRevocation } from "../src/modules/payments/purchase-revocation.js";
import type { StoredPurchase } from "../src/modules/payments/purchase-types.js";
import { PrismaPurchasesRepository } from "../src/modules/payments/purchases.repository.js";
import { SubscriptionRenewal } from "../src/modules/payments/subscription-renewal.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { PrismaTasksRepository } from "../src/modules/tasks/tasks.repository.js";
import { TasksService } from "../src/modules/tasks/tasks.service.js";
import { VIP_GIFT_DAY_LIMIT } from "../src/modules/vip/vip-gift-rules.js";
import { PrismaVipGiftRepository } from "../src/modules/vip/vip-gift.repository.js";
import { VipGiftService } from "../src/modules/vip/vip-gift.service.js";
import { VIP_GIFT_SKU, VIP_PERIOD_SEC } from "../src/modules/vip/vip-plan.js";
import { PrismaVipRepository } from "../src/modules/vip/vip.repository.js";
import { VipService } from "../src/modules/vip/vip.service.js";
import { WalletBonuses } from "../src/modules/wallet/wallet-bonus.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { FakeStarsApi, starsProviders } from "./helpers/fake-stars-api.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRestrictionsRepository, restrictionsGate } from "./helpers/memory-restrictions.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryRunsRepository } from "./helpers/memory-runs.js";
import { switchesOf } from "./helpers/notify-targets.js";
import { uniquePlatformUserId } from "./helpers/player-ids.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { panelSettings } from "./helpers/settings.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * VIP в подарок другу на живых Postgres и Redis (tasks/T-0249, docs/35-stage4-plan.md Р155;
 * адреса — TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL; без базы пропуск, без Redis пропущен
 * только лимит заказов): заказ только другу и только по публичному id, получатель записан в заказ
 * на сервере, выдача и возврат идемпотентны и атомарны под гонкой, срок подарка отдельно от
 * подписки, а VIP, знак, облик «Князь» и награды у получателя идут и на подаренном сроке.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 12);
const NOW = new Date(Date.UTC(2026, 10, 20, 9));
const DAY = 86_400_000;
const at = (days: number): Date => new Date(NOW.getTime() + days * DAY);
const PRICE = VIP_GIFT_SKU.stars;

interface Player {
  accountId: string;
  publicId: string;
  platformUserId: string;
  ref: AccountRef;
}

describe.skipIf(DATABASE_URL === "")("VIP в подарок на живых Postgres и Redis", () => {
  let settings: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis | null = null;
  let accounts: PrismaAccountRepository;
  let friendsRepository: PrismaFriendsRepository;
  let purchases: PrismaPurchasesRepository;
  let vipRepository: PrismaVipRepository;
  let giftRepository: PrismaVipGiftRepository;
  let emblemsRepository: PrismaEmblemsRepository;

  beforeAll(async () => {
    settings = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, TELEGRAM_BOT_UPDATES: "polling", PAYMENTS_ENABLED: "true", ...(REDIS_URL === "" ? {} : { REDIS_URL }) } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 10);
    if (REDIS_URL !== "") {
      redis = createRedis(settings);
      await redis.connect();
    }
    accounts = new PrismaAccountRepository(prisma);
    friendsRepository = new PrismaFriendsRepository(prisma);
    purchases = new PrismaPurchasesRepository(prisma);
    vipRepository = new PrismaVipRepository(prisma);
    giftRepository = new PrismaVipGiftRepository(prisma);
    emblemsRepository = new PrismaEmblemsRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    if (redis !== null) await closeRedis(redis);
  });

  beforeEach(() => {
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function player(name = "Игрок"): Promise<Player> {
    const platformUserId = uniquePlatformUserId();
    const created = await accounts.upsert({ platform: "telegram", platformUserId, displayName: name, username: null }, Date.now());
    if (created.publicId === undefined) throw new Error("у нового аккаунта нет публичного id");
    return { accountId: created.accountId, publicId: created.publicId, platformUserId, ref: { accountId: created.accountId, platform: "telegram", platformUserId } };
  }

  async function friends(a: Player, b: Player): Promise<void> {
    await friendsRepository.befriend(a.accountId, b.accountId, "request", 100);
  }

  /** Подарок и всё вокруг него на настоящих таблицах; подделаны только площадка и кошелёк. */
  function stack(options: { limiter?: Pick<RateLimiter, "consume"> } = {}) {
    const api = new FakeStarsApi();
    const providers = starsProviders(api);
    const payments = new PaymentsService(settings, purchases, new MemoryRunsRepository(), providers, switchesOf(settings));
    const fulfillment = new PurchaseFulfillment();
    const revocation = new PurchaseRevocation();
    const restrictionsRepository = new MemoryRestrictionsRepository();
    const restrictions = restrictionsGate(restrictionsRepository);
    const notifications = new NotificationsService(new PrismaNotificationsRepository(prisma));
    const limiter = options.limiter ?? { consume: async () => true };
    const gifts = new VipGiftService(payments, fulfillment, revocation, accounts, friendsRepository, restrictions, notifications, limiter, giftRepository);
    gifts.onModuleInit();
    const hooks = new PaymentsHooks();
    const bonuses = new WalletBonuses();
    const wallet = { grant: async (input: { amount: number }) => ({ credited: input.amount }) } as unknown as WalletService;
    const vip = new VipService(vipRepository, payments, fulfillment, hooks, new SubscriptionRenewal(purchases, providers), wallet, bonuses, new AdPasses(), accounts, revocation, restrictions, giftRepository);
    vip.onModuleInit();
    const confirmation = new PaymentConfirmation(settings, purchases, providers, switchesOf(settings), hooks, revocation);
    const queue = new PaymentsQueue(settings, confirmation, new PaymentRefunds(purchases, providers, revocation), new RunsHooks(), providers, fulfillment, purchases);
    return { api, gifts, vip, bonuses, confirmation, queue, restrictionsRepository, fulfillment, revocation };
  }

  type Stack = ReturnType<typeof stack>;

  /** Заказ через сервис и оплата на настоящих таблицах — без выдачи: её зовёт тест в нужный момент. */
  async function paidGift(ctx: Stack, giver: Player, recipient: Player, paidAt: Date = NOW): Promise<StoredPurchase> {
    const invoice = await ctx.gifts.order(giver.ref, recipient.publicId);
    await purchases.markPaid({ purchaseId: invoice.purchaseId, chargeId: `charge-${invoice.purchaseId}`, chargedStars: invoice.chargedStars, paidAt });
    const purchase = await purchases.byId(invoice.purchaseId);
    if (purchase === null) throw new Error("покупки нет");
    return purchase;
  }

  async function windowsOf(accountId: string): Promise<{ startsAt: number; endsAt: number; revokedAt: number | null }[]> {
    const rows = await giftRepository.windows(accountId, null);
    return rows.map((row) => ({ startsAt: row.startsAt.getTime(), endsAt: row.endsAt.getTime(), revokedAt: row.revokedAt === null ? null : row.revokedAt.getTime() })).sort((a, b) => a.startsAt - b.startsAt);
  }

  async function failure(promise: Promise<unknown>): Promise<DomainError> {
    try {
      await promise;
    } catch (error: unknown) {
      if (error instanceof DomainError) return error;
      throw error;
    }
    throw new Error("ожидался отказ, а вернулся ответ");
  }

  async function notices(accountId: string) {
    return await prisma.notification.findMany({ where: { accountId, kind: "vip_gift" } });
  }

  async function purchaseCount(accountId: string): Promise<number> {
    return await prisma.purchase.count({ where: { accountId, product: "vip_gift" } });
  }

  async function paidVip(accountId: string, renewalOf: string | null = null): Promise<string> {
    const purchaseId = randomUUID();
    await prisma.purchase.create({
      data: { purchaseId, accountId, product: "vip", sku: "vip_month", priceStars: 700, chargedStars: 700, mode: "live", status: "paid", telegramChargeId: `charge-${purchaseId}`, invoicedAt: NOW, paidAt: NOW, renewalOf },
    });
    return purchaseId;
  }

  describe("база", () => {
    it("в перечислении покупок есть vip_gift; подарок и заказ — отдельные таблицы с ключом по покупке", async () => {
      const values = await prisma.$queryRaw<{ value: string }[]>`SELECT e.enumlabel AS value FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'PurchaseProduct'`;
      expect(values.map((row) => row.value)).toContain("vip_gift");
      const columns = await prisma.$queryRaw<{ table_name: string; column_name: string; is_nullable: string }[]>`
        SELECT table_name, column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name IN ('vip_gift', 'vip_gift_order') ORDER BY table_name, ordinal_position`;
      const byTable = (table: string) => columns.filter((column) => column.table_name === table).map((column) => `${column.column_name}:${column.is_nullable}`);
      expect(byTable("vip_gift")).toEqual(["purchase_id:NO", "giver_account_id:NO", "recipient_account_id:NO", "starts_at:NO", "ends_at:NO", "revoked_at:YES", "created_at:NO"]);
      expect(byTable("vip_gift_order")).toEqual(["purchase_id:NO", "recipient_account_id:NO", "created_at:NO"]);
      const indexes = await prisma.$queryRaw<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'vip_gift'`;
      expect(indexes.map((row) => row.indexdef).join("\n")).toMatch(/\(recipient_account_id, ends_at\)/);
    });

    it("база не примет срок нулевой длины", async () => {
      const giver = await player();
      const recipient = await player();
      const purchaseId = await paidVip(giver.accountId);
      await expect(
        prisma.$executeRaw`
          INSERT INTO vip_gift (purchase_id, giver_account_id, recipient_account_id, starts_at, ends_at, created_at)
          VALUES (${purchaseId}::uuid, ${giver.accountId}::uuid, ${recipient.accountId}::uuid, ${NOW}, ${NOW}, now())`,
      ).rejects.toThrow();
    });
  });

  describe("заказ: счёт за звёзды", () => {
    it("другу — счёт на 700 звёзд; получатель записан в заказ на сервере, текст счёта называет его", async () => {
      const ctx = stack();
      const giver = await player("Дарящий");
      const friend = await player("Получатель");
      await friends(giver, friend);

      const invoice = await ctx.gifts.order(giver.ref, friend.publicId);

      expect(invoice).toMatchObject({ sku: "vip_gift", status: "pending", priceStars: PRICE, chargedStars: PRICE, mode: "live" });
      expect(invoice.invoiceUrl).toMatch(/^https:\/\//);
      const purchase = await purchases.byId(invoice.purchaseId);
      expect(purchase).toMatchObject({ accountId: giver.accountId, product: "vip_gift", sku: "vip_gift", status: "pending", renewalOf: null });
      const [order] = await prisma.$queryRaw<{ recipient: string }[]>`SELECT recipient_account_id::text AS recipient FROM vip_gift_order WHERE purchase_id = ${invoice.purchaseId}::uuid`;
      expect(order?.recipient).toBe(friend.accountId);
      expect(ctx.api.sent.at(-1)?.description).toContain("Получатель");
      expect(ctx.api.sent.at(-1)?.title.length).toBeLessThanOrEqual(32);
    });

    it("не друг и несуществующий публичный id — 409 vip_gift_not_friend, счёт не создан", async () => {
      const ctx = stack();
      const giver = await player();
      const stranger = await player();

      for (const publicId of [stranger.publicId, "000000000000"]) {
        const error = await failure(ctx.gifts.order(giver.ref, publicId));
        expect(error).toMatchObject({ code: "vip_gift_not_friend", status: 409 });
      }
      expect(await purchaseCount(giver.accountId)).toBe(0);
    });

    it("заявка в друзья без ответа дружбой не считается", async () => {
      const ctx = stack();
      const [giver, other] = [await player(), await player()];
      await friendsRepository.request(giver.accountId, other.accountId, { maxOutgoing: 50, maxIncoming: 50 });

      expect(await failure(ctx.gifts.order(giver.ref, other.publicId))).toMatchObject({ code: "vip_gift_not_friend", status: 409 });
    });

    it("себе — 409 vip_gift_self", async () => {
      const ctx = stack();
      const giver = await player();
      expect(await failure(ctx.gifts.order(giver.ref, giver.publicId))).toMatchObject({ code: "vip_gift_self", status: 409 });
      expect(await purchaseCount(giver.accountId)).toBe(0);
    });

    it("заблокированному другу — 409 vip_gift_blocked; заблокированный не друг отвечает как не друг", async () => {
      const ctx = stack();
      const giver = await player();
      const friend = await player();
      const stranger = await player();
      await friends(giver, friend);
      await prisma.account.updateMany({ where: { accountId: { in: [friend.accountId, stranger.accountId] } }, data: { bannedAt: NOW, banReason: "тест" } });

      expect(await failure(ctx.gifts.order(giver.ref, friend.publicId))).toMatchObject({ code: "vip_gift_blocked", status: 409 });
      expect(await failure(ctx.gifts.order(giver.ref, stranger.publicId))).toMatchObject({ code: "vip_gift_not_friend", status: 409 });
      expect(await purchaseCount(giver.accountId)).toBe(0);
    });

    it("у дарящего закрыты покупки — отказ до счёта", async () => {
      const ctx = stack();
      const giver = await player();
      const friend = await player();
      await friends(giver, friend);
      await ctx.restrictionsRepository.impose([{ accountId: giver.accountId, kind: "purchases", startsAt: new Date(Date.now() - DAY), endsAt: null, reason: "тест", comment: null, notify: true, imposedBy: null }], new Date());

      const error = await failure(ctx.gifts.order(giver.ref, friend.publicId));

      expect(error.status).toBeGreaterThanOrEqual(400);
      expect(error.code).not.toBe("vip_gift_not_friend");
      expect(await purchaseCount(giver.accountId)).toBe(0);
    });

    it("каждый заказ — новая покупка: два заказа одному другу — два счёта, получатель записан в каждый", async () => {
      const ctx = stack();
      const giver = await player();
      const friend = await player();
      await friends(giver, friend);

      const first = await ctx.gifts.order(giver.ref, friend.publicId);
      const second = await ctx.gifts.order(giver.ref, friend.publicId);

      expect(first.purchaseId).not.toBe(second.purchaseId);
      expect(await prisma.vipGiftOrder.count({ where: { purchaseId: { in: [first.purchaseId, second.purchaseId] } } })).toBe(2);
    });

    it.skipIf(REDIS_URL === "")("шестой заказ за сутки — 429, пять первых проходят; лимит у каждого дарящего свой", async () => {
      if (redis === null) throw new Error("нужен Redis");
      const ctx = stack({ limiter: new RateLimiter(redis) });
      const giver = await player();
      const other = await player();
      const friend = await player();
      await friends(giver, friend);
      await friends(other, friend);

      for (let index = 0; index < VIP_GIFT_DAY_LIMIT; index += 1) await ctx.gifts.order(giver.ref, friend.publicId);
      const sixth = await failure(ctx.gifts.order(giver.ref, friend.publicId));

      expect(sixth).toMatchObject({ code: "rate_limited", status: 429 });
      expect(await purchaseCount(giver.accountId)).toBe(VIP_GIFT_DAY_LIMIT);
      await expect(ctx.gifts.order(other.ref, friend.publicId)).resolves.toMatchObject({ status: "pending" });
    });

    it("отказ проверки не тратит суточный лимит: пять отказов подряд, потом пять заказов проходят", async () => {
      let consumed = 0;
      const ctx = stack({ limiter: { consume: async () => ((consumed += 1), true) } });
      const giver = await player();
      const stranger = await player();
      const friend = await player();
      await friends(giver, friend);

      for (let index = 0; index < 5; index += 1) await failure(ctx.gifts.order(giver.ref, stranger.publicId));
      expect(consumed).toBe(0);
      await ctx.gifts.order(giver.ref, friend.publicId);
      expect(consumed).toBe(1);
    });
  });

  describe("выдача", () => {
    it("оплата через очередь: получатель получает VIP на 30 дней и уведомление; повтор подтверждения ничего не добавляет", async () => {
      const ctx = stack();
      const giver = await player("Дарящий");
      const friend = await player("Получатель");
      await friends(giver, friend);
      const invoice = await ctx.gifts.order(giver.ref, friend.publicId);
      const confirm = () =>
        ctx.queue.process({
          data: { kind: "confirm", payment: { platform: "telegram", chargeId: `charge-queue-${invoice.purchaseId}`, payload: invoice.purchaseId, payerId: giver.platformUserId, currency: "XTR", totalAmount: PRICE } },
        });

      const before = Date.now();
      await confirm();
      const after = Date.now();

      const [window] = await windowsOf(friend.accountId);
      expect(window).toBeDefined();
      if (window === undefined) return;
      expect(window.startsAt).toBeGreaterThanOrEqual(before);
      expect(window.startsAt).toBeLessThanOrEqual(after);
      expect(window.endsAt - window.startsAt).toBe(30 * DAY);
      expect(window.revokedAt).toBeNull();
      expect(await ctx.vip.activeAt(friend.accountId, new Date())).toBe(true);
      expect(await ctx.vip.activeAt(giver.accountId, new Date())).toBe(false);
      expect(await purchases.byId(invoice.purchaseId)).toMatchObject({ status: "paid", fulfilledAt: expect.any(Date) });

      const sent = await notices(friend.accountId);
      expect(sent).toHaveLength(1);
      expect(NOTIFICATION_KINDS.vip_gift.parse(sent[0]?.payload)).toEqual({ fromName: "Дарящий", days: 30 });
      expect(await notices(giver.accountId)).toHaveLength(0);

      await confirm();
      expect(await windowsOf(friend.accountId)).toEqual([window]);
      expect(await notices(friend.accountId)).toHaveLength(1);
    });

    it("повторная выдача той же покупки — тот же срок, без второго срока и второго уведомления", async () => {
      const ctx = stack();
      const giver = await player("Дарящий");
      const friend = await player();
      await friends(giver, friend);
      const purchase = await paidGift(ctx, giver, friend);

      await ctx.gifts.fulfill(purchase, NOW);
      const first = await windowsOf(friend.accountId);
      await ctx.gifts.fulfill(purchase, at(3));
      await ctx.gifts.fulfill(purchase, at(10));

      expect(first).toEqual([{ startsAt: NOW.getTime(), endsAt: at(30).getTime(), revokedAt: null }]);
      expect(await windowsOf(friend.accountId)).toEqual(first);
      expect(await notices(friend.accountId)).toHaveLength(1);
      expect(await prisma.vipGift.count({ where: { purchaseId: purchase.purchaseId } })).toBe(1);
    });

    it("десять выдач одной покупки разом — одна строка и одно уведомление", async () => {
      const ctx = stack();
      const giver = await player();
      const friend = await player();
      await friends(giver, friend);
      const purchase = await paidGift(ctx, giver, friend);

      await Promise.all(Array.from({ length: 10 }, () => ctx.gifts.fulfill(purchase, NOW)));

      expect(await windowsOf(friend.accountId)).toHaveLength(1);
      expect(await notices(friend.accountId)).toHaveLength(1);
    });

    it("получатель берётся из заказа на сервере: покупки без записи заказа подарок не выдаётся никому", async () => {
      const ctx = stack();
      const giver = await player();
      const friend = await player();
      const orphan = randomUUID();
      await prisma.purchase.create({
        data: { purchaseId: orphan, accountId: giver.accountId, product: "vip_gift", sku: "vip_gift", priceStars: PRICE, chargedStars: PRICE, mode: "live", status: "paid", telegramChargeId: `charge-${orphan}`, invoicedAt: NOW, paidAt: NOW },
      });
      const purchase = await purchases.byId(orphan);
      if (purchase === null) throw new Error("покупки нет");

      await expect(ctx.gifts.fulfill(purchase, NOW)).rejects.toThrow();

      for (const who of [giver, friend]) expect(await windowsOf(who.accountId)).toEqual([]);
      expect(await prisma.vipGift.count({ where: { purchaseId: orphan } })).toBe(0);
    });

    it("перестали дружить между оплатой и подтверждением — подарок выдаётся: оплачено", async () => {
      const ctx = stack();
      const giver = await player("Дарящий");
      const friend = await player();
      await friends(giver, friend);
      const purchase = await paidGift(ctx, giver, friend);
      await friendsRepository.remove(giver.accountId, friend.accountId);
      expect(await friendsRepository.areFriends(giver.accountId, friend.accountId)).toBe(false);

      await ctx.gifts.fulfill(purchase, NOW);

      expect(await ctx.vip.activeAt(friend.accountId, NOW)).toBe(true);
      expect(await notices(friend.accountId)).toHaveLength(1);
    });

    it("получатель заблокирован после заказа — подарок всё равно выдан", async () => {
      const ctx = stack();
      const giver = await player();
      const friend = await player();
      await friends(giver, friend);
      const purchase = await paidGift(ctx, giver, friend);
      await prisma.account.update({ where: { accountId: friend.accountId }, data: { bannedAt: NOW, banReason: "тест" } });

      await ctx.gifts.fulfill(purchase, NOW);

      expect(await windowsOf(friend.accountId)).toHaveLength(1);
    });

    it("подарок не оплачен — не выдаётся", async () => {
      const ctx = stack();
      const giver = await player();
      const friend = await player();
      await friends(giver, friend);
      const invoice = await ctx.gifts.order(giver.ref, friend.publicId);
      const pending = await purchases.byId(invoice.purchaseId);
      if (pending === null) throw new Error("покупки нет");

      await expect(ctx.gifts.fulfill(pending, NOW)).rejects.toThrow();

      expect(await windowsOf(friend.accountId)).toEqual([]);
    });

    it("имя дарящего в уведомлении — копия не длиннее 64 знаков", async () => {
      const ctx = stack();
      const giver = await player("Очень длинное имя дарящего, которое не должно ломать строку ленты уведомлений совсем");
      const friend = await player();
      await friends(giver, friend);

      await ctx.gifts.fulfill(await paidGift(ctx, giver, friend), NOW);

      const [sent] = await notices(friend.accountId);
      const payload = NOTIFICATION_KINDS.vip_gift.parse(sent?.payload);
      expect(payload.fromName.length).toBeLessThanOrEqual(64);
      expect(payload.fromName.startsWith("Очень длинное имя")).toBe(true);
    });

    it("получатель узнаёт подарок даже если уведомление не легло с первого раза: повтор выдачи пишет его, не удваивая срок", async () => {
      const giver = await player("Дарящий");
      const friend = await player();
      const ctx = stack();
      await friends(giver, friend);
      const purchase = await paidGift(ctx, giver, friend);
      const failing = new NotificationsService(new PrismaNotificationsRepository(prisma));
      const spy = vi.spyOn(failing, "deliver").mockRejectedValueOnce(new Error("база недоступна"));
      const broken = new VipGiftService(
        new PaymentsService(settings, purchases, new MemoryRunsRepository(), starsProviders(new FakeStarsApi()), switchesOf(settings)),
        new PurchaseFulfillment(),
        new PurchaseRevocation(),
        accounts,
        friendsRepository,
        restrictionsGate(),
        failing,
        { consume: async () => true },
        giftRepository,
      );

      await expect(broken.fulfill(purchase, NOW)).rejects.toThrow("база недоступна");
      expect(await notices(friend.accountId)).toHaveLength(0);
      expect(await windowsOf(friend.accountId)).toHaveLength(1);

      await broken.fulfill(purchase, at(1));

      expect(spy).toHaveBeenCalledTimes(2);
      expect(await notices(friend.accountId)).toHaveLength(1);
      expect(await windowsOf(friend.accountId)).toEqual([{ startsAt: NOW.getTime(), endsAt: at(30).getTime(), revokedAt: null }]);
    });
  });

  describe("срок: отдельно от подписки, подарки встают в очередь", () => {
    it("второй подарок встаёт после первого; третий — после второго", async () => {
      const ctx = stack();
      const friend = await player();
      const givers = [await player(), await player(), await player()];
      for (const giver of givers) await friends(giver, friend);

      for (const [index, giver] of givers.entries()) await ctx.gifts.fulfill(await paidGift(ctx, giver, friend), at(index));

      expect(await windowsOf(friend.accountId)).toEqual([
        { startsAt: at(0).getTime(), endsAt: at(30).getTime(), revokedAt: null },
        { startsAt: at(30).getTime(), endsAt: at(60).getTime(), revokedAt: null },
        { startsAt: at(60).getTime(), endsAt: at(90).getTime(), revokedAt: null },
      ]);
      expect(await ctx.vip.activeAt(friend.accountId, at(75))).toBe(true);
      expect(await ctx.vip.activeAt(friend.accountId, at(90))).toBe(false);
    });

    it("подарки разом на один аккаунт встают цепочкой без наложений под гонкой", async () => {
      const ctx = stack();
      const friend = await player();
      const givers = await Promise.all(Array.from({ length: 6 }, () => player()));
      for (const giver of givers) await friends(giver, friend);
      const purchasesOf = [];
      for (const giver of givers) purchasesOf.push(await paidGift(ctx, giver, friend));

      await Promise.all(purchasesOf.map((purchase) => ctx.gifts.fulfill(purchase, NOW)));

      const windows = await windowsOf(friend.accountId);
      expect(windows).toHaveLength(6);
      expect(windows[0]?.startsAt).toBe(NOW.getTime());
      for (const [index, window] of windows.entries()) {
        expect(window.endsAt - window.startsAt).toBe(30 * DAY);
        if (index > 0) expect(window.startsAt).toBe(windows[index - 1]?.endsAt);
      }
      expect(await notices(friend.accountId)).toHaveLength(6);
    });

    it("у получателя активная подписка — подарок встаёт после конца текущего срока; продление подписки срок подарка не трогает", async () => {
      const ctx = stack();
      const giver = await player();
      const friend = await player();
      await friends(giver, friend);
      const subscription = await paidVip(friend.accountId);
      await vipRepository.addPeriod({ purchaseId: subscription, subscriptionId: subscription, accountId: friend.accountId, paidAt: at(-20), periodSec: VIP_PERIOD_SEC, at: at(-20) });
      // Подписка идёт ещё десять суток.
      expect((await vipRepository.state(friend.accountId, NOW)).until).toEqual(at(10));

      await ctx.gifts.fulfill(await paidGift(ctx, giver, friend), NOW);

      const gifted = await windowsOf(friend.accountId);
      expect(gifted).toEqual([{ startsAt: at(10).getTime(), endsAt: at(40).getTime(), revokedAt: null }]);
      expect(await ctx.vip.activeAt(friend.accountId, NOW)).toBe(true);
      expect(await ctx.vip.activeAt(friend.accountId, at(25))).toBe(true);
      expect(await ctx.vip.activeAt(friend.accountId, at(40))).toBe(false);

      // Подписка продлилась: её период встал за прежним, подарок остался где был.
      const renewal = await paidVip(friend.accountId, subscription);
      const period = await vipRepository.addPeriod({ purchaseId: renewal, subscriptionId: subscription, accountId: friend.accountId, paidAt: at(10), periodSec: VIP_PERIOD_SEC, at: at(10) });
      expect(period).toMatchObject({ startsAt: at(10), endsAt: at(40), created: true });
      expect(await windowsOf(friend.accountId)).toEqual(gifted);
      expect((await vipRepository.state(friend.accountId, at(10))).until).toEqual(at(40));
    });

    it("подарок не затирает подписку: её периоды те же, а оформленная после подарка подписка начинается со своей оплаты", async () => {
      const ctx = stack();
      const giver = await player();
      const friend = await player();
      await friends(giver, friend);
      await ctx.gifts.fulfill(await paidGift(ctx, giver, friend), NOW);
      expect(await prisma.vipPeriod.count({ where: { accountId: friend.accountId } })).toBe(0);

      const subscription = await paidVip(friend.accountId);
      const period = await vipRepository.addPeriod({ purchaseId: subscription, subscriptionId: subscription, accountId: friend.accountId, paidAt: at(5), periodSec: VIP_PERIOD_SEC, at: at(5) });

      expect(period).toMatchObject({ startsAt: at(5), endsAt: at(35) });
      expect(await windowsOf(friend.accountId)).toEqual([{ startsAt: NOW.getTime(), endsAt: at(30).getTime(), revokedAt: null }]);
    });

    it("подписка истекла давно — подарок идёт с момента выдачи", async () => {
      const ctx = stack();
      const giver = await player();
      const friend = await player();
      await friends(giver, friend);
      const subscription = await paidVip(friend.accountId);
      await vipRepository.addPeriod({ purchaseId: subscription, subscriptionId: subscription, accountId: friend.accountId, paidAt: at(-90), periodSec: VIP_PERIOD_SEC, at: at(-90) });

      await ctx.gifts.fulfill(await paidGift(ctx, giver, friend), NOW);

      expect(await windowsOf(friend.accountId)).toEqual([{ startsAt: NOW.getTime(), endsAt: at(30).getTime(), revokedAt: null }]);
    });

    it("состояние VIP у получателя: активен, до конца подарка; пока идёт подарок без продления — купить подписку можно", async () => {
      const ctx = stack();
      const giver = await player();
      const friend = await player();
      await friends(giver, friend);
      await ctx.gifts.fulfill(await paidGift(ctx, giver, friend), NOW);

      const view = await ctx.vip.view(friend.ref, at(5));

      expect(view).toMatchObject({ active: true, until: at(30), canOrder: true, renewal: null, canResume: false });
    });
  });

  describe("возврат забирает подаренный срок", () => {
    it("возврат до начала — срока нет вовсе; подписка получателя это не затрагивает", async () => {
      const ctx = stack();
      const giver = await player();
      const friend = await player();
      await friends(giver, friend);
      const subscription = await paidVip(friend.accountId);
      await vipRepository.addPeriod({ purchaseId: subscription, subscriptionId: subscription, accountId: friend.accountId, paidAt: at(-20), periodSec: VIP_PERIOD_SEC, at: at(-20) });
      const purchase = await paidGift(ctx, giver, friend);
      await ctx.gifts.fulfill(purchase, NOW);
      expect(await ctx.vip.activeAt(friend.accountId, at(15))).toBe(true);

      const revoked = await ctx.gifts.revoke(purchase, at(2));

      expect(revoked.lines.join(" ")).toMatch(/подар/i);
      expect(await ctx.vip.activeAt(friend.accountId, at(5))).toBe(true);
      expect(await ctx.vip.activeAt(friend.accountId, at(15))).toBe(false);
      expect(await ctx.vip.activeAt(friend.accountId, at(35))).toBe(false);
      expect((await vipRepository.state(friend.accountId, at(2))).until).toEqual(at(10));
    });

    it("возврат в середине срока — VIP обрывается сейчас; следующий подарок на своём месте", async () => {
      const ctx = stack();
      const friend = await player();
      const [first, second] = [await player(), await player()];
      await friends(first, friend);
      await friends(second, friend);
      const one = await paidGift(ctx, first, friend);
      const two = await paidGift(ctx, second, friend);
      await ctx.gifts.fulfill(one, NOW);
      await ctx.gifts.fulfill(two, NOW);
      const queued = (await windowsOf(friend.accountId)).map((window) => [window.startsAt, window.endsAt]);
      expect(queued).toEqual([
        [NOW.getTime(), at(30).getTime()],
        [at(30).getTime(), at(60).getTime()],
      ]);

      await ctx.gifts.revoke(one, at(10));

      const windows = await windowsOf(friend.accountId);
      expect(windows[0]).toEqual({ startsAt: NOW.getTime(), endsAt: at(30).getTime(), revokedAt: at(10).getTime() });
      // Следующий подарок не сдвинут ни на минуту.
      expect(windows[1]).toEqual({ startsAt: at(30).getTime(), endsAt: at(60).getTime(), revokedAt: null });
      expect(await ctx.vip.activeAt(friend.accountId, at(9))).toBe(true);
      expect(await ctx.vip.activeAt(friend.accountId, at(10))).toBe(false);
      expect(await ctx.vip.activeAt(friend.accountId, at(20))).toBe(false);
      expect(await ctx.vip.activeAt(friend.accountId, at(31))).toBe(true);
      expect(await ctx.vip.activeAt(friend.accountId, at(60))).toBe(false);
    });

    it("получателю уведомление о возврате не шлётся", async () => {
      const ctx = stack();
      const giver = await player();
      const friend = await player();
      await friends(giver, friend);
      const purchase = await paidGift(ctx, giver, friend);
      await ctx.gifts.fulfill(purchase, NOW);

      await ctx.gifts.revoke(purchase, at(5));

      expect(await prisma.notification.count({ where: { accountId: friend.accountId } })).toBe(1);
      expect(await prisma.notification.count({ where: { accountId: giver.accountId } })).toBe(0);
    });

    it("повторный возврат тот же срок не обрезает второй раз и время отзыва не меняет", async () => {
      const ctx = stack();
      const giver = await player();
      const friend = await player();
      await friends(giver, friend);
      const purchase = await paidGift(ctx, giver, friend);
      await ctx.gifts.fulfill(purchase, NOW);

      await ctx.gifts.revoke(purchase, at(5));
      const once = await windowsOf(friend.accountId);
      await ctx.gifts.revoke(purchase, at(8));
      await Promise.all([ctx.gifts.revoke(purchase, at(9)), ctx.gifts.revoke(purchase, at(11))]);

      expect(once).toEqual([{ startsAt: NOW.getTime(), endsAt: at(30).getTime(), revokedAt: at(5).getTime() }]);
      expect(await windowsOf(friend.accountId)).toEqual(once);
    });

    it("возврат раньше выдачи: выдача потом ложится уже отозванной, VIP не включается и уведомления нет", async () => {
      const ctx = stack();
      const giver = await player();
      const friend = await player();
      await friends(giver, friend);
      const purchase = await paidGift(ctx, giver, friend);

      const early = await ctx.gifts.revoke(purchase, at(1));
      expect(early.lines.length).toBeGreaterThan(0);
      expect(await windowsOf(friend.accountId)).toEqual([]);

      await prisma.purchase.update({ where: { purchaseId: purchase.purchaseId }, data: { status: "refunded", refundReason: "external", refundedAt: at(1) } });
      const refunded = await purchases.byId(purchase.purchaseId);
      if (refunded === null) throw new Error("покупки нет");
      await ctx.gifts.fulfill(refunded, at(2));

      const windows = await windowsOf(friend.accountId);
      expect(windows).toHaveLength(1);
      expect(windows[0]?.revokedAt).not.toBeNull();
      expect(await ctx.vip.activeAt(friend.accountId, at(3))).toBe(false);
      expect(await notices(friend.accountId)).toHaveLength(0);
    });

    it("внешний возврат звёзд (площадка) проходит через отзыв: срок обрывается, а поздняя выдача не включает VIP", async () => {
      const ctx = stack();
      const giver = await player("Дарящий");
      const friend = await player();
      await friends(giver, friend);
      const invoice = await ctx.gifts.order(giver.ref, friend.publicId);
      const chargeId = `charge-external-${invoice.purchaseId}`;
      await ctx.queue.process({ data: { kind: "confirm", payment: { platform: "telegram", chargeId, payload: invoice.purchaseId, payerId: giver.platformUserId, currency: "XTR", totalAmount: PRICE } } });
      expect(await ctx.vip.activeAt(friend.accountId, new Date())).toBe(true);

      await ctx.confirmation.refunded(chargeId, Date.now() + 60_000);

      expect(await ctx.vip.activeAt(friend.accountId, new Date(Date.now() + 120_000))).toBe(false);
      const [window] = await windowsOf(friend.accountId);
      expect(window?.revokedAt).not.toBeNull();
    });

    it("гонка отзыва и выдачи на одного получателя: итог один и тот же в любом порядке", async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const ctx = stack();
        const friend = await player();
        const [first, second] = [await player(), await player()];
        await friends(first, friend);
        await friends(second, friend);
        const one = await paidGift(ctx, first, friend);
        const two = await paidGift(ctx, second, friend);
        await ctx.gifts.fulfill(one, NOW);

        await Promise.all([ctx.gifts.revoke(one, at(5)), ctx.gifts.fulfill(two, NOW)]);

        const windows = await windowsOf(friend.accountId);
        expect(windows).toHaveLength(2);
        expect(windows[0]).toEqual({ startsAt: NOW.getTime(), endsAt: at(30).getTime(), revokedAt: at(5).getTime() });
        // Второй встал либо за первым, пока тот не был отозван, либо с момента выдачи: в обоих случаях ровно 30 суток.
        expect((windows[1]?.endsAt ?? 0) - (windows[1]?.startsAt ?? 0)).toBe(30 * DAY);
        expect(windows[1]?.revokedAt).toBeNull();
      }
    }, 60_000);
  });

  describe("всё, что зависит от VIP, видит подаренный срок", () => {
    function services() {
      const unused = {} as never;
      const rolesStub = { require: async () => undefined, audit: async () => undefined } as unknown as RolesService;
      const wallet = new WalletService(new PrismaWalletRepository(prisma), settings, new RolesService(settings, new MemoryRolesRepository(), new MemoryAccountRepository()));
      const tasks = new TasksService(new PrismaTasksRepository(prisma), wallet, new RunsHooks(), rolesStub, unused, unused, unused);
      const emblems = new EmblemsService(tasks, emblemsRepository, new PrismaAchievementsRepository(prisma), panelSettings());
      const appearance = new AppearanceService(tasks, new PrismaAppearanceRepository(prisma), emblemsRepository);
      return { emblems, appearance };
    }

    async function knyazHeld(appearance: AppearanceService, accountId: string, when: Date): Promise<boolean> {
      const view = await appearance.viewFor(accountId, when);
      return view.items.find((item) => item.id === "knyaz")?.held ?? false;
    }

    it("знак VIP, облик «Князь», награда дня VIP и самоцветы дня — на подаренном сроке; после возврата всё гаснет", async () => {
      const ctx = stack();
      const { emblems, appearance } = services();
      const giver = await player();
      const friend = await player();
      await friends(giver, friend);
      const purchase = await paidGift(ctx, giver, friend);
      await ctx.gifts.fulfill(purchase, NOW);
      const during = at(7);

      expect([...(await emblems.heldSpecial(friend.accountId, during))]).toContain(EMBLEM_IDS.vip);
      expect(await knyazHeld(appearance, friend.accountId, during)).toBe(true);
      expect(await ctx.bonuses.multiplier(friend.accountId, "daily_reward", during)).toBe(1.5);
      expect(await ctx.vip.claimDaily(friend.ref, during)).toMatchObject({ claimed: true, gems: 10 });
      expect(await ctx.vip.activeAt(friend.accountId, during)).toBe(true);

      // Другому знак и облик не достались.
      expect([...(await emblems.heldSpecial(giver.accountId, during))]).not.toContain(EMBLEM_IDS.vip);
      expect(await knyazHeld(appearance, giver.accountId, during)).toBe(false);
      expect(await ctx.bonuses.multiplier(giver.accountId, "daily_reward", during)).toBe(1);

      const gone = at(31);
      expect([...(await emblems.heldSpecial(friend.accountId, gone))]).not.toContain(EMBLEM_IDS.vip);
      expect(await knyazHeld(appearance, friend.accountId, gone)).toBe(false);
      expect(await ctx.bonuses.multiplier(friend.accountId, "daily_reward", gone)).toBe(1);
      await expect(ctx.vip.claimDaily(friend.ref, gone)).rejects.toMatchObject({ code: "vip_inactive" });
    });

    it("возврат посреди срока: знак и облик уходят сразу, а подарок, который ещё не начался, знак не даёт", async () => {
      const ctx = stack();
      const { emblems, appearance } = services();
      const friend = await player();
      const [first, second] = [await player(), await player()];
      await friends(first, friend);
      await friends(second, friend);
      const one = await paidGift(ctx, first, friend);
      const two = await paidGift(ctx, second, friend);
      await ctx.gifts.fulfill(one, NOW);
      await ctx.gifts.fulfill(two, NOW);

      // Второй ещё не начался, а первый идёт.
      expect([...(await emblems.heldSpecial(friend.accountId, at(5)))]).toContain(EMBLEM_IDS.vip);
      await ctx.gifts.revoke(one, at(10));

      expect([...(await emblems.heldSpecial(friend.accountId, at(15)))]).not.toContain(EMBLEM_IDS.vip);
      expect(await knyazHeld(appearance, friend.accountId, at(15))).toBe(false);
      expect([...(await emblems.heldSpecial(friend.accountId, at(31)))]).toContain(EMBLEM_IDS.vip);
      expect(await knyazHeld(appearance, friend.accountId, at(31))).toBe(true);
    });

    it("список знаков и проход редкости считают подарок так же, как чтение у одного игрока", async () => {
      const ctx = stack();
      const giver = await player();
      const friend = await player();
      const idle = await player();
      await friends(giver, friend);
      await ctx.gifts.fulfill(await paidGift(ctx, giver, friend), NOW);

      const until = await emblemsRepository.vipUntil([friend.accountId, idle.accountId, giver.accountId], at(3));
      expect(until.get(friend.accountId)).toEqual(at(30));
      expect(until.has(idle.accountId)).toBe(false);

      const sql = emblemHoldersSql(at(3));
      const rows = await prisma.$queryRaw<{ task_id: string; holders: number }[]>`
        WITH pop (account_id) AS (SELECT account_id FROM account WHERE account_id = ANY(${[friend.accountId, idle.accountId, giver.accountId]}::uuid[]))
        ${sql}`;
      expect(rows.find((row) => row.task_id === EMBLEM_IDS.vip)?.holders).toBe(1);
    });
  });

  describe("закрытие месяца пасса и подарок", () => {
    it("кто был с VIP в промежутке — по периодам и по подаренному сроку; отозванный до начала не в счёт", async () => {
      const ctx = stack();
      const friend = await player();
      const revokedFirst = await player();
      const nobody = await player();
      const giver = await player();
      await friends(giver, friend);
      await friends(giver, revokedFirst);
      await ctx.gifts.fulfill(await paidGift(ctx, giver, friend), NOW);
      const toRevoke = await paidGift(ctx, giver, revokedFirst);
      await ctx.gifts.fulfill(toRevoke, NOW);
      await ctx.gifts.revoke(toRevoke, NOW);

      const holders = await vipRepository.withVipDuring?.([friend.accountId, revokedFirst.accountId, nobody.accountId], at(10), at(20));

      expect(holders === undefined ? [] : [...holders]).toEqual([friend.accountId]);
    });
  });
});
