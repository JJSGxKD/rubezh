import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { CONFIRMED_ROLES, ROLE_CONFIRM_PREFIX, ROLE_CONFIRM_TTL_SEC, RoleConfirmations } from "../src/modules/admin/role-confirmations.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Выдача ролей владельца и администратора (docs/29-admin-panel.md §3.4,
 * правило двух ключей): запрос открывает панель, подтверждает только тот, кто
 * выдаёт, в личном чате с ботом. Чужое нажатие запрос не сжигает, истёкший
 * и уже решённый не подтверждаются, права проверяются в момент подтверждения.
 */

const OWNER_ID = "777000111";
const STRANGER_ID = "555000222";
const TARGET_ID = "600002";
const NOW = Date.UTC(2026, 9, 11, 12);

/** Redis ровно настолько, насколько его трогает хранилище запросов: SET со сроком и GETDEL. */
class FakeRedis {
  readonly values = new Map<string, string>();
  readonly ttlMs = new Map<string, number>();

  async set(key: string, value: string, mode: "EX" | "PX", amount: number, nx?: "NX"): Promise<"OK" | null> {
    if (nx === "NX" && this.values.has(key)) return null;
    this.values.set(key, value);
    this.ttlMs.set(key, mode === "EX" ? amount * 1000 : amount);
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async getdel(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }

  /** Срок вышел: Redis сам убрал бы ключ. */
  expireAll(): void {
    this.values.clear();
  }
}

function config(patch: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: "1", TELEGRAM_BOT_UPDATES: "polling", ...patch } as NodeJS.ProcessEnv);
}

async function setup(options: { botUsername?: string | null } = {}) {
  const cfg = config();
  const accounts = new MemoryAccountRepository();
  const rolesRepository = new MemoryRolesRepository();
  const roles = new RolesService(cfg, rolesRepository, accounts);
  const redis = new FakeRedis();
  const username = options.botUsername === undefined ? "rubezh_bot" : options.botUsername;
  const links = new AppLinks([new TelegramAppLinks({ miniAppLink: username === null ? null : `https://t.me/${username}?startapp`, username })]);
  const confirmations = new RoleConfirmations(redis as unknown as Redis, accounts, roles, links);

  const ownerAccount = await accounts.upsert({ platform: "telegram", platformUserId: OWNER_ID, displayName: "Владелец", username: null, photoUrl: null }, NOW);
  await rolesRepository.grant(ownerAccount.accountId, "owner", null);
  const target = await accounts.upsert({ platform: "telegram", platformUserId: TARGET_ID, displayName: "Юра", username: null, photoUrl: null }, NOW);
  const actor: AccountRef = { accountId: ownerAccount.accountId, platform: "telegram", platformUserId: OWNER_ID };
  return { accounts, rolesRepository, roles, redis, confirmations, ownerAccount, target, actor };
}

const idOf = (link: string): string => link.slice(link.indexOf(ROLE_CONFIRM_PREFIX) + ROLE_CONFIRM_PREFIX.length);

