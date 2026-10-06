import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { INVENTORY_CAP } from "../src/modules/items/item-catalog.js";
import { rollItem, seededRandom } from "../src/modules/items/item-rules.js";
import { PrismaItemsRepository } from "../src/modules/items/items.repository.js";
import { ItemsService } from "../src/modules/items/items.service.js";
import { PrismaNotificationsRepository } from "../src/modules/notifications/notifications.repository.js";
import { NotificationsService } from "../src/modules/notifications/notifications.service.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { ShowcaseSoldError } from "../src/modules/shop/shop-errors.js";
import { PrismaShowcaseRepository } from "../src/modules/shop/showcase.repository.js";
import { ShowcaseService } from "../src/modules/shop/showcase.service.js";
import { InsufficientFundsError } from "../src/modules/wallet/wallet-errors.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Витрина на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск): сутки — московские, два первых
 * открытия разом выставляют одну витрину, покупка — предмет и списание
 * одной транзакцией, однажды и под гонкой; не хватило — ничего не списано.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const SECRET = "5c".repeat(32);

describe.skipIf(DATABASE_URL === "")("витрина на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let wallet: WalletService;
  let items: PrismaItemsRepository;
  let repository: PrismaShowcaseRepository;
  let showcase: ShowcaseService;
  let seed = 1;

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(830_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Витрина", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  const gems = async (accountId: string) => (await wallet.balances(accountId)).gems;
  const fund = (accountId: string, amount: number) => wallet.grant({ accountId, resource: "gems", amount, reason: "purchase", idempotencyKey: `test:${randomUUID()}` });

  beforeAll(() => {
    const config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, JWT_ACCESS_SECRET: SECRET, TELEGRAM_BOT_TOKEN: "1:TEST" } as NodeJS.ProcessEnv);
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 20, connectionTimeoutMillis: 30_000 }) });
    accounts = new PrismaAccountRepository(prisma);
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    items = new PrismaItemsRepository(prisma);
    const itemsService = new ItemsService(items, wallet, config, () => seed++, new NotificationsService(new PrismaNotificationsRepository(prisma)));
    repository = new PrismaShowcaseRepository(prisma);
    showcase = new ShowcaseService(repository, itemsService, () => seed++);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("сутки — московские: 23:59 и 00:01 по Москве — разные витрины; два первых открытия разом — одна", async () => {
    const me = await account();
    const lateEvening = new Date(Date.UTC(2026, 8, 30, 20, 59));
    const afterMidnight = new Date(Date.UTC(2026, 8, 30, 21, 1));
    const [first, second, third] = await Promise.all([showcase.view(me, lateEvening), showcase.view(me, lateEvening), showcase.view(me, lateEvening)]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    // витрина одного броска, а не смесь: слоты не повторяются
    expect(new Set(first.offers.map((offer) => offer.slot)).size).toBe(first.offers.length);
    expect((await repository.today(me, lateEvening)).gameDay).toBe("2026-09-30");

    const next = await showcase.view(me, afterMidnight);
    expect((await repository.today(me, afterMidnight)).gameDay).toBe("2026-10-01");
    expect(next.offers.map((offer) => offer.offerId)).not.toEqual(first.offers.map((offer) => offer.offerId));
    const [rows] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM showcase_offer WHERE account_id = ${me}::uuid`;
    expect(Number(rows?.n)).toBe(first.offers.length + next.offers.length);
  });

  it("покупка — тот же предмет, что на витрине, и списание одной транзакцией; повторы разом покупают однажды", async () => {
    const me = await account();
    const at = new Date();
    const offer = (await showcase.view(me, at)).offers[0];
    if (offer === undefined) throw new Error("витрина пуста");
    await fund(me, offer.gems + 5);

    const results = await Promise.allSettled([1, 2, 3].map(() => showcase.buy(me, offer.offerId, at)));
    const bought = results.filter((result) => result.status === "fulfilled");
    expect(bought.length).toBeGreaterThanOrEqual(1);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toBeInstanceOf(ShowcaseSoldError);
    expect(await gems(me)).toBe(5);

    const alive = await items.alive(me);
    expect(alive).toHaveLength(1);
    const [item] = alive;
    const [row] = await prisma.$queryRaw<{ seed: bigint; item_id: string }[]>`SELECT seed, item_id::text FROM showcase_offer WHERE offer_id = ${offer.offerId}::uuid`;
    expect(item).toMatchObject({ slot: offer.slot, rarity: offer.rarity, level: offer.level, source: `showcase:${offer.offerId}`, seenAt: expect.any(Date) });
    expect(item?.rolls).toEqual(rollItem(seededRandom(Number(row?.seed)), offer.slot, offer.rarity));
    expect(row?.item_id).toBe(item?.itemId);
    const ledger = await prisma.$queryRaw<{ reason: string; amount: bigint }[]>`
      SELECT reason::text, amount FROM wallet_entry WHERE account_id = ${me}::uuid AND resource = 'gems' AND amount < 0`;
    expect(ledger.map((entry) => ({ reason: entry.reason, amount: Number(entry.amount) }))).toEqual([{ reason: "shop", amount: -offer.gems }]);
  });

  it("не хватило самоцветов — ничего не списано и предмета нет; полный инвентарь — отказ до списания", async () => {
    const me = await account();
    const at = new Date();
    const offer = (await showcase.view(me, at)).offers[0];
    if (offer === undefined) throw new Error("витрина пуста");
    await fund(me, offer.gems - 1);
    await expect(showcase.buy(me, offer.offerId, at)).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await gems(me)).toBe(offer.gems - 1);
    expect(await items.alive(me)).toHaveLength(0);

    await fund(me, 1);
    for (let index = 0; index < INVENTORY_CAP; index++) {
      await items.create(me, `fill:${randomUUID()}`, at, () => ({ slot: "boots", rarity: "common", level: 1, seed: 1, rolls: rollItem(seededRandom(1), "boots", "common"), source: "test" }));
    }
    await expect(showcase.buy(me, offer.offerId, at)).rejects.toMatchObject({ code: "inventory_full" });
    expect(await gems(me)).toBe(offer.gems);
    expect((await repository.byId(me, offer.offerId))?.soldAt).toBeNull();
  });

  it("продано — значит, есть предмет; цена и уровень — в пределах: базу мимо сервиса не обойти", async () => {
    const me = await account();
    const offer = (await showcase.view(me, new Date())).offers[0];
    if (offer === undefined) throw new Error("витрина пуста");
    await expect(prisma.$executeRaw`UPDATE showcase_offer SET sold_at = now() WHERE offer_id = ${offer.offerId}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE showcase_offer SET price_gems = 0 WHERE offer_id = ${offer.offerId}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE showcase_offer SET level = 31 WHERE offer_id = ${offer.offerId}::uuid`).rejects.toThrow();
  });

  it("удалённый аккаунт уносит свою витрину", async () => {
    const me = await account();
    await showcase.view(me, new Date());
    await prisma.$executeRaw`DELETE FROM account WHERE account_id = ${me}::uuid`;
    const [left] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM showcase_offer WHERE account_id = ${me}::uuid`;
    expect(Number(left?.n)).toBe(0);
  });
});
