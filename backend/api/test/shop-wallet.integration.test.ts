import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { loadAppConfig } from "../src/config/app-config.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { SHOP_SKUS, contentsOf } from "../src/modules/shop/shop-catalog.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Каталог магазина и настоящий кошелёк на живом Postgres (адрес —
 * TEST_DATABASE_URL, без него пропуск). Тест магазина подменяет кошелёк
 * заглушкой, поэтому расхождение «каталог продаёт то, чего кошелёк не
 * начислит за покупку» ловит только этот файл.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

describe.skipIf(DATABASE_URL === "")("каталог магазина и кошелёк на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let wallet: WalletService;

  beforeAll(() => {
    const config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 5, connectionTimeoutMillis: 30_000 }) });
    accounts = new PrismaAccountRepository(prisma);
    const roles = new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository());
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, roles);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("каждый товар каталога выдаётся настоящим кошельком, и повтор не удваивает", async () => {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(730_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Магазин", username: null },
      Date.now(),
    );
    const accountId = created.accountId;
    const grantAll = async (purchaseIds: Map<string, string>) => {
      const results = [];
      for (const sku of SHOP_SKUS) {
        const purchaseId = purchaseIds.get(sku.id) ?? "";
        for (const { resource, amount } of contentsOf(sku)) {
          results.push(
            await wallet.grant({ accountId, resource, amount, reason: "purchase", source: `shop:${sku.id}`, idempotencyKey: `purchase:${purchaseId}:${resource}` }),
          );
        }
      }
      return results;
    };
    const purchaseIds = new Map(SHOP_SKUS.map((sku) => [sku.id, randomUUID()]));
    const expectedGems = SHOP_SKUS.reduce((sum, sku) => sum + (sku.contents.gems ?? 0), 0);

    const first = await grantAll(purchaseIds);
    expect(first.every((result) => !result.duplicate)).toBe(true);
    expect((await wallet.balances(accountId)).gems).toBe(expectedGems);

    const again = await grantAll(purchaseIds);
    expect(again.every((result) => result.duplicate)).toBe(true);
    expect((await wallet.balances(accountId)).gems).toBe(expectedGems);
  });
});
