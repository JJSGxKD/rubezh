import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaRolesRepository } from "../src/modules/roles/roles.repository.js";

/**
 * Роли и журнал на настоящем Postgres (docs/17-testing-strategy.md §4.2).
 * Адрес — TEST_DATABASE_URL; без него пропускается.
 *
 * Память этого не покажет: повторная выдача упирается в первичный ключ, а не
 * в проверку в коде; отзыв роли не трогает соседние; в журнал записывается
 * именно `null`, а не «поле не менять» — у Prisma это разные значения.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

describe.skipIf(DATABASE_URL === "")("роли и журнал на живом Postgres", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let roles: PrismaRolesRepository;
  let accounts: PrismaAccountRepository;

  const telegramId = (): string => String(900_000_000 + Math.floor(Math.random() * 90_000_000));

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: telegramId(), displayName: "Дым", username: null, photoUrl: null },
      Date.now(),
    );
    return created.accountId;
  }

  beforeAll(() => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    roles = new PrismaRolesRepository(prisma);
    accounts = new PrismaAccountRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("выдаёт роль один раз: повтор упирается в ключ, а не в проверку в коде", async () => {
    const id = await account();

    expect(await roles.grant(id, "moderator", null)).toBe(true);
    expect(await roles.grant(id, "moderator", null)).toBe(false);
    expect(await roles.rolesOf(id)).toEqual(["moderator"]);
  });

  it("ролей у человека бывает несколько, и отзыв трогает только одну", async () => {
    const id = await account();
    await roles.grant(id, "admin", null);
    await roles.grant(id, "marketer", null);

    expect(await roles.revoke(id, "marketer")).toBe(true);
    expect(await roles.rolesOf(id)).toEqual(["admin"]);
  });

  it("видит владельца в системе — от этого зависит аварийный путь", async () => {
    const id = await account();
    await roles.grant(id, "owner", null);

    expect(await roles.hasOwner()).toBe(true);

    await roles.revoke(id, "owner");
  });

  it("журнал пишет и читает, а пустое состояние остаётся пустым", async () => {
    const actor = await account();
    const target = await account();
    const action = `roles.assign.${randomUUID()}`;

    await roles.append({ actorAccountId: actor, action, target, after: { role: "analyst" } });
    const [entry] = await roles.recentAudit(200).then((rows) => rows.filter((row) => row.action === action));

    expect(entry).toMatchObject({ actorAccountId: actor, target, after: { role: "analyst" } });
    // Состояния «до» не было — в колонке именно null, а не пропущенное поле.
    expect(entry?.before).toBeNull();
  });

  it("удаление аккаунта уносит его роли, а журнал остаётся", async () => {
    // Журнал переживает игрока: иначе «кто это сделал» пропадает вместе с ним.
    const id = await account();
    await roles.grant(id, "analyst", null);
    await roles.append({ actorAccountId: id, action: "roles.assign", target: id });

    await prisma.account.delete({ where: { accountId: id } });

    expect(await roles.rolesOf(id)).toEqual([]);
    expect(await roles.recentAudit(200).then((rows) => rows.some((row) => row.actorAccountId === id))).toBe(true);
  });
});
