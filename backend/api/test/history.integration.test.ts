import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaHistoryRepository } from "../src/modules/history/history.repository.js";
import { HistoryService } from "../src/modules/history/history.service.js";
import type { HistoryEntry } from "../src/modules/history/history-types.js";
import { rollItem, seededRandom } from "../src/modules/items/item-rules.js";
import { PrismaItemsRepository } from "../src/modules/items/items.repository.js";
import { ItemsService } from "../src/modules/items/items.service.js";
import { PrismaNotificationsRepository } from "../src/modules/notifications/notifications.repository.js";
import { NotificationsService } from "../src/modules/notifications/notifications.service.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { PrismaRunsRepository } from "../src/modules/runs/runs.repository.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { WALLET_RESOURCES } from "../src/modules/wallet/wallet-types.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * История имущества на живом Postgres (docs/17-testing-strategy.md §4.2;
 * адрес — TEST_DATABASE_URL, без него пропуск). Критерий приёмки WP28:
 * история сходится с балансом по каждому ресурсу. И постраничность: журналы
 * сливаются по курсору без потерь и повторов, фильтр категорий — в запросе.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

describe.skipIf(DATABASE_URL === "")("история имущества на живом Postgres", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let wallet: WalletService;
  let itemsRepository: PrismaItemsRepository;
  let items: ItemsService;
  let history: HistoryService;

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(780_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "История", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  async function all(accountId: string, categories?: Parameters<HistoryService["history"]>[1], pageSize = 3): Promise<HistoryEntry[]> {
    const seen: HistoryEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await history.history(accountId, categories, cursor, pageSize);
      seen.push(...page.entries);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return seen;
  }

  beforeAll(() => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 10, connectionTimeoutMillis: 30_000 }) });
    accounts = new PrismaAccountRepository(prisma);
    const roles = new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository());
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, roles);
    itemsRepository = new PrismaItemsRepository(prisma);
    items = new ItemsService(itemsRepository, wallet, config, () => 7, new NotificationsService(new PrismaNotificationsRepository(prisma)));
    history = new HistoryService(new PrismaHistoryRepository(prisma));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("сходится с балансом по каждому ресурсу, а постраничность не теряет и не повторяет строки", async () => {
    const id = await account();
    await wallet.grant({ accountId: id, resource: "coins", amount: 500, reason: "run_reward", idempotencyKey: `t:${randomUUID()}` });
    await wallet.grant({ accountId: id, resource: "gems", amount: 12, reason: "level_reward", idempotencyKey: `t:${randomUUID()}` });
    await wallet.grant({ accountId: id, resource: "shard_common", amount: 40, reason: "salvage", idempotencyKey: `t:${randomUUID()}` });
    await wallet.spend({ accountId: id, lines: [{ resource: "coins", amount: 120 }, { resource: "gems", amount: 4 }], reason: "boost", idempotencyKey: `t:${randomUUID()}` });
    await wallet.grant({ accountId: id, resource: "coins", amount: 120, reason: "boost_refund", idempotencyKey: `t:${randomUUID()}` });
    const created = await itemsRepository.create(id, `t:${randomUUID()}`, new Date(), () => ({ slot: "weapon", rarity: "common", level: 1, seed: 7, rolls: rollItem(seededRandom(7), "weapon", "common"), source: "test" }));
    const itemId = created?.item.itemId ?? "";
    await items.upgrade(id, itemId, randomUUID());

    const entries = await all(id);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    const balances = await wallet.balances(id);
    for (const resource of WALLET_RESOURCES) {
      const sum = entries.filter((entry) => entry.kind === "wallet" && entry.resource === resource).reduce((total, entry) => total + (entry.kind === "wallet" ? entry.amount : 0), 0);
      expect(sum, resource).toBe(balances[resource]);
    }
    // Новые сверху.
    const times = entries.map((entry) => Date.parse(entry.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // Предмет: получение и улучшение до второго уровня.
    expect(entries.filter((entry) => entry.kind === "item").map((entry) => (entry.kind === "item" ? `${entry.event}:${String(entry.level)}` : ""))).toEqual(["upgraded:2", "obtained:1"]);
  });

  it("категории — в запросе: бусты — покупка и возврат, осколки — свои, чужого нет", async () => {
    const id = await account();
    const other = await account();
    await wallet.grant({ accountId: id, resource: "coins", amount: 300, reason: "run_reward", idempotencyKey: `t:${randomUUID()}` });
    await wallet.grant({ accountId: id, resource: "shard_rare", amount: 5, reason: "salvage", idempotencyKey: `t:${randomUUID()}` });
    await wallet.spend({ accountId: id, lines: [{ resource: "coins", amount: 150 }], reason: "boost", idempotencyKey: `t:${randomUUID()}` });
    await wallet.grant({ accountId: other, resource: "coins", amount: 999, reason: "run_reward", idempotencyKey: `t:${randomUUID()}` });

    const boosts = await all(id, ["boosts"], 1);
    expect(boosts.map((entry) => (entry.kind === "wallet" ? `${entry.reason}:${String(entry.amount)}` : entry.kind))).toEqual(["boost:-150"]);
    const shards = await all(id, ["shards"]);
    expect(shards.map((entry) => (entry.kind === "wallet" ? entry.resource : ""))).toEqual(["shard_rare"]);
    const currency = await all(id, ["currency"]);
    expect(currency.map((entry) => (entry.kind === "wallet" ? entry.amount : 0))).toEqual([300]);
    expect(await all(id, ["items"])).toEqual([]);
  });

  it("покупки за Stars — оплаченные, с отметкой возврата", async () => {
    const id = await account();
    const runId = randomUUID();
    await new PrismaRunsRepository(prisma).start({ runId, accountId: id, difficulty: "normal", startingWeaponId: "spark", contentHash: "abc", startedAt: new Date() });
    const base = { accountId: id, product: "continue_run" as const, runId, elapsedSec: 300, priceStars: 25, chargedStars: 25, mode: "live" as const, invoicedAt: new Date() };
    await prisma.purchase.create({ data: { ...base, purchaseId: randomUUID(), continueNo: 1, status: "paid", paidAt: new Date(Date.now() - 2_000) } });
    await prisma.purchase.create({ data: { ...base, purchaseId: randomUUID(), continueNo: 2, status: "refunded", paidAt: new Date(Date.now() - 1_000), refundedAt: new Date() } });
    await prisma.purchase.create({ data: { ...base, purchaseId: randomUUID(), continueNo: 3, status: "pending" } });

    const purchases = await all(id, ["purchases"]);
    expect(purchases.map((entry) => (entry.kind === "purchase" ? `${entry.product}:${String(entry.stars)}:${String(entry.refunded)}` : ""))).toEqual(["continue_run:25:true", "continue_run:25:false"]);
  });
});
