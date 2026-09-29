import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaAccountSettingsRepository } from "../src/modules/account-settings/account-settings.repository.js";
import { AccountSettingsService } from "../src/modules/account-settings/account-settings.service.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";

/**
 * Настройки аккаунта на живом Postgres (docs/17-testing-strategy.md §4.2;
 * адрес — TEST_DATABASE_URL, без него пропуск). Слияние идёт под блокировкой
 * строки: устройства, приславшие настройки одновременно, не затирают
 * выбранное друг другом — даже когда строки у аккаунта ещё нет.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const RACE_TIMEOUT_MS = 30_000;

describe.skipIf(DATABASE_URL === "")("настройки аккаунта на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let service: AccountSettingsService;

  async function account(): Promise<AccountRef> {
    const platformUserId = String(760_000_000 + Math.floor(Math.random() * 90_000_000));
    const created = await accounts.upsert({ platform: "telegram", platformUserId, displayName: "Настройки", username: null }, Date.now());
    return { accountId: created.accountId, platform: "telegram", platformUserId };
  }

  beforeAll(() => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 20, connectionTimeoutMillis: 30_000 }) });
    accounts = new PrismaAccountRepository(prisma);
    service = new AccountSettingsService(new PrismaAccountSettingsRepository(prisma));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("у нового аккаунта настроек нет, а первая запись заводит строку", async () => {
    const owner = await account();
    expect(await service.get(owner)).toEqual({ version: 1, values: {} });

    await service.merge(owner, { version: 1, values: { "combat.telegraphs": { value: false, ageMs: 1_000 } } }, 5_000);

    expect(await service.get(owner)).toEqual({ version: 1, values: { "combat.telegraphs": { value: false, at: 4_000 } } });
  });

  it(
    "устройства шлют разные ключи одновременно — в базе остаются все",
    async () => {
      const owner = await account();
      const keys = ["testing.enabled", "testing.recordRuns", "combat.telegraphs", "combat.damageNumbers"] as const;

      await Promise.all(keys.map((key, index) => service.merge(owner, { version: 1, values: { [key]: { value: true, ageMs: 100 + index } } }, 5_000)));

      const stored = await service.get(owner);
      expect(Object.keys(stored.values).sort()).toEqual([...keys].sort());
    },
    RACE_TIMEOUT_MS,
  );

  it(
    "один ключ с разных устройств под гонкой — побеждает выбранное позже, а не пришедшее последним",
    async () => {
      const owner = await account();
      // Возраст 1 — самый свежий выбор: он уходит первым, а побеждает всё равно он.
      const ages = Array.from({ length: 10 }, (_, index) => 1 + index);

      await Promise.all(ages.map((ageMs) => service.merge(owner, { version: 1, values: { "combat.damageNumbers": { value: ageMs % 2 === 0, ageMs } } }, 5_000)));

      expect((await service.get(owner)).values["combat.damageNumbers"]).toEqual({ value: false, at: 4_999 });
    },
    RACE_TIMEOUT_MS,
  );

  it("удаление аккаунта уносит и его настройки", async () => {
    const owner = await account();
    await service.merge(owner, { version: 1, values: { "hints.seen": { value: ["move"], ageMs: 10 } } }, 5_000);

    await prisma.account.delete({ where: { accountId: owner.accountId } });

    expect(await prisma.accountSettings.findUnique({ where: { accountId: owner.accountId } })).toBeNull();
  });
});
