import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { ForbiddenError, ValidationError } from "../src/common/domain-error.js";
import { $Enums } from "../src/generated/prisma/client.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { EXCHANGE_RESOURCES, WALLET_DAILY_CAPS, WALLET_MAX_OPERATION } from "../src/modules/wallet/wallet-limits.js";
import type { WalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { EARN_REASONS, WALLET_RESOURCES, emptyBalances } from "../src/modules/wallet/wallet-types.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Кошелёк без базы: то, что обязано отсекаться до транзакции. Гонки, потолки
 * и откаты — в `wallet.integration.test.ts` на живом Postgres.
 */

const ADMIN_TELEGRAM_ID = "777000333";

function config(patch: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ADMIN_TELEGRAM_IDS: ADMIN_TELEGRAM_ID, ...patch } as NodeJS.ProcessEnv);
}

/** Репозиторий, до которого проверки не должны дойти. */
class UntouchedWallet implements WalletRepository {
  calls = 0;
  async credit(): Promise<never> {
    this.calls++;
    throw new Error("не должно было дойти до базы");
  }
  async debit(): Promise<never> {
    this.calls++;
    throw new Error("не должно было дойти до базы");
  }
  async balances() {
    return emptyBalances();
  }
  async recentEntries() {
    return [];
  }
}

function setup(patch: Record<string, string> = {}): { wallet: WalletService; repository: UntouchedWallet } {
  const repository = new UntouchedWallet();
  const roles = new RolesService(config(patch), new MemoryRolesRepository(), new MemoryAccountRepository());
  return { wallet: new WalletService(repository, config(patch), roles), repository };
}

const player = (platformUserId = "555"): AccountRef => ({ accountId: randomUUID(), platform: "telegram", platformUserId });
const grant = (patch: Partial<Parameters<WalletService["grant"]>[0]> = {}): Parameters<WalletService["grant"]>[0] => ({
  accountId: randomUUID(),
  resource: "coins",
  amount: 10,
  reason: "run_reward",
  idempotencyKey: `run:${randomUUID()}:coins`,
  ...patch,
});

describe("кошелёк: что отсекается до базы", () => {
  it.each([0, -5, 1.5, Number.NaN, WALLET_MAX_OPERATION + 1])("сумма %s не проходит", async (amount) => {
    const { wallet, repository } = setup();
    await expect(wallet.grant(grant({ amount }))).rejects.toBeInstanceOf(ValidationError);
    await expect(wallet.spend({ accountId: randomUUID(), lines: [{ resource: "coins", amount }], reason: "unlock", idempotencyKey: "k" })).rejects.toBeInstanceOf(ValidationError);
    expect(repository.calls).toBe(0);
  });

  it("источник не начисляет то, что ему не разрешено: реклама — не самоцветы, покупка — не монеты", async () => {
    const { wallet, repository } = setup();
    await expect(wallet.grant(grant({ reason: "ad_reward", resource: "gems" }))).rejects.toThrow(/ad_reward не начисляет gems/);
    await expect(wallet.grant(grant({ reason: "purchase", resource: "coins" }))).rejects.toThrow(/purchase не даёт coins/);
    await expect(wallet.grant(grant({ reason: "salvage", resource: "gems" }))).rejects.toThrow(/salvage не даёт gems/);
    expect(repository.calls).toBe(0);
  });

  it("трата без строк или с повтором ресурса не проходит", async () => {
    const { wallet } = setup();
    await expect(wallet.spend({ accountId: randomUUID(), lines: [], reason: "shop", idempotencyKey: "k" })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      wallet.spend({
        accountId: randomUUID(),
        lines: [
          { resource: "coins", amount: 1 },
          { resource: "coins", amount: 2 },
        ],
        reason: "shop",
        idempotencyKey: "k",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("пустой и слишком длинный ключ не проходят", async () => {
    const { wallet } = setup();
    await expect(wallet.grant(grant({ idempotencyKey: "" }))).rejects.toBeInstanceOf(ValidationError);
    await expect(wallet.grant(grant({ idempotencyKey: "k".repeat(141) }))).rejects.toBeInstanceOf(ValidationError);
  });

  it("ручная операция — только с правом", async () => {
    const { wallet, repository } = setup();
    await expect(wallet.adjust(player(), { accountId: randomUUID(), resource: "gems", delta: 5, note: "проверка", idempotencyKey: "abcdefgh" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(repository.calls).toBe(0);
  });

  it("свой кошелёк не меняется даже владельцем, кроме машины разработчика", async () => {
    const owner = player(ADMIN_TELEGRAM_ID);
    const { wallet } = setup();
    await expect(wallet.adjust(owner, { accountId: owner.accountId, resource: "gems", delta: 5, note: "себе", idempotencyKey: "abcdefgh" })).rejects.toThrow("Менять свой кошелёк нельзя");

    const dev = setup({ ...AUTH_ENV, NODE_ENV: "development", AUTH_DEV_LOGIN: "true" });
    await expect(dev.wallet.adjust(owner, { accountId: owner.accountId, resource: "gems", delta: 5, note: "себе", idempotencyKey: "abcdefgh" })).rejects.toThrow("не должно было дойти до базы");
  });

  it("нулевое изменение — ошибка, а не пустая строка в журнале", async () => {
    const { wallet, repository } = setup();
    await expect(wallet.adjust(player(ADMIN_TELEGRAM_ID), { accountId: randomUUID(), resource: "gems", delta: 0, note: "ноль", idempotencyKey: "abcdefgh" })).rejects.toBeInstanceOf(ValidationError);
    expect(repository.calls).toBe(0);
  });
});

describe("кошелёк: настройки", () => {
  it("ресурсы кода совпадают с перечислением в базе", () => {
    expect([...WALLET_RESOURCES].sort()).toEqual(Object.values($Enums.WalletResource).sort());
  });

  it("у каждого источника «из ничего» есть потолок хотя бы на один ресурс, и потолки — целые больше нуля", () => {
    for (const reason of EARN_REASONS) {
      const caps = Object.values(WALLET_DAILY_CAPS[reason]);
      expect(caps.length, reason).toBeGreaterThan(0);
      for (const cap of caps) expect(Number.isSafeInteger(cap) && cap > 0, reason).toBe(true);
    }
  });

  it("монеты не продаются и самоцветы не выпадают из разбора (Р2, Р34)", () => {
    expect(EXCHANGE_RESOURCES.purchase).toEqual(["gems"]);
    expect(EXCHANGE_RESOURCES.salvage.every((resource) => resource.startsWith("shard_"))).toBe(true);
  });
});
