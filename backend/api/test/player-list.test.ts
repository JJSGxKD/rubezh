import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminPlayersController } from "../src/modules/admin/admin-players.controller.js";
import { AdminPlayersService } from "../src/modules/admin/admin-players.service.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { decodePlayerCursor, encodePlayerCursor, playerListQuerySchema } from "../src/modules/player-list/player-list-query.js";
import type { PlayerListRepository, PlayerListRow, PlayerPage } from "../src/modules/player-list/player-list.repository.js";
import { PlayerListService } from "../src/modules/player-list/player-list.service.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

// Список игроков в панели (docs/35-stage4-plan.md WP32): фильтры из адреса —
// граница, курсор — своей сортировки, права — как у карточки: без права на
// персональные данные нет идентификаторов, без права на выручку — оплат.

const ID = "8f7c1c1e-7f0a-4b8e-9d7e-1c2b3a4d5e6f";

describe("запрос списка", () => {
  it("умолчания, «да/нет», даты и уровни", () => {
    expect(playerListQuerySchema.parse({})).toEqual({ sort: "registered", order: "desc", limit: 50 });
    expect(playerListQuerySchema.parse({ payer: "yes", banned: "no", levelMin: "3", registeredFrom: "2026-09-01", seenTo: "2026-09-30T12:00:00Z", sort: "level", limit: "20" })).toMatchObject({
      payer: true,
      banned: false,
      levelMin: 3,
      registeredFrom: new Date("2026-09-01"),
      seenTo: new Date("2026-09-30T12:00:00Z"),
      sort: "level",
      limit: 20,
    });
  });

  it("ограничения: хоть одно, ни одного или вид из каталога", () => {
    expect(playerListQuerySchema.parse({ restricted: "any" }).restricted).toBe("any");
    expect(playerListQuerySchema.parse({ restricted: "none" }).restricted).toBe("none");
    expect(playerListQuerySchema.parse({ restricted: "leaderboard" }).restricted).toBe("leaderboard");
    expect(playerListQuerySchema.safeParse({ restricted: "everything" }).success).toBe(false);
  });

  it("мусор и противоречия — отказ, а не пустой список", () => {
    for (const bad of [{ levelMin: "5", levelMax: "2" }, { registeredFrom: "2026-09-30", registeredTo: "2026-09-01" }, { payer: "maybe" }, { platform: "icq" }, { limit: "500" }, { sort: "name" }, { unknown: "1" }, { campaign: "Кампания" }, { levelMin: "0" }]) {
      expect(playerListQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("курсор — своей сортировки; чужой и испорченный — ошибка запроса", () => {
    const cursor = encodePlayerCursor({ sort: "seen", value: 1_759_000_000_000, accountId: ID });
    expect(decodePlayerCursor(cursor, "seen")).toEqual({ sort: "seen", value: 1_759_000_000_000, accountId: ID });
    expect(() => decodePlayerCursor(cursor, "level")).toThrow(/курсор/);
    expect(() => decodePlayerCursor(Buffer.from("seen:1; DROP TABLE account").toString("base64url"), "seen")).toThrow(/курсор/);
  });
});

function row(index: number): PlayerListRow {
  return {
    accountId: `00000000-0000-4000-8000-00000000000${String(index)}`,
    platform: "telegram",
    displayName: `Игрок ${String(index)}`,
    photoUrl: null,
    platformUserId: String(700 + index),
    username: "dym",
    createdAt: new Date(Date.UTC(2026, 8, index + 1)),
    lastSeenAt: new Date(Date.UTC(2026, 8, 30)),
    bannedAt: null,
    banReason: null,
    restrictions: index === 1 ? ["leaderboard", "promo_codes"] : [],
    level: 10 - index,
    source: "invite",
    campaign: null,
    payer: true,
    canMessage: true,
  };
}

class FakeList implements PlayerListRepository {
  readonly calls: PlayerPage[] = [];
  constructor(readonly rows: PlayerListRow[]) {}
  async page(page: PlayerPage): Promise<PlayerListRow[]> {
    this.calls.push(page);
    return this.rows.slice(0, page.limit);
  }
}

const OWNER_ID = "777000111";
const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);

async function actor(accounts: MemoryAccountRepository, roles: MemoryRolesRepository, id: string, role?: "moderator" | "admin"): Promise<AccountRef> {
  const account = await accounts.upsert({ platform: "telegram", platformUserId: id, displayName: "Команда", username: null, photoUrl: null }, Date.now());
  if (role !== undefined) await roles.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: "telegram", platformUserId: id };
}

describe("список в сервисе", () => {
  it("страница на одну строку длиннее — отсюда курсор; модератор без идентификаторов и оплат", async () => {
    const accounts = new MemoryAccountRepository();
    const roles = new MemoryRolesRepository();
    const repository = new FakeList([row(1), row(2), row(3)]);
    const service = new PlayerListService(repository, new RolesService(config(), roles, accounts));
    const moderator = await actor(accounts, roles, "600001", "moderator");

    const view = await service.list(moderator, playerListQuerySchema.parse({ sort: "level", limit: "2" }));
    expect(repository.calls[0]).toMatchObject({ sort: "level", order: "desc", cursor: null, limit: 3 });
    expect(view.players).toHaveLength(2);
    expect(view.players[0]).toMatchObject({ pii: null, payer: null, level: 9, canMessage: true, restrictions: ["leaderboard", "promo_codes"] });
    expect(view.nextCursor).not.toBeNull();
    expect(decodePlayerCursor(view.nextCursor ?? "", "level")).toEqual({ sort: "level", value: 8, accountId: row(2).accountId });
    expect(await roles.recentAudit(5)).toEqual([]);

    await expect(service.list(moderator, playerListQuerySchema.parse({ payer: "yes" }))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("владелец видит идентификаторы и оплаты — и это в аудите; последняя страница без курсора", async () => {
    const accounts = new MemoryAccountRepository();
    const roles = new MemoryRolesRepository();
    const service = new PlayerListService(new FakeList([row(1)]), new RolesService(config(), roles, accounts));
    const owner = await actor(accounts, roles, OWNER_ID);
    const view = await service.list(owner, playerListQuerySchema.parse({ payer: "yes" }));
    expect(view).toMatchObject({ nextCursor: null, players: [{ payer: true, pii: { platformUserId: "701", username: "dym" } }] });
    expect((await roles.recentAudit(5)).map((entry) => entry.action)).toEqual(["players.pii.view"]);

    const stranger = await actor(accounts, roles, "5");
    await expect(service.list(stranger, playerListQuerySchema.parse({}))).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("список по HTTP", () => {
  let app: NestFastifyApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("/admin/players/list — список, а не карточка игрока «list»; мусор в фильтрах — 400", async () => {
    const accounts = new MemoryAccountRepository();
    const roles = new MemoryRolesRepository();
    const store = new MemoryAdminSessionStore();
    const repository = new FakeList([row(1)]);
    @Module({
      controllers: [AdminPlayersController],
      providers: [
        { provide: APP_CONFIG, useValue: config() },
        { provide: REDIS, useValue: { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: AdminPlayersService, useValue: {} },
        { provide: WalletService, useValue: {} },
        { provide: PlayerListService, useFactory: (rolesService: RolesService) => new PlayerListService(repository, rolesService), inject: [RolesService] },
        RateLimiter,
        RolesService,
        PermissionGuard,
        AdminSessionService,
        AdminSessionGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const moderator = await actor(accounts, roles, "600001", "moderator");
    await store.put(hashSessionToken("mod"), { ...moderator, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=mod` };

    const list = await app.inject({ method: "GET", url: "/api/v1/admin/players/list?sort=seen&canMessage=yes", headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.players[0]).toMatchObject({ displayName: "Игрок 1", pii: null, payer: null });
    expect(repository.calls[0]).toMatchObject({ sort: "seen", filters: { canMessage: true } });
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/players/list?levelMin=abc", headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/players/list?payer=yes", headers })).statusCode).toBe(403);
  });
});
