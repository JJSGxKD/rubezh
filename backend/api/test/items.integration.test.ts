import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { INVENTORY_CAP, type ItemRarity, type ItemSlot } from "../src/modules/items/item-catalog.js";
import { loadoutKey, verifyLoadout } from "../src/modules/items/item-loadout.js";
import { itemModifiers, rollItem, rollLoot, salvageYield, seededRandom } from "../src/modules/items/item-rules.js";
import { PrismaItemsRepository } from "../src/modules/items/items.repository.js";
import { ItemsService } from "../src/modules/items/items.service.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import type { WalletResource } from "../src/modules/wallet/wallet-types.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Снаряжение на живом Postgres с настоящим кошельком (docs/17-testing-strategy.md
 * §4.2; адрес — TEST_DATABASE_URL, без него пропуск). Критерии приёмки WP7:
 * заплатил — значит, предмет изменился, и наоборот; повтор с тем же ключом
 * ничего не удваивает; добыча забега выдаётся один раз; чужой предмет
 * неотличим от несуществующего.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const SECRET = "ab".repeat(32);
const RACE_TIMEOUT_MS = 30_000;

describe.skipIf(DATABASE_URL === "")("снаряжение на живом Postgres", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let wallet: WalletService;
  let repository: PrismaItemsRepository;
  let items: ItemsService;
  let seed = 1;

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(740_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Арсенал", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  /** Предмет в обход добычи — ради заданной редкости и слота. */
  async function give(accountId: string, slot: ItemSlot, rarity: ItemRarity, level = 1): Promise<string> {
    const outcome = await repository.create(accountId, `test:${randomUUID()}`, new Date(), () => ({
      slot,
      rarity,
      level,
      seed: 7,
      rolls: rollItem(seededRandom(7), slot, rarity),
      source: "test",
    }));
    if (outcome === null) throw new Error("предмет не создан");
    return outcome.item.itemId;
  }

  async function fund(accountId: string, resource: WalletResource, amount: number): Promise<void> {
    const reason = resource === "coins" ? "run_reward" : "salvage";
    await wallet.grant({ accountId, resource, amount, reason, idempotencyKey: `test:${randomUUID()}` });
  }

  const balance = async (accountId: string, resource: WalletResource) => (await wallet.balances(accountId))[resource];
  const events = (itemId: string) => prisma.itemEvent.count({ where: { itemId } });

  /** Зерно, на котором правила обещают добычу, — чтобы тест не зависел от шанса. */
  function droppingSeed(survivalSec: number): number {
    for (let candidate = 1; ; candidate++) {
      const loot = rollLoot(seededRandom(candidate), { survivalSec, difficultyId: "easy", accountLevel: 1, verdict: "ok", replayVerified: false });
      if (loot !== null) return candidate;
    }
  }

  const loot = (accountId: string, patch: Partial<Parameters<ItemsService["dropForRun"]>[0]> = {}) => ({
    accountId,
    runId: randomUUID(),
    survivalSec: 600,
    difficultyId: "easy",
    verdict: "ok" as const,
    at: new Date(),
    ...patch,
  });

  beforeAll(() => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, JWT_ACCESS_SECRET: SECRET } as NodeJS.ProcessEnv);
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 20, connectionTimeoutMillis: 30_000 }) });
    accounts = new PrismaAccountRepository(prisma);
    const roles = new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository());
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, roles);
    repository = new PrismaItemsRepository(prisma);
    items = new ItemsService(repository, wallet, config, () => seed);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("добыча забега", () => {
    it("выпадает то, что обещали правила, и один раз на забег — даже под гонкой", async () => {
      const id = await account();
      seed = droppingSeed(600);
      const run = loot(id);
      const expected = rollLoot(seededRandom(seed), { ...run, accountLevel: 1, replayVerified: false });

      const results = await Promise.all(Array.from({ length: 10 }, () => items.dropForRun(run)));

      const inventory = await items.inventory(id);
      expect(inventory.items).toHaveLength(1);
      expect(inventory.items[0]).toMatchObject({ slot: expected?.slot, rarity: expected?.rarity, level: expected?.level });
      expect(new Set(results.map((item) => item?.itemId)).size).toBe(1);
    }, RACE_TIMEOUT_MS);

    it("отклонённый забег ничего не даёт", async () => {
      const id = await account();
      seed = droppingSeed(600);
      expect(await items.dropForRun(loot(id, { verdict: "rejected" }))).toBeNull();
      expect((await items.inventory(id)).items).toHaveLength(0);
    });

    it("полный инвентарь выпавшее не теряет — разбирает его в осколки", async () => {
      const id = await account();
      for (let n = 0; n < INVENTORY_CAP; n++) await give(id, "boots", "common");
      seed = droppingSeed(600);

      const dropped = await items.dropForRun(loot(id));

      expect(dropped).not.toBeNull();
      const shard = `shard_${dropped?.rarity ?? "common"}` as WalletResource;
      expect(await balance(id, shard)).toBe(dropped === null ? 0 : salvageYield(dropped));
      expect((await items.inventory(id)).items).toHaveLength(INVENTORY_CAP);
    }, RACE_TIMEOUT_MS);
  });

  describe("надеть и снять", () => {
    it("в слоте один надетый, снимок подписан и повторяет надетое", async () => {
      const id = await account();
      const first = await give(id, "weapon", "rare");
      const second = await give(id, "weapon", "uncommon");
      const boots = await give(id, "boots", "common");

      await items.equip(id, first);
      await items.equip(id, boots);
      await items.equip(id, second);

      const inventory = await items.inventory(id);
      expect(inventory.equipped).toEqual({ weapon: second, boots });
      const snapshot = await items.loadout(id);
      const worn = (await repository.alive(id)).filter((item) => item.equipped);
      const expected: Record<string, number> = {};
      for (const item of worn) for (const [stat, value] of Object.entries(itemModifiers(item))) expected[stat] = (expected[stat] ?? 0) + value;
      expect(Object.keys(snapshot.modifiers).sort()).toEqual(Object.keys(expected).sort());
      expect(verifyLoadout(loadoutKey(SECRET), snapshot)).toBe(true);
      expect(verifyLoadout(loadoutKey(SECRET), { ...snapshot, modifiers: { ...snapshot.modifiers, damage: 9 } })).toBe(false);

      await items.unequip(id, second);
      expect((await items.inventory(id)).equipped).toEqual({ boots });
    });

    it("чужой предмет неотличим от несуществующего", async () => {
      const owner = await account();
      const stranger = await account();
      const itemId = await give(owner, "belt", "common");
      await expect(items.equip(stranger, itemId)).rejects.toMatchObject({ code: "item_not_found" });
      await expect(items.salvage(stranger, itemId, randomUUID())).rejects.toMatchObject({ code: "item_not_found" });
      await expect(items.equip(owner, randomUUID())).rejects.toMatchObject({ code: "item_not_found" });
    });
  });

  describe("улучшение", () => {
    it("не хватило — не списано ничего, и предмет тот же", async () => {
      const id = await account();
      const itemId = await give(id, "armor", "common");
      await fund(id, "coins", 1_000);

      await expect(items.upgrade(id, itemId, randomUUID())).rejects.toMatchObject({ code: "insufficient_funds", resource: "shard_common", balance: 0 });

      expect(await balance(id, "coins")).toBe(1_000);
      expect((await items.inventory(id)).items[0]?.level).toBe(1);
      expect(await events(itemId)).toBe(1);
    });

    it("повтор с тем же ключом не списывает дважды", async () => {
      const id = await account();
      const itemId = await give(id, "armor", "common");
      await fund(id, "coins", 1_000);
      await fund(id, "shard_common", 10);
      const key = randomUUID();

      const cost = (await items.inventory(id)).items[0]?.upgrade;
      await Promise.all(Array.from({ length: 5 }, () => items.upgrade(id, itemId, key)));

      expect((await items.inventory(id)).items[0]?.level).toBe(2);
      expect(await balance(id, "coins")).toBe(1_000 - (cost?.coins ?? 0));
      expect(await balance(id, "shard_common")).toBe(10 - (cost?.shards ?? 0));
    }, RACE_TIMEOUT_MS);

    it("параллельные улучшения разными ключами упираются в деньги и потолок, а не в минус", async () => {
      const id = await account();
      const itemId = await give(id, "armor", "common");
      // С первого уровня до потолка аккаунта первого уровня (6) — 40+80+120+160+200 монет
      await fund(id, "coins", 400);
      await fund(id, "shard_common", 50);

      const results = await Promise.allSettled(Array.from({ length: 8 }, () => items.upgrade(id, itemId, randomUUID())));

      const done = results.filter((result) => result.status === "fulfilled").length;
      // 40+80+120+160 = 400: ровно четыре улучшения, дальше не хватает
      expect(done).toBe(4);
      expect((await items.inventory(id)).items[0]?.level).toBe(5);
      expect(await balance(id, "coins")).toBe(0);
    }, RACE_TIMEOUT_MS);

    it("в потолке уровня аккаунта — отказ с кодом, без списания", async () => {
      const id = await account();
      const itemId = await give(id, "gloves", "common", 6);
      await fund(id, "coins", 10_000);
      await fund(id, "shard_common", 50);

      await expect(items.upgrade(id, itemId, randomUUID())).rejects.toMatchObject({ code: "item_max_level" });
      expect(await balance(id, "coins")).toBe(10_000);
    });
  });

  describe("перековка", () => {
    it("меняет одно свойство и берёт цену; у обычного перековывать нечего", async () => {
      const id = await account();
      const itemId = await give(id, "amulet", "rare");
      const plain = await give(id, "amulet", "common");
      await fund(id, "coins", 1_000);
      const before = (await repository.alive(id)).find((item) => item.itemId === itemId);
      const cost = (await items.inventory(id)).items.find((item) => item.itemId === itemId)?.reroll;

      seed = 424_242;
      await items.reroll(id, itemId, 1, randomUUID());

      const after = (await repository.alive(id)).find((item) => item.itemId === itemId);
      expect(after?.rolls.main).toEqual(before?.rolls.main);
      expect(after?.rolls.extras[0]).toEqual(before?.rolls.extras[0]);
      expect(await balance(id, "coins")).toBe(1_000 - (cost?.coins ?? 0));
      await expect(items.reroll(id, plain, 0, randomUUID())).rejects.toMatchObject({ code: "item_no_extra" });
    });
  });

  describe("разбор", () => {
    it("даёт осколки один раз и убирает предмет — повтор отвечает тем же", async () => {
      const id = await account();
      const itemId = await give(id, "boots", "epic", 5);
      await items.equip(id, itemId);
      const key = randomUUID();

      const first = await items.salvage(id, itemId, key);
      const again = await items.salvage(id, itemId, key);

      expect(first).toEqual({ shards: 6, resource: "shard_epic" });
      expect(again).toEqual(first);
      expect(await balance(id, "shard_epic")).toBe(6);
      expect((await items.inventory(id)).items).toHaveLength(0);
      await expect(items.salvage(id, itemId, randomUUID())).rejects.toMatchObject({ code: "item_not_found" });
    });
  });

  describe("объединение", () => {
    it("три одной редкости — в один следующей, надетое снимается, повтор не списывает", async () => {
      const id = await account();
      const ids = [await give(id, "weapon", "common", 3), await give(id, "belt", "common", 2), await give(id, "boots", "common")];
      await items.equip(id, ids[0] ?? "");
      await fund(id, "coins", 1_000);
      await fund(id, "shard_common", 20);
      const key = randomUUID();

      seed = 99;
      const merged = await items.merge(id, ids, key);
      const again = await items.merge(id, ids, key);

      expect(merged).toMatchObject({ rarity: "uncommon", level: 3, equipped: false });
      expect(again.itemId).toBe(merged.itemId);
      const inventory = await items.inventory(id);
      expect(inventory.items.map((item) => item.itemId)).toEqual([merged.itemId]);
      expect(inventory.equipped).toEqual({});
      expect(await balance(id, "coins")).toBe(900);
      expect(await balance(id, "shard_common")).toBe(15);
    });

    it("разные редкости и чужой предмет — отказ без списания", async () => {
      const id = await account();
      const other = await account();
      await fund(id, "coins", 1_000);
      await fund(id, "shard_common", 20);
      const mixed = [await give(id, "weapon", "common"), await give(id, "belt", "common"), await give(id, "boots", "rare")];
      const foreign = [await give(id, "weapon", "common"), await give(id, "belt", "common"), await give(other, "boots", "common")];

      await expect(items.merge(id, mixed, randomUUID())).rejects.toMatchObject({ code: "merge_mismatch" });
      await expect(items.merge(id, foreign, randomUUID())).rejects.toMatchObject({ code: "item_not_found" });
      await expect(items.merge(id, [mixed[0] ?? "", mixed[0] ?? "", mixed[1] ?? ""], randomUUID())).rejects.toMatchObject({ code: "validation_failed" });
      expect(await balance(id, "coins")).toBe(1_000);
      expect((await items.inventory(id)).items).toHaveLength(5);
    });

    it("легендарные не собираются — выше некуда", async () => {
      const id = await account();
      const ids = [await give(id, "weapon", "legendary"), await give(id, "belt", "legendary"), await give(id, "boots", "legendary")];
      await expect(items.merge(id, ids, randomUUID())).rejects.toMatchObject({ code: "merge_max_rarity" });
    });
  });
});
