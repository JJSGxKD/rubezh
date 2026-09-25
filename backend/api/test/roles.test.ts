import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { DomainError } from "../src/common/domain-error.js";
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, permissionsOf } from "../src/modules/roles/permissions.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Роли, права и журнал (docs/34-stage3-plan.md, WP2).
 *
 * Главное, что здесь закрепляется, — **аварийный путь**: список в окружении
 * даёт владельца на пустой системе и перестаёт работать, как только владелец
 * появился. Ошибка в любую сторону дорога: в одну — первый человек не может
 * войти вовсе, в другую — список навсегда остаётся чёрным ходом мимо ролей.
 */

const ADMIN_TELEGRAM_ID = "777000111";

function config(patch: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ADMIN_TELEGRAM_IDS: ADMIN_TELEGRAM_ID, ...patch } as NodeJS.ProcessEnv);
}

function account(platformUserId = "555", platform: AccountRef["platform"] = "telegram"): AccountRef {
  return { accountId: randomUUID(), platform, platformUserId };
}

describe("перечень прав и состав ролей", () => {
  it("у владельца есть каждое право: новое не должно появиться мимо него", () => {
    for (const permission of PERMISSIONS) expect(ROLE_PERMISSIONS.owner).toContain(permission);
  });

  it("в ролях нет прав вне перечня", () => {
    for (const role of ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(permission);
    }
  });

  it("у модератора нет ни выручки, ни выгрузки, ни ролей", () => {
    const granted = permissionsOf(["moderator"]);

    expect(granted.has("players.ban")).toBe(true);
    expect(granted.has("analytics.revenue.view")).toBe(false);
    expect(granted.has("data.export")).toBe(false);
    expect(granted.has("roles.assign")).toBe(false);
  });

  it("у администратора нет бухгалтерии и раздачи ролей", () => {
    const granted = permissionsOf(["admin"]);

    expect(granted.has("finance.entry.create")).toBe(false);
    expect(granted.has("finance.period.close")).toBe(false);
    expect(granted.has("roles.assign")).toBe(false);
  });

  it("роли складываются: у человека их бывает несколько", () => {
    const granted = permissionsOf(["moderator", "analyst"]);

    expect(granted.has("players.ban")).toBe(true);
    expect(granted.has("analytics.gameplay.view")).toBe(true);
  });

  it("период закрывает только владелец, а цену SKU одобряет он же", () => {
    for (const role of ROLES) {
      if (role === "owner") continue;
      expect(ROLE_PERMISSIONS[role], role).not.toContain("finance.period.close");
      expect(ROLE_PERMISSIONS[role], role).not.toContain("sku.price.approve");
    }
  });
});

