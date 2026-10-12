import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { Prisma, type PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { compensationGrantsSchema, type CompensationGrant } from "../src/modules/wipe/compensation-rules.js";
import { takeTesterSnapshot } from "../src/modules/wipe/tester-snapshot.js";
import type { WalletResource } from "../src/modules/wallet/wallet-types.js";

/**
 * Снимок компенсаций перед вайпом на настоящем Postgres (tasks/T-0040,
 * docs/35-stage4-plan.md, Р87). Адрес — TEST_DATABASE_URL; без него
 * пропускается.
 *
 * База тестов общая, а снимок читает все забеги и весь журнал кошелька, поэтому:
 * - каждый кейс идёт в транзакции, которая откатывается: чужие тесты строк
 *   компенсации не увидят, а снимок не оставит знак «Тестер» на их аккаунтах;
 * - уровень изоляции — RepeatableRead: что соседние тесты закоммитят после
 *   начала кейса, кейс не увидит, и «итоги до и после» складываются точно;
 * - проверяются только свои аккаунты и разница итогов до и после заведения
 *   своих данных, а не абсолютные числа.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const NOW = new Date(Date.UTC(2026, 9, 12, 12, 0, 0));

type Tx = Prisma.TransactionClient;

class Rollback extends Error {}

describe.skipIf(DATABASE_URL === "")("снимок компенсаций на живом Postgres", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    const config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Конфликт с соседним тестом общей базы: транзакция откатилась сама, кейс безопасно повторить. */
  function isConflict(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || error.code === "P2003");
  }

  /** Тело кейса в транзакции, которая в конце всегда откатывается. */
  async function rolledBack(body: (tx: Tx) => Promise<void>): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await prisma.$transaction(
          async (tx) => {
            await body(tx);
            throw new Rollback("откат");
          },
          { isolationLevel: "RepeatableRead", timeout: 60_000, maxWait: 15_000 },
        );
        return;
      } catch (error: unknown) {
        if (error instanceof Rollback) return;
        if (attempt < 3 && isConflict(error)) continue;
        throw error;
      }
    }
  }

  async function account(tx: Tx, patch: { testerAt?: Date } = {}): Promise<string> {
    const accountId = randomUUID();
    await tx.account.create({
      data: { accountId, platform: "telegram", platformUserId: `t${randomUUID().replaceAll("-", "").slice(0, 24)}`, displayName: "Стрелок", ...patch },
    });
    return accountId;
  }

  async function run(tx: Tx, accountId: string, patch: { status?: "started" | "finished"; cheats?: boolean } = {}): Promise<string> {
    const runId = randomUUID();
    const status = patch.status ?? "finished";
    await tx.run.create({
      data: {
        runId,
        accountId,
        status,
        difficulty: "normal",
        startingWeaponId: "knife",
        contentHash: "abc",
        cheats: patch.cheats ?? false,
        finishedAt: status === "finished" ? NOW : null,
      },
    });
    return runId;
  }

  async function level(tx: Tx, accountId: string, value: number): Promise<void> {
    await tx.accountProgress.create({ data: { accountId, level: value, updatedAt: NOW } });
  }

  interface PurchasePatch {
    mode?: "live" | "test";
    refundedAt?: Date;
    refundRequestedAt?: Date;
    paid?: boolean;
  }

  /** Купленный набор: покупка и строки журнала с ключами `purchase:<id>:<ресурс>`, как пишет магазин. */
  async function shopPurchase(tx: Tx, accountId: string, grants: Partial<Record<WalletResource, number>>, patch: PurchasePatch = {}): Promise<string> {
    const purchaseId = randomUUID();
    const refunded = patch.refundedAt !== undefined;
    await tx.purchase.create({
      data: {
        purchaseId,
        accountId,
        product: "shop_item",
        sku: "starter",
        priceStars: 50,
        chargedStars: 50,
        mode: patch.mode ?? "live",
        status: refunded ? "refunded" : "paid",
        telegramChargeId: randomUUID(),
        invoicedAt: NOW,
        paidAt: NOW,
        fulfilledAt: NOW,
        ...(refunded ? { refundReason: "external", refundedAt: patch.refundedAt } : {}),
        ...(patch.refundRequestedAt === undefined ? {} : { refundReason: "external", refundRequestedAt: patch.refundRequestedAt }),
      },
    });
    for (const [resource, amount] of Object.entries(grants)) {
      await entry(tx, accountId, resource as WalletResource, amount, { key: `purchase:${purchaseId}:${resource}` });
    }
    return purchaseId;
  }

  async function entry(tx: Tx, accountId: string, resource: WalletResource, amount: number, patch: { key?: string; reason?: string } = {}): Promise<void> {
    await tx.walletEntry.create({
      data: {
        entryId: randomUUID(),
        accountId,
        resource,
        amount: BigInt(amount),
        reason: patch.reason ?? "purchase",
        source: "shop:starter",
        idempotencyKey: patch.key ?? randomUUID(),
        createdAt: NOW,
      },
    });
  }

  /** Второй шанс за звёзды: у него нет строк в кошельке, только покупка. */
  async function continuePurchase(
    tx: Tx,
    accountId: string,
    runId: string,
    continueNo: number,
    stars: number,
    patch: PurchasePatch & { refundReason?: "unused" } = {},
  ): Promise<void> {
    const paid = patch.paid ?? true;
    await tx.purchase.create({
      data: {
        purchaseId: randomUUID(),
        accountId,
        product: "continue_run",
        runId,
        continueNo,
        elapsedSec: 100,
        priceStars: stars,
        chargedStars: stars,
        mode: patch.mode ?? "live",
        status: patch.refundedAt === undefined ? (paid ? "paid" : "pending") : "refunded",
        telegramChargeId: paid ? randomUUID() : null,
        invoicedAt: NOW,
        paidAt: paid ? NOW : null,
        ...(patch.refundedAt === undefined ? {} : { refundReason: patch.refundReason ?? "unused", refundedAt: patch.refundedAt }),
        ...(patch.refundRequestedAt === undefined ? {} : { refundReason: "unused", refundRequestedAt: patch.refundRequestedAt }),
      },
    });
  }

  const rowsOf = (tx: Tx, ids: string[]) => tx.testerCompensation.findMany({ where: { accountId: { in: ids } }, orderBy: { accountId: "asc" } });
  const testerAtOf = async (tx: Tx, id: string): Promise<Date | null> => (await tx.account.findUniqueOrThrow({ where: { accountId: id } })).testerAt;

  it("тестер 12-го уровня без покупок: строка с бонусом 60, пустые выдачи, знак «Тестер»", async () => {
    await rolledBack(async (tx) => {
      const id = await account(tx);
      await run(tx, id);
      await level(tx, id, 12);

      await takeTesterSnapshot(tx, NOW, { write: true });

      expect(await rowsOf(tx, [id])).toEqual([
        { accountId: id, tester: true, level: 12, bonusGems: 60, grants: [], continueStars: 0, snapshotAt: NOW, claimedAt: null },
      ]);
      expect(await testerAtOf(tx, id)).toEqual(NOW);
    });
  });

  it("тестер 80-го уровня получает потолок бонуса — 250", async () => {
    await rolledBack(async (tx) => {
      const id = await account(tx);
      await run(tx, id);
      await level(tx, id, 80);

      await takeTesterSnapshot(tx, NOW, { write: true });

      expect(await rowsOf(tx, [id])).toMatchObject([{ tester: true, level: 80, bonusGems: 250 }]);
    });
  });

  it("строки уровня нет — уровень первый, бонус 5", async () => {
    await rolledBack(async (tx) => {
      const id = await account(tx);
      await run(tx, id);

      await takeTesterSnapshot(tx, NOW, { write: true });

      expect(await rowsOf(tx, [id])).toMatchObject([{ tester: true, level: 1, bonusGems: 5 }]);
    });
  });

  it("забег только с читами или только начатый тестером не делает: строки нет, знака нет", async () => {
    await rolledBack(async (tx) => {
      const cheater = await account(tx);
      await run(tx, cheater, { cheats: true });
      const unfinished = await account(tx);
      await run(tx, unfinished, { status: "started" });

      await takeTesterSnapshot(tx, NOW, { write: true });

      expect(await rowsOf(tx, [cheater, unfinished])).toEqual([]);
      expect(await testerAtOf(tx, cheater)).toBeNull();
      expect(await testerAtOf(tx, unfinished)).toBeNull();
    });
  });

  it("забег с читами не мешает честному: тестер", async () => {
    await rolledBack(async (tx) => {
      const id = await account(tx);
      await run(tx, id, { cheats: true });
      await run(tx, id);

      await takeTesterSnapshot(tx, NOW, { write: true });

      expect(await rowsOf(tx, [id])).toMatchObject([{ tester: true }]);
    });
  });

  it("не тестер с купленным набором: строка без бонуса, выдача на 150 самоцветов, знака нет", async () => {
    await rolledBack(async (tx) => {
      const id = await account(tx);
      const purchaseId = await shopPurchase(tx, id, { gems: 150 });

      await takeTesterSnapshot(tx, NOW, { write: true });

      expect(await rowsOf(tx, [id])).toMatchObject([
        { tester: false, bonusGems: 0, level: 1, grants: [{ purchaseId, resource: "gems", amount: 150 }], continueStars: 0 },
      ]);
      expect(await testerAtOf(tx, id)).toBeNull();
    });
  });

  it("уровень записывается и у не тестера", async () => {
    await rolledBack(async (tx) => {
      const id = await account(tx);
      await level(tx, id, 7);
      await shopPurchase(tx, id, { gems: 10 });

      await takeTesterSnapshot(tx, NOW, { write: true });

      expect(await rowsOf(tx, [id])).toMatchObject([{ tester: false, level: 7, bonusGems: 0 }]);
    });
  });

  it("тестер с покупкой: бонус отдельно, выдачи отдельно", async () => {
    await rolledBack(async (tx) => {
      const id = await account(tx);
      await run(tx, id);
      await level(tx, id, 12);
      const purchaseId = await shopPurchase(tx, id, { gems: 150 });

      await takeTesterSnapshot(tx, NOW, { write: true });

      expect(await rowsOf(tx, [id])).toMatchObject([{ tester: true, bonusGems: 60, grants: [{ purchaseId, resource: "gems", amount: 150 }] }]);
    });
  });

  it("выдачи — по purchaseId, затем по ресурсу; все ресурсы покупки, а не только самоцветы", async () => {
    await rolledBack(async (tx) => {
      const id = await account(tx);
      const first = await shopPurchase(tx, id, { shard_rare: 2, gems: 150, coins: 400 });
      const second = await shopPurchase(tx, id, { gems: 20 });

      await takeTesterSnapshot(tx, NOW, { write: true });

      const expected: CompensationGrant[] = [
        ...(["coins", "gems", "shard_rare"] as const).map((resource) => ({ purchaseId: first, resource, amount: { coins: 400, gems: 150, shard_rare: 2 }[resource] })),
        { purchaseId: second, resource: "gems" as const, amount: 20 },
      ].sort((a, b) => (a.purchaseId === b.purchaseId ? (a.resource < b.resource ? -1 : 1) : a.purchaseId < b.purchaseId ? -1 : 1));
      const [row] = await rowsOf(tx, [id]);
      expect(compensationGrantsSchema.parse(row?.grants)).toEqual(expected);
    });
  });

  it("возвращённая, с заказанным возвратом и тестовая покупки в выдачи не попадают", async () => {
    await rolledBack(async (tx) => {
      const id = await account(tx);
      const kept = await shopPurchase(tx, id, { gems: 150 });
      await shopPurchase(tx, id, { gems: 300 }, { refundedAt: NOW });
      await shopPurchase(tx, id, { gems: 500 }, { refundRequestedAt: NOW });
      await shopPurchase(tx, id, { gems: 700 }, { mode: "test" });

      await takeTesterSnapshot(tx, NOW, { write: true });

      expect(await rowsOf(tx, [id])).toMatchObject([{ grants: [{ purchaseId: kept, resource: "gems", amount: 150 }] }]);
    });
  });

  it("строки журнала, не бывшие выдачей покупки, не считаются", async () => {
    await rolledBack(async (tx) => {
      const id = await account(tx);
      const kept = await shopPurchase(tx, id, { gems: 150 });
      // Самоцветы дня VIP (Р87): награда за дни подписки, а не покупка.
      await entry(tx, id, "gems", 10, { reason: "subscription_daily", key: `vip_daily:${id}:2026-10-12` });
      // Ручная правка и забранное при возврате: не начисление покупки.
      await entry(tx, id, "gems", 25, { reason: "adjust", key: `adjust:${randomUUID()}` });
      await entry(tx, id, "gems", -40, { reason: "refund_revoke", key: `refund:${randomUUID()}:gems` });
      // Ключ выдачи есть, а покупки в таблице нет.
      await entry(tx, id, "gems", 60, { key: `purchase:${randomUUID()}:gems` });

      await takeTesterSnapshot(tx, NOW, { write: true });

      expect(await rowsOf(tx, [id])).toMatchObject([{ grants: [{ purchaseId: kept, resource: "gems", amount: 150 }] }]);
    });
  });

  it("покупка есть, а выдачи в журнале нет — строки нет", async () => {
    await rolledBack(async (tx) => {
      const id = await account(tx);
      await shopPurchase(tx, id, {});

      await takeTesterSnapshot(tx, NOW, { write: true });

      expect(await rowsOf(tx, [id])).toEqual([]);
    });
  });

  it("два вторых шанса за 3 и 7 ⭐ — continueStars 10; возвращённый, неоплаченный и тестовый не в счёт", async () => {
    await rolledBack(async (tx) => {
      const id = await account(tx);
      const runId = await run(tx, id, { status: "started" });
      await continuePurchase(tx, id, runId, 1, 3);
      await continuePurchase(tx, id, runId, 2, 7);
      await continuePurchase(tx, id, runId, 3, 5, { refundedAt: NOW });
      await continuePurchase(tx, id, runId, 4, 11, { paid: false });
      await continuePurchase(tx, id, runId, 5, 13, { mode: "test" });
      await continuePurchase(tx, id, runId, 6, 17, { refundRequestedAt: NOW });

      await takeTesterSnapshot(tx, NOW, { write: true });

      expect(await rowsOf(tx, [id])).toMatchObject([{ tester: false, bonusGems: 0, grants: [], continueStars: 10 }]);
      expect(await testerAtOf(tx, id)).toBeNull();
    });
  });

  it("у тестера звёзды второго шанса идут рядом с бонусом", async () => {
    await rolledBack(async (tx) => {
      const id = await account(tx);
      const finished = await run(tx, id);
      await level(tx, id, 3);
      await continuePurchase(tx, id, finished, 1, 4);

      await takeTesterSnapshot(tx, NOW, { write: true });

      expect(await rowsOf(tx, [id])).toMatchObject([{ tester: true, level: 3, bonusGems: 15, continueStars: 4 }]);
    });
  });

  it("только возвращённый второй шанс — строки нет", async () => {
    await rolledBack(async (tx) => {
      const id = await account(tx);
      const runId = await run(tx, id, { status: "started" });
      await continuePurchase(tx, id, runId, 1, 5, { refundedAt: NOW });

      await takeTesterSnapshot(tx, NOW, { write: true });

      expect(await rowsOf(tx, [id])).toEqual([]);
    });
  });

  it("аккаунт без забегов и покупок — строки нет", async () => {
    await rolledBack(async (tx) => {
      const id = await account(tx);
      await level(tx, id, 30);

      await takeTesterSnapshot(tx, NOW, { write: true });

      expect(await rowsOf(tx, [id])).toEqual([]);
      expect(await testerAtOf(tx, id)).toBeNull();
    });
  });

  it("знак «Тестер», поставленный раньше, не перезаписывается", async () => {
    await rolledBack(async (tx) => {
      const earlier = new Date(Date.UTC(2026, 8, 1, 8, 0, 0));
      const id = await account(tx, { testerAt: earlier });
      await run(tx, id);

      await takeTesterSnapshot(tx, NOW, { write: true });

      expect(await testerAtOf(tx, id)).toEqual(earlier);
      expect(await rowsOf(tx, [id])).toMatchObject([{ tester: true }]);
    });
  });

  it("снимок ничего не стирает: забеги, журнал кошелька и покупки на месте", async () => {
    await rolledBack(async (tx) => {
      const id = await account(tx);
      await run(tx, id);
      await level(tx, id, 5);
      await shopPurchase(tx, id, { gems: 150 });
      const count = async () => [
        await tx.run.count({ where: { accountId: id } }),
        await tx.walletEntry.count({ where: { accountId: id } }),
        await tx.purchase.count({ where: { accountId: id } }),
        await tx.accountProgress.count({ where: { accountId: id } }),
      ];
      const before = await count();

      await takeTesterSnapshot(tx, NOW, { write: true });

      expect(await count()).toEqual(before);
    });
  });

  it("write: false ничего не пишет и не ставит знак; итоги те же, что потом у write: true", async () => {
    await rolledBack(async (tx) => {
      const tester = await account(tx);
      await run(tx, tester);
      await level(tx, tester, 12);
      const buyer = await account(tx);
      await shopPurchase(tx, buyer, { gems: 150 });
      const mine = [tester, buyer];

      const planned = await takeTesterSnapshot(tx, NOW, { write: false });

      expect(await rowsOf(tx, mine)).toEqual([]);
      expect(await testerAtOf(tx, tester)).toBeNull();

      const written = await takeTesterSnapshot(tx, NOW, { write: true });

      expect(written).toEqual(planned);
      expect(await rowsOf(tx, mine)).toHaveLength(2);
      expect(await testerAtOf(tx, tester)).toEqual(NOW);
    });
  });

  it("итоги растут ровно на вклад своих аккаунтов", async () => {
    await rolledBack(async (tx) => {
      const before = await takeTesterSnapshot(tx, NOW, { write: false });
      const tester = await account(tx);
      await run(tx, tester);
      await level(tx, tester, 12);
      await shopPurchase(tx, tester, { gems: 150, shard_rare: 2 });
      const buyer = await account(tx);
      await shopPurchase(tx, buyer, { gems: 20, coins: 400 });
      const runId = await run(tx, buyer, { status: "started" });
      await continuePurchase(tx, buyer, runId, 1, 3);
      await continuePurchase(tx, buyer, runId, 2, 7);

      const after = await takeTesterSnapshot(tx, NOW, { write: false });

      expect(after.accounts - before.accounts).toBe(2);
      expect(after.testers - before.testers).toBe(1);
      expect(after.bonusGems - before.bonusGems).toBe(60);
      expect(after.continueStars - before.continueStars).toBe(10);
      const gained = (resource: WalletResource) => (after.restored[resource] ?? 0) - (before.restored[resource] ?? 0);
      expect({ gems: gained("gems"), coins: gained("coins"), shard_rare: gained("shard_rare"), shard_epic: gained("shard_epic") }).toEqual({
        gems: 170,
        coins: 400,
        shard_rare: 2,
        shard_epic: 0,
      });
    });
  });

  it("повторный снимок с записью отказывается: второй вайп — новое решение", async () => {
    await rolledBack(async (tx) => {
      const id = await account(tx);
      await run(tx, id);
      await takeTesterSnapshot(tx, NOW, { write: true });
      const once = await rowsOf(tx, [id]);

      await expect(takeTesterSnapshot(tx, new Date(NOW.getTime() + 60_000), { write: true })).rejects.toThrow("снимок компенсаций уже есть — вайп уже был");

      expect(await rowsOf(tx, [id])).toEqual(once);
    });
  });

  it("строки уже есть — запись отказывается, а подсчёт без записи по-прежнему работает", async () => {
    await rolledBack(async (tx) => {
      const id = await account(tx);
      await tx.testerCompensation.create({ data: { accountId: id, tester: false, level: 1, bonusGems: 0, grants: [], continueStars: 0, snapshotAt: NOW } });

      await expect(takeTesterSnapshot(tx, NOW, { write: true })).rejects.toThrow("снимок компенсаций уже есть");
      await expect(takeTesterSnapshot(tx, NOW, { write: false })).resolves.toMatchObject({ accounts: expect.any(Number) as number });
    });
  });

  it("выдачи в базе читаются схемой, по которой их разберёт выдача компенсации", async () => {
    await rolledBack(async (tx) => {
      const id = await account(tx);
      await shopPurchase(tx, id, { gems: 150, shard_epic: 1 });

      await takeTesterSnapshot(tx, NOW, { write: true });

      const [row] = await rowsOf(tx, [id]);
      expect(compensationGrantsSchema.safeParse(row?.grants).success).toBe(true);
    });
  });
});
