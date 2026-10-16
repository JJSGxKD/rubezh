import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { PrismaCompensationRepository } from "../src/modules/wipe/compensation.repository.js";
import { CompensationNotFoundError, CompensationService } from "../src/modules/wipe/compensation.service.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Выдача компенсации на живом Postgres и настоящем кошельке (docs/17-testing-strategy.md
 * §4.2; адрес — TEST_DATABASE_URL, без него пропуск; tasks/T-0042). Память этого
 * не покажет: идемпотентность начислений держит уникальный индекс журнала, а
 * отметку «забрано» — условный `UPDATE`.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

describe.skipIf(DATABASE_URL === "")("компенсация после вайпа на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let wallet: WalletService;
  let service: CompensationService;

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(740_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Тестер", username: null, photoUrl: null },
      Date.now(),
    );
    return created.accountId;
  }

  /** Строка компенсации — как её пишет снимок перед вайпом (`tester-snapshot.ts`). */
  async function snapshotOf(accountId: string, patch: { continueStars?: number; bonusGems?: number; grants?: { purchaseId: string; resource: "gems"; amount: number }[] } = {}) {
    const grants = patch.grants ?? [
      { purchaseId: randomUUID(), resource: "gems" as const, amount: 150 },
      { purchaseId: randomUUID(), resource: "gems" as const, amount: 60 },
    ];
    await prisma.testerCompensation.create({
      data: { accountId, tester: true, level: 12, bonusGems: patch.bonusGems ?? 60, grants, continueStars: patch.continueStars ?? 0, snapshotAt: new Date() },
    });
    return grants;
  }

  beforeAll(() => {
    const config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    accounts = new PrismaAccountRepository(prisma);
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    service = new CompensationService(new PrismaCompensationRepository(prisma), wallet);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("claim: баланс самоцветов — выдачи, бонус и второй шанс; в журнале строки с ключами покупок, бонуса и второго шанса", async () => {
    const id = await account();
    const grants = await snapshotOf(id, { continueStars: 10 });

    const result = await service.claim(id);

    expect(result.alreadyClaimed).toBe(false);
    expect(result.balances.gems).toBe(150 + 60 + 60 + 12);
    expect(result.view).toEqual({
      tester: true,
      level: 12,
      bonusGems: 60,
      restored: [{ resource: "gems", amount: 210 }],
      continueGems: 12,
    });
    const rows = await prisma.walletEntry.findMany({ where: { accountId: id }, orderBy: { idempotencyKey: "asc" } });
    expect(rows.map((row) => [row.idempotencyKey, row.reason, row.resource, Number(row.amount)]).sort()).toEqual(
      [
        [`purchase:${grants[0]?.purchaseId}:gems`, "purchase", "gems", 150],
        [`purchase:${grants[1]?.purchaseId}:gems`, "purchase", "gems", 60],
        [`wipe:${id}:bonus`, "wipe_compensation", "gems", 60],
        [`wipe:${id}:continue`, "wipe_compensation", "gems", 12],
      ].sort(),
    );
    expect((await prisma.testerCompensation.findUniqueOrThrow({ where: { accountId: id } })).claimedAt).not.toBeNull();
  });

  it("pending до выдачи отдаёт положенное, после — null", async () => {
    const id = await account();
    await snapshotOf(id);

    expect(await service.pending(id)).toMatchObject({ bonusGems: 60, restored: [{ resource: "gems", amount: 210 }] });
    await service.claim(id);
    expect(await service.pending(id)).toBeNull();
  });

  it("второй claim: баланс и журнал не меняются, ответ тот же, alreadyClaimed", async () => {
    const id = await account();
    await snapshotOf(id, { continueStars: 3 });
    const first = await service.claim(id);
    const entries = await prisma.walletEntry.count({ where: { accountId: id } });

    const again = await service.claim(id);

    expect(again.alreadyClaimed).toBe(true);
    expect(again.view).toEqual(first.view);
    expect(again.balances.gems).toBe(first.balances.gems);
    expect(await prisma.walletEntry.count({ where: { accountId: id } })).toBe(entries);
  });

  it("десять нажатий одновременно: на счёт один раз, ровно один ответ «не забирал раньше»", async () => {
    const id = await account();
    await snapshotOf(id, { continueStars: 10 });

    const results = await Promise.all(Array.from({ length: 10 }, () => service.claim(id)));

    expect(results.filter((result) => !result.alreadyClaimed)).toHaveLength(1);
    expect((await wallet.balances(id)).gems).toBe(150 + 60 + 60 + 12);
    expect(await prisma.walletEntry.count({ where: { accountId: id } })).toBe(4);
  });

  it("сбой после начислений, до отметки: повтор находит строки по ключам и не начисляет дважды", async () => {
    const id = await account();
    await snapshotOf(id);
    // Первая попытка дошла до начислений и умерла до отметки: то же самое, что начислить руками тем же ключом.
    const row = await prisma.testerCompensation.findUniqueOrThrow({ where: { accountId: id } });
    const [first] = row.grants as { purchaseId: string; resource: "gems"; amount: number }[];
    await wallet.grant({ accountId: id, resource: "gems", amount: first?.amount ?? 0, reason: "purchase", source: "wipe:restore", idempotencyKey: `purchase:${first?.purchaseId}:gems` });

    const result = await service.claim(id);

    expect(result.balances.gems).toBe(150 + 60 + 60);
    expect(await prisma.walletEntry.count({ where: { accountId: id } })).toBe(3);
  });

  it("возврат звёзд за купленное после компенсации находит начисление по тому же ключу и забирает его", async () => {
    const id = await account();
    const grants = await snapshotOf(id, { bonusGems: 0 });
    await service.claim(id);
    const purchaseId = grants[0]?.purchaseId ?? "";

    const outcome = await wallet.revokeUpTo({ accountId: id, resource: "gems", grantKey: `purchase:${purchaseId}:gems`, idempotencyKey: `refund:${purchaseId}:gems`, source: "shop:refund" });

    expect(outcome).toMatchObject({ status: "revoked", revoked: 150, granted: 150 });
    expect((await wallet.balances(id)).gems).toBe(60);
  });

  it("нет строки — CompensationNotFoundError, журнал пуст", async () => {
    const id = await account();

    await expect(service.claim(id)).rejects.toBeInstanceOf(CompensationNotFoundError);
    expect(await service.pending(id)).toBeNull();
    expect(await prisma.walletEntry.count({ where: { accountId: id } })).toBe(0);
  });

  it("не тестер с выдачей: бонус не начисляется", async () => {
    const id = await account();
    await prisma.testerCompensation.create({
      data: { accountId: id, tester: false, level: 1, bonusGems: 0, grants: [{ purchaseId: randomUUID(), resource: "gems", amount: 60 }], continueStars: 0, snapshotAt: new Date() },
    });

    const result = await service.claim(id);

    expect(result.balances.gems).toBe(60);
    expect(await prisma.walletEntry.count({ where: { accountId: id, reason: "wipe_compensation" } })).toBe(0);
  });
});
