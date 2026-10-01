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

  it("страница журнала: записи одной миллисекунды курсор не теряет и не повторяет", async () => {
    const actor = await account();
    const other = await account();
    // Своё начало имени действия — чужие записи общей базы в отбор не попадут.
    const prefix = `page${randomUUID().slice(0, 8)}.`;
    const at = new Date();
    await prisma.auditEntry.createMany({
      data: [1, 2, 3].map((n) => ({ entryId: randomUUID(), actorAccountId: actor, action: `${prefix}save`, target: `key${String(n)}`, createdAt: at })),
    });
    await roles.append({ actorAccountId: other, action: `${prefix}remove`, target: "key1" });

    const query = { actions: [prefix], actorAccountId: actor, target: null };
    const first = await roles.auditPage({ ...query, limit: 2, before: null });
    const last = first.at(-1);
    expect(first).toHaveLength(2);
    const second = await roles.auditPage({ ...query, limit: 2, before: last === undefined ? null : { createdAt: last.createdAt, entryId: last.entryId } });
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second].map((row) => row.target))).toEqual(new Set(["key1", "key2", "key3"]));

    // Отбор по объекту — и по чужому человеку; два начала имени — оба вида действий.
    expect((await roles.auditPage({ actions: [prefix], actorAccountId: null, target: "key1", limit: 10, before: null })).map((row) => row.action).sort()).toEqual([`${prefix}remove`, `${prefix}save`]);
    expect((await roles.auditPage({ actions: [`${prefix}remove`], actorAccountId: null, target: null, limit: 10, before: null })).map((row) => row.actorAccountId)).toEqual([other]);
  });

  it("имена аккаунтов — одним запросом, ненайденных в ответе нет", async () => {
    const id = await account();
    const names = await accounts.displayNames([id, randomUUID()]);
    expect([...names]).toEqual([[id, "Дым"]]);
    expect(await accounts.displayNames([])).toEqual(new Map());
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