describe("кто что может", () => {
  let roles: MemoryRolesRepository;
  let accounts: MemoryAccountRepository;
  let service: RolesService;

  beforeEach(() => {
    roles = new MemoryRolesRepository();
    accounts = new MemoryAccountRepository();
    service = new RolesService(config(), roles, accounts);
  });

  it("без ролей и без списка не может ничего", async () => {
    expect(await service.can(account("123"), "data.export")).toBe(false);
  });

  it("выданная роль действует сразу — она не зашита в токен", async () => {
    const moderator = account();
    await roles.grant(moderator.accountId, "moderator", null);

    expect(await service.can(moderator, "players.ban")).toBe(true);
    expect(await service.can(moderator, "data.export")).toBe(false);
  });

  it("разработчик при локальном входе — владелец, а без флага — никто", async () => {
    // Вход разработчика существует только в development: там он открывает
    // инструменты команды, как раньше заголовок плейтеста.
    const local = new RolesService(
      config({ NODE_ENV: "development", AUTH_ENABLED: "true", AUTH_DEV_LOGIN: "true", JWT_ACCESS_SECRET: "a".repeat(64), TELEGRAM_BOT_TOKEN: "1:T", DATABASE_URL: "postgresql://localhost/test" }),
      roles,
      accounts,
    );

    expect(await local.rolesFor(account("dev-1"))).toEqual(["owner"]);
    expect(await service.rolesFor(account("dev-1"))).toEqual([]);
    // Числовой ID — настоящий игрок: флаг его не касается.
    expect(await local.rolesFor(account("555"))).toEqual([]);
  });

  it("список в окружении даёт владельца, пока владельца нет в базе", async () => {
    expect(await service.rolesFor(account(ADMIN_TELEGRAM_ID))).toEqual(["owner"]);
  });

  it("как только владелец появился, список перестаёт быть чёрным ходом", async () => {
    await roles.grant(randomUUID(), "owner", null);

    expect(await service.rolesFor(account(ADMIN_TELEGRAM_ID))).toEqual([]);
  });

  it("свои роли сильнее списка: аварийный путь не подменяет выданное", async () => {
    const admin = account(ADMIN_TELEGRAM_ID);
    await roles.grant(admin.accountId, "analyst", null);

    expect(await service.rolesFor(admin)).toEqual(["analyst"]);
  });

  it("аварийный путь — только про Telegram: список в окружении про него", async () => {
    expect(await service.rolesFor(account(ADMIN_TELEGRAM_ID, "max"))).toEqual([]);
  });

  it("по идентификатору площадки права находятся и без аккаунта", async () => {
    // Администратор мог ни разу не открыть игру, а командой бота пользоваться.
    expect(await service.canByPlatformUser("telegram", ADMIN_TELEGRAM_ID, "data.export")).toBe(true);
    expect(await service.canByPlatformUser("telegram", "999", "data.export")).toBe(false);
  });

  it("по идентификатору площадки берутся роли найденного аккаунта", async () => {
    const found = await accounts.upsert(
      { platform: "telegram", platformUserId: "42", displayName: "Дым", username: null, photoUrl: null },
      Date.now(),
    );
    await roles.grant(found.accountId, "moderator", null);

    expect(await service.canByPlatformUser("telegram", "42", "players.ban")).toBe(true);
    expect(await service.canByPlatformUser("telegram", "42", "data.export")).toBe(false);
  });
});

describe("выдача ролей и журнал", () => {
  let roles: MemoryRolesRepository;
  let service: RolesService;
  let owner: AccountRef;

  beforeEach(async () => {
    roles = new MemoryRolesRepository();
    service = new RolesService(config(), roles, new MemoryAccountRepository());
    owner = account(ADMIN_TELEGRAM_ID);
  });

  it("владелец выдаёт роль и это попадает в журнал", async () => {
    const target = randomUUID();

    expect(await service.grant(owner, target, "moderator")).toBe(true);
    expect(await roles.rolesOf(target)).toEqual(["moderator"]);
    expect(roles.entries).toMatchObject([
      { action: "roles.assign", target, actorAccountId: owner.accountId, after: { role: "moderator" } },
    ]);
  });

  it("повторная выдача не событие: в журнале по-прежнему одна запись", async () => {
    const target = randomUUID();
    await service.grant(owner, target, "moderator");

    expect(await service.grant(owner, target, "moderator")).toBe(false);
    expect(roles.entries).toHaveLength(1);
  });

  it("отзыв пишет, что было", async () => {
    const target = randomUUID();
    await service.grant(owner, target, "moderator");

    expect(await service.revoke(owner, target, "moderator")).toBe(true);
    expect(roles.entries[1]).toMatchObject({ action: "roles.revoke", before: { role: "moderator" } });
  });

  it("без права роли не раздаются", async () => {
    const stranger = account("123");

    await expect(service.grant(stranger, randomUUID(), "owner")).rejects.toThrow(DomainError);
    expect(roles.entries).toEqual([]);
  });

  it("себе роль не выдать и не отозвать", async () => {
    await expect(service.grant(owner, owner.accountId, "owner")).rejects.toThrow(/себе/);
    await expect(service.revoke(owner, owner.accountId, "owner")).rejects.toThrow(/себя/);
  });

  it("упавший журнал не срывает само действие", async () => {
    // Дыра в журнале дороже одной строки, но отказ игроку из-за неё — хуже.
    roles.failAudit = true;
    const target = randomUUID();

    expect(await service.grant(owner, target, "analyst")).toBe(true);
    expect(await roles.rolesOf(target)).toEqual(["analyst"]);
  });
});
