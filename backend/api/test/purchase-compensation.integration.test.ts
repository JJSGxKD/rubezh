import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PaymentFeedSources } from "../src/modules/payments/payment-feed-sources.js";
import { PaymentsHooks, type SupportAction } from "../src/modules/payments/payments-hooks.js";
import { PurchaseCompensations } from "../src/modules/payments/purchase-compensation.js";
import { PrismaPurchaseCompensationRepository, type CompensationRow } from "../src/modules/payments/purchase-compensation.repository.js";
import { PrismaPurchasesRepository } from "../src/modules/payments/purchases.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { panelSettings } from "./helpers/settings.js";
import { testPrisma } from "./helpers/test-prisma.js";
import { uniquePlatformUserId } from "./helpers/player-ids.js";

/**
 * Компенсация за сбой оплаты на настоящем Postgres (tasks/T-0435,
 * docs/17-testing-strategy.md §4.2). Адрес — TEST_DATABASE_URL; без него
 * пропускается.
 *
 * Память этого не покажет: «одна компенсация на покупку» держится первичным
 * ключом таблицы, а «один раз в кошельке» — уникальным ключом журнала, и то и
 * другое — условия базы при двух одновременных запросах.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const OWNER_ID = uniquePlatformUserId();
const NOTE = "Сбой оплаты: товар не пришёл";
const NOW = new Date();

describe.skipIf(DATABASE_URL === "")("компенсация за сбой оплаты на живом Postgres", () => {
  let prisma: PrismaClient;
  let compensations: PrismaPurchaseCompensationRepository;
  let wallet: WalletService;
  let service: PurchaseCompensations;
  let rolesRepository: MemoryRolesRepository;
  let events: SupportAction[];
  let owner: AccountRef;
  let playerId = "";
  const created: string[] = [];

  async function newPurchase(): Promise<string> {
    const purchaseId = randomUUID();
    created.push(purchaseId);
    await prisma.purchase.create({
      data: {
        purchaseId,
        accountId: playerId,
        product: "shop_item",
        sku: "gems_330",
        priceStars: 250,
        chargedStars: 250,
        mode: "live",
        status: "paid",
        telegramChargeId: `charge-${randomUUID()}`,
        invoicedAt: NOW,
        paidAt: NOW,
      },
    });
    return purchaseId;
  }

  const rowOf = (purchaseId: string, patch: Partial<CompensationRow> = {}): CompensationRow => ({
    purchaseId,
    accountId: playerId,
    resource: "gems",
    amount: 660,
    suggested: 660,
    note: NOTE,
    actorAccountId: owner.accountId,
    createdAt: NOW,
    creditedAt: null,
    ...patch,
  });

  const walletEntries = async (purchaseId: string) => await prisma.walletEntry.findMany({ where: { idempotencyKey: `compensation:${purchaseId}` } });
  const balance = async () => (await wallet.balances(playerId)).gems;

  beforeAll(async () => {
    const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 8);
    const accounts = new PrismaAccountRepository(prisma);
    const arrival = (platformUserId: string, name: string) => ({ platform: "telegram" as const, platformUserId, displayName: name, username: null, photoUrl: null });
    const ownerAccount = await accounts.upsert(arrival(OWNER_ID, "Владелец"), Date.now());
    owner = { accountId: ownerAccount.accountId, platform: "telegram", platformUserId: OWNER_ID };
    playerId = (await accounts.upsert(arrival(uniquePlatformUserId(), "Пострадавший"), Date.now())).accountId;

    rolesRepository = new MemoryRolesRepository();
    const roles = new RolesService(config, rolesRepository, accounts);
    compensations = new PrismaPurchaseCompensationRepository(prisma);
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, roles);
    const hooks = new PaymentsHooks();
    events = [];
    hooks.onSupport("тест", async (action) => {
      events.push(action);
    });
    service = new PurchaseCompensations(config, new PrismaPurchasesRepository(prisma), compensations, wallet, panelSettings(), roles, accounts, hooks, new PaymentFeedSources());
  });

  afterAll(async () => {
    // Компенсации держат покупки (Restrict): сначала они.
    await prisma.purchaseCompensation.deleteMany({ where: { purchaseId: { in: created } } });
    await prisma.purchase.deleteMany({ where: { purchaseId: { in: created } } });
    await prisma.$disconnect();
  });

  it("две одновременные компенсации одной покупки: одна строка, одна запись кошелька, баланс вырос один раз", async () => {
    const purchaseId = await newPurchase();
    const before = await balance();
    const auditBefore = rolesRepository.entries.length;
    const eventsBefore = events.length;

    const outcomes = await Promise.allSettled([
      service.compensate(owner, purchaseId, { gems: 600, note: NOTE }, NOW),
      service.compensate(owner, purchaseId, { gems: 700, note: NOTE }, NOW),
    ]);

    expect(await prisma.purchaseCompensation.count({ where: { purchaseId } })).toBe(1);
    const entries = await walletEntries(purchaseId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ accountId: playerId, resource: "gems", reason: "payment_compensation", source: `admin:${owner.accountId}` });
    const credited = Number(entries[0]?.amount);
    expect([600, 700]).toContain(credited);
    expect(await balance()).toBe(before + credited);
    expect(rolesRepository.entries.length - auditBefore).toBe(1);
    expect(events.length - eventsBefore).toBe(1);
    const fulfilled = outcomes.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
    expect(fulfilled.length).toBeGreaterThan(0);
    for (const result of fulfilled) expect(result.gems).toBe(credited);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") expect(outcome.reason).toMatchObject({ message: "За эту покупку компенсация уже начислена" });
    }
    const row = await compensations.byPurchase(purchaseId);
    expect(row).toMatchObject({ amount: credited, resource: "gems" });
    expect(row?.creditedAt).not.toBeNull();
  });

  it("третья попытка после начисленной — отказ, баланс прежний", async () => {
    const purchaseId = await newPurchase();
    await service.compensate(owner, purchaseId, { gems: 500, note: NOTE }, NOW);
    const after = await balance();

    await expect(service.compensate(owner, purchaseId, { gems: 500, note: NOTE }, NOW)).rejects.toMatchObject({ code: "purchase_action_unavailable" });

    expect(await balance()).toBe(after);
    expect(await walletEntries(purchaseId)).toHaveLength(1);
  });

  it("insert второй строки той же покупки — exists, первая строка цела", async () => {
    const purchaseId = await newPurchase();

    expect(await compensations.insert(rowOf(purchaseId, { amount: 660 }))).toBe("inserted");
    expect(await compensations.insert(rowOf(purchaseId, { amount: 999, note: "другая" }))).toBe("exists");

    expect(await compensations.byPurchase(purchaseId)).toMatchObject({ amount: 660, note: NOTE, creditedAt: null });
  });

  it("строка без покупки не вставляется: внешний ключ, а не «exists»", async () => {
    await expect(compensations.insert(rowOf(randomUUID()))).rejects.toThrow();
  });

  it("markCredited ставит отметку один раз: первый вызов — true, второй — false, время первого остаётся", async () => {
    const purchaseId = await newPurchase();
    await compensations.insert(rowOf(purchaseId));
    const first = new Date(NOW.getTime() + 1_000);

    expect(await compensations.markCredited(purchaseId, first)).toBe(true);
    expect(await compensations.markCredited(purchaseId, new Date(NOW.getTime() + 2_000))).toBe(false);

    expect((await compensations.byPurchase(purchaseId))?.creditedAt).toEqual(first);
    expect(await compensations.markCredited(randomUUID(), first)).toBe(false);
  });

  it("повтор после сбоя между строкой и кошельком: сумма из строки, кошелёк один раз, отметка и журнал — один раз", async () => {
    const purchaseId = await newPurchase();
    await compensations.insert(rowOf(purchaseId, { amount: 420 }));
    const before = await balance();
    const auditBefore = rolesRepository.entries.length;

    const result = await service.compensate(owner, purchaseId, { gems: 1, note: "другая причина" }, NOW);

    expect(result).toMatchObject({ gems: 420, repaired: true });
    expect(await balance()).toBe(before + 420);
    expect(await walletEntries(purchaseId)).toHaveLength(1);
    expect((await compensations.byPurchase(purchaseId))?.creditedAt).not.toBeNull();
    expect(rolesRepository.entries.length - auditBefore).toBe(1);
  });

  it("byPurchases отдаёт строки только тех покупок, что есть, одним запросом", async () => {
    const first = await newPurchase();
    const second = await newPurchase();
    await compensations.insert(rowOf(first, { amount: 11 }));
    await compensations.insert(rowOf(second, { amount: 22, creditedAt: NOW }));

    const rows = await compensations.byPurchases([first, second, randomUUID()]);

    expect([...rows.keys()].sort()).toEqual([first, second].sort());
    expect(rows.get(first)).toMatchObject({ amount: 11, creditedAt: null });
    expect(rows.get(second)).toMatchObject({ amount: 22, creditedAt: NOW });
    expect((await compensations.byPurchases([])).size).toBe(0);
  });
});
