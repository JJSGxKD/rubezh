import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { DomainError } from "../src/common/domain-error.js";
import { ROLE_LEVELS, canManage, levelOf } from "../src/modules/roles/role-levels.js";
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

  it("право поддержки покупок payments.support — у владельца и администратора, у остальных ролей его нет (T-0037)", () => {
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role].includes("payments.support"), role).toBe(role === "owner" || role === "admin");
    }
  });

  it("правила фильтра имён names.edit — у владельца, администратора и модератора, у остальных ролей нет (T-0338)", () => {
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role].includes("names.edit"), role).toBe(role === "owner" || role === "admin" || role === "moderator");
    }
  });

  it("у администратора нет бухгалтерии, а раздача ролей — есть, но с уровнями (T-0216)", () => {
    const granted = permissionsOf(["admin"]);

    expect(granted.has("finance.entry.create")).toBe(false);
    expect(granted.has("finance.period.close")).toBe(false);
    expect(granted.has("roles.assign")).toBe(true);
  });

  it("roles.assign — у владельца и администратора, у остальных ролей нет (T-0216)", () => {
    expect(ROLES.filter((role) => ROLE_PERMISSIONS[role].includes("roles.assign"))).toEqual(["owner", "admin"]);
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

  it("dev-player-<id> входит игроком без ролей; роли из базы у него работают; dev-<id> — владелец", async () => {
    const env = { NODE_ENV: "development", AUTH_ENABLED: "true", AUTH_DEV_LOGIN: "true", JWT_ACCESS_SECRET: "a".repeat(64), TELEGRAM_BOT_TOKEN: "1:T", DATABASE_URL: "postgresql://localhost/test" };
    const local = new RolesService(config(env), roles, accounts);
    const player = account("dev-player-alex");

    expect(await local.rolesFor(account("dev-alex"))).toEqual(["owner"]);
    expect(await local.rolesFor(player)).toEqual([]);
    expect(await local.can(player, "players.ban")).toBe(false);

    await roles.grant(player.accountId, "admin", null);
    expect(await local.rolesFor(player)).toEqual(["admin"]);
  });

  it("без флага dev-alex получает роли из базы, как любой аккаунт", async () => {
    const dev = account("dev-alex");
    expect(await service.rolesFor(dev)).toEqual([]);
    await roles.grant(dev.accountId, "moderator", null);
    expect(await service.rolesFor(dev)).toEqual(["moderator"]);
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

describe("уровни ролей (T-0216)", () => {
  it("уровни по таблице решения: владелец выше всех, финансы и участник — наравне, аналитик ниже всех", () => {
    expect(ROLE_LEVELS).toEqual({ owner: 100, stakeholder: 90, finance: 90, admin: 80, game_designer: 50, marketer: 50, moderator: 40, analyst: 30 });
    expect(Object.keys(ROLE_LEVELS).sort()).toEqual([...ROLES].sort());
  });

  it("levelOf — наибольший уровень из ролей; без ролей — ноль", () => {
    expect(levelOf([])).toBe(0);
    expect(levelOf(["analyst", "moderator"])).toBe(40);
    expect(levelOf(["marketer", "admin"])).toBe(80);
  });

  it("админ выдаёт аналитика игроку без ролей, а админа, финансы, участника и владельца — нет", () => {
    expect(canManage(["admin"], [], "analyst")).toBe(true);
    for (const role of ["game_designer", "marketer", "moderator"] as const) expect(canManage(["admin"], [], role)).toBe(true);
    for (const role of ["admin", "finance", "stakeholder", "owner"] as const) expect(canManage(["admin"], [], role)).toBe(false);
  });

  it("аккаунт не ниже себя админ не трогает: ни владельца, ни другого администратора, ни финансы", () => {
    expect(canManage(["admin"], ["owner"], "analyst")).toBe(false);
    expect(canManage(["admin"], ["admin"], "analyst")).toBe(false);
    expect(canManage(["admin"], ["finance"], "analyst")).toBe(false);
    expect(canManage(["admin"], ["moderator", "analyst"], "analyst")).toBe(true);
  });

  it("владелец выдаёт и снимает любые роли, в том числе owner и у других владельцев", () => {
    for (const role of ROLES) expect(canManage(["owner"], [], role)).toBe(true);
    expect(canManage(["owner"], ["owner"], "owner")).toBe(true);
    expect(canManage(["owner", "analyst"], ["admin"], "admin")).toBe(true);
  });

  it("аналитик (право roles.assign у него гипотетическое) не управляет никакой ролью не ниже 30", () => {
    for (const role of ROLES) expect(canManage(["analyst"], [], role)).toBe(false);
  });

  it("без ролей — никому и ничего", () => {
    for (const role of ROLES) expect(canManage([], [], role)).toBe(false);
  });
});

describe("уровни ролей в выдаче и снятии (T-0216)", () => {
  let roles: MemoryRolesRepository;
  let service: RolesService;
  let owner: AccountRef;
  let admin: AccountRef;

  beforeEach(async () => {
    roles = new MemoryRolesRepository();
    service = new RolesService(config(), roles, new MemoryAccountRepository());
    owner = account(ADMIN_TELEGRAM_ID);
    admin = account("700");
    await roles.grant(admin.accountId, "admin", null);
  });

  it("админ выдаёт маркетолога: роль есть, в журнале он исполнитель", async () => {
    const target = randomUUID();

    expect(await service.grant(admin, target, "marketer")).toBe(true);
    expect(await roles.rolesOf(target)).toEqual(["marketer"]);
    expect(roles.entries.at(-1)).toMatchObject({ action: "roles.assign", actorAccountId: admin.accountId, target, after: { role: "marketer" } });
  });

  it("админ не выдаёт роль не ниже своей: отказ с текстом, роли нет, журнал пуст", async () => {
    const target = randomUUID();
    const before = roles.entries.length;

    for (const role of ["admin", "finance", "stakeholder", "owner"] as const) {
      await expect(service.grant(admin, target, role)).rejects.toThrowError("Эту роль может выдать только тот, у кого роль выше");
    }
    expect(await roles.rolesOf(target)).toEqual([]);
    expect(roles.entries).toHaveLength(before);
  });

  it("админ не меняет роли аккаунта не ниже себя: ни выдать, ни снять", async () => {
    const colleague = randomUUID();
    await roles.grant(colleague, "admin", null);
    const boss = randomUUID();
    await roles.grant(boss, "owner", null);
    await roles.grant(boss, "analyst", null);

    await expect(service.grant(admin, colleague, "analyst")).rejects.toThrowError("У этого аккаунта роль не ниже вашей — менять её роли нельзя");
    await expect(service.revoke(admin, boss, "analyst")).rejects.toThrowError("У этого аккаунта роль не ниже вашей — менять её роли нельзя");
    expect(await roles.rolesOf(boss)).toEqual(["owner", "analyst"]);
  });

  it("админ снимает роль ниже своей у аккаунта ниже себя", async () => {
    const target = randomUUID();
    await service.grant(admin, target, "moderator");

    expect(await service.revoke(admin, target, "moderator")).toBe(true);
    expect(await roles.rolesOf(target)).toEqual([]);
  });

  it("владелец по-прежнему выдаёт и снимает любые роли", async () => {
    const target = randomUUID();
    expect(await service.grant(owner, target, "admin")).toBe(true);
    expect(await service.grant(owner, target, "finance")).toBe(true);
    expect(await service.revoke(owner, target, "admin")).toBe(true);
  });

  it("себе по-прежнему нельзя — и админу тоже", async () => {
    await expect(service.grant(admin, admin.accountId, "analyst")).rejects.toThrow(/себе/);
    await expect(service.revoke(admin, admin.accountId, "admin")).rejects.toThrow(/себя/);
  });

  it("список выданных ролей админ читает целиком — это чтение", async () => {
    const rows = await service.assignments(admin);
    expect(rows.some((row) => row.role === "admin" && row.accountId === admin.accountId)).toBe(true);
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