describe("запрос на выдачу роли", () => {
  it("роли под подтверждением — только владелец и администратор", () => {
    expect(CONFIRMED_ROLES).toEqual(["owner", "admin"]);
  });

  it("открывается ссылкой на бота, запись живёт десять минут", async () => {
    const { confirmations, redis, actor, target } = await setup();
    const opened = await confirmations.open(actor, target.accountId, "admin", NOW);
    expect(opened.link).toMatch(/^https:\/\/t\.me\/rubezh_bot\?start=role-[A-Za-z0-9_-]{22}$/);
    expect(opened.expiresAtMs).toBe(NOW + ROLE_CONFIRM_TTL_SEC * 1000);
    expect(ROLE_CONFIRM_TTL_SEC).toBe(600);
    const key = `admin:role-confirm:${idOf(opened.link)}`;
    expect(redis.ttlMs.get(key)).toBe(600_000);
    expect(JSON.parse(redis.values.get(key) ?? "{}")).toEqual({
      actorAccountId: actor.accountId,
      actorPlatformUserId: OWNER_ID,
      targetAccountId: target.accountId,
      role: "admin",
      createdAtMs: NOW,
    });
  });

  it("не из Telegram — отказ: подтвердить некому", async () => {
    const { confirmations, actor, target } = await setup();
    await expect(confirmations.open({ ...actor, platform: "max" }, target.accountId, "admin", NOW)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("бот ещё не представился — запрос не открыть", async () => {
    const { confirmations, actor, target } = await setup({ botUsername: null });
    await expect(confirmations.open(actor, target.accountId, "admin", NOW)).rejects.toMatchObject({ code: "store_unavailable" });
  });
});

describe("что показать в боте", () => {
  it("своему — кому и какую роль, чужому — «foreign», истёкшему и кривому — «expired»", async () => {
    const { confirmations, redis, actor, target } = await setup();
    const { link } = await confirmations.open(actor, target.accountId, "admin", NOW);
    const requestId = idOf(link);

    expect(await confirmations.prompt(requestId, OWNER_ID)).toEqual({
      roleTitle: "Администратор",
      targetName: "Юра",
      targetPlatformUserId: TARGET_ID,
      expiresAtMs: NOW + 600_000,
    });
    expect(await confirmations.prompt(requestId, STRANGER_ID)).toBe("foreign");
    // Просмотр запрос не расходует.
    expect(await confirmations.prompt(requestId, OWNER_ID)).toMatchObject({ targetName: "Юра" });

    expect(await confirmations.prompt("нет-такого", OWNER_ID)).toBe("expired");
    redis.expireAll();
    expect(await confirmations.prompt(requestId, OWNER_ID)).toBe("expired");
  });
});

describe("подтверждение", () => {
  it("свой — роль выдана и записана в журнал, повторное нажатие — «expired»", async () => {
    const { confirmations, rolesRepository, roles, actor, target } = await setup();
    const requestId = idOf((await confirmations.open(actor, target.accountId, "admin", NOW)).link);

    expect(await confirmations.confirm(requestId, OWNER_ID, NOW + 1000)).toBe("granted");
    expect(await roles.rolesFor({ accountId: target.accountId, platform: "telegram", platformUserId: TARGET_ID })).toEqual(["admin"]);
    expect(rolesRepository.entries).toEqual([expect.objectContaining({ actorAccountId: actor.accountId, action: "roles.assign", target: target.accountId, after: { role: "admin" } })]);
    expect(await confirmations.confirm(requestId, OWNER_ID, NOW + 2000)).toBe("expired");
    expect(rolesRepository.entries).toHaveLength(1);
  });

  it("чужой Telegram запрос не подтверждает и не сжигает: свой потом проходит", async () => {
    const { confirmations, redis, actor, target } = await setup();
    const requestId = idOf((await confirmations.open(actor, target.accountId, "owner", NOW)).link);

    expect(await confirmations.confirm(requestId, STRANGER_ID, NOW + 60_000)).toBe("foreign");
    // Запрос вернулся с оставшимся сроком, а не с новым.
    expect(redis.ttlMs.get(`admin:role-confirm:${requestId}`)).toBe(540_000);
    expect(await confirmations.confirm(requestId, OWNER_ID, NOW + 61_000)).toBe("granted");
  });

  it("после срока — «expired», даже если запись ещё не убрана", async () => {
    const { confirmations, roles, actor, target } = await setup();
    const requestId = idOf((await confirmations.open(actor, target.accountId, "admin", NOW)).link);
    expect(await confirmations.confirm(requestId, OWNER_ID, NOW + 601_000)).toBe("expired");
    expect(await roles.rolesFor({ accountId: target.accountId, platform: "telegram", platformUserId: TARGET_ID })).toEqual([]);
  });

  it("у выдающего забрали право до подтверждения — «no_right», роль не выдана", async () => {
    const { confirmations, rolesRepository, roles, actor, ownerAccount, target } = await setup();
    const requestId = idOf((await confirmations.open(actor, target.accountId, "admin", NOW)).link);
    await rolesRepository.revoke(ownerAccount.accountId, "owner");

    expect(await confirmations.confirm(requestId, OWNER_ID, NOW + 1000)).toBe("no_right");
    expect(await roles.rolesFor({ accountId: target.accountId, platform: "telegram", platformUserId: TARGET_ID })).toEqual([]);
  });

  it("у цели роль уже есть — «already»", async () => {
    const { confirmations, rolesRepository, actor, target } = await setup();
    await rolesRepository.grant(target.accountId, "admin", null);
    const requestId = idOf((await confirmations.open(actor, target.accountId, "admin", NOW)).link);
    expect(await confirmations.confirm(requestId, OWNER_ID, NOW + 1000)).toBe("already");
  });

  it("кривой номер запроса — «expired», в Redis не ходит", async () => {
    const { confirmations, redis } = await setup();
    expect(await confirmations.confirm("../../x", OWNER_ID, NOW)).toBe("expired");
    expect(redis.values.size).toBe(0);
  });
});

describe("отмена", () => {
  it("своя убирает запрос: подтвердить его потом нельзя", async () => {
    const { confirmations, actor, target } = await setup();
    const requestId = idOf((await confirmations.open(actor, target.accountId, "admin", NOW)).link);
    expect(await confirmations.decline(requestId, OWNER_ID, NOW + 1000)).toBe(true);
    expect(await confirmations.confirm(requestId, OWNER_ID, NOW + 2000)).toBe("expired");
  });

  it("чужая запрос не трогает", async () => {
    const { confirmations, actor, target } = await setup();
    const requestId = idOf((await confirmations.open(actor, target.accountId, "admin", NOW)).link);
    expect(await confirmations.decline(requestId, STRANGER_ID, NOW + 1000)).toBe(false);
    expect(await confirmations.confirm(requestId, OWNER_ID, NOW + 2000)).toBe("granted");
  });

  it("несуществующего запроса — нечего отменять", async () => {
    const { confirmations } = await setup();
    expect(await confirmations.decline("A".repeat(22), OWNER_ID, NOW)).toBe(false);
  });
});
