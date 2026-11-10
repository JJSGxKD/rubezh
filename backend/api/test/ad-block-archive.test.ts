import "reflect-metadata";
import { Logger, Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { AdminAdBlockArchiveController } from "../src/modules/admin/admin-ad-block-archive.controller.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { AdBlockArchiveService } from "../src/modules/ads/ad-block-archive.service.js";
import type { AdBlockDef, AdCatalogBlock, AdFunnelRow, AdNetworkRow, AdPassRow, AdsCatalogRepository } from "../src/modules/ads/ads-catalog.repository.js";
import { AdsCatalogService, type AdBlockEdit } from "../src/modules/ads/ads-catalog.service.js";
import { AdBlockArchivedError, AdCatalogNotFoundError } from "../src/modules/ads/ads-errors.js";
import type { AdsService } from "../src/modules/ads/ads.service.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Архив рекламных блоков (docs/35-stage4-plan.md Р200, tasks/T-0409): «В
 * архив» выключает блок и ставит отметку одной записью, «Вернуть» снимает
 * отметку, но блок остаётся выключенным. Повтор ничего не пишет и не аудирует,
 * блок в архиве не правится, а право — то же, что у остальных правок блока.
 */

const OWNER_ID = "777000333";
const BLOCK = "00000000-0000-4000-8000-000000000001";
const OTHER_BLOCK = "00000000-0000-4000-8000-000000000002";
const MISSING_BLOCK = "00000000-0000-4000-8000-0000000000ff";
const AT = new Date(Date.UTC(2026, 10, 9, 12));
const NOON = new Date(Date.UTC(2026, 10, 9, 9));

const row = (overrides: Partial<AdBlockDef> = {}): AdBlockDef => ({
  blockId: BLOCK,
  networkKey: "adsgram",
  place: "wheel_spin",
  externalId: "1234",
  success: "view",
  active: true,
  platforms: ["telegram"],
  devices: [],
  ...overrides,
});

/** Каталог в памяти: отметка архива — в `archived`, строки блоков остаются литералами `AdBlockDef`. */
class MemoryCatalog implements AdsCatalogRepository {
  blockRows: AdBlockDef[] = [row()];
  archived = new Map<string, string>();
  /** сколько раз `setBlockArchived` действительно что-то записал */
  writes = 0;

  async networks(): Promise<AdNetworkRow[]> {
    return [{ networkKey: "adsgram", name: "AdsGram", active: true, priority: 10, keys: {} }];
  }

  async blocks(): Promise<AdCatalogBlock[]> {
    return this.blockRows.map((candidate) => ({ ...candidate, archivedAt: this.archived.get(candidate.blockId) ?? null }));
  }

  async setBlockArchived(blockId: string, archived: boolean, _actorAccountId: string, at: Date): Promise<{ block: AdCatalogBlock; changed: boolean } | null> {
    const target = this.blockRows.find((candidate) => candidate.blockId === blockId);
    if (target === undefined) return null;
    const changed = archived !== this.archived.has(blockId);
    if (changed) {
      this.writes += 1;
      if (archived) {
        this.archived.set(blockId, at.toISOString());
        target.active = false;
      } else {
        this.archived.delete(blockId);
      }
    }
    return { block: { ...target, archivedAt: this.archived.get(blockId) ?? null }, changed };
  }

  async updateBlock(block: AdBlockDef): Promise<boolean> {
    const index = this.blockRows.findIndex((candidate) => candidate.blockId === block.blockId);
    if (index < 0 || this.archived.has(block.blockId)) return false;
    this.blockRows[index] = { ...block };
    return true;
  }

  async updateNetwork(): Promise<boolean> {
    throw new Error("архиву сети не нужны");
  }

  async reorderNetworks(): Promise<never> {
    throw new Error("архиву порядок сетей не нужен");
  }

  async insertBlock(): Promise<AdBlockDef | null> {
    throw new Error("архиву новые блоки не нужны");
  }

  // Эти двое нужны только `AdsCatalogService.view`, который проверяется ниже, — архив их не зовёт.
  async funnel(): Promise<AdFunnelRow[]> {
    return [];
  }

  async passes(): Promise<AdPassRow[]> {
    return [];
  }
}

/** Блок уходит в архив (или пропадает) между чтением правки и её записью — гонка, которую ловит условие в `UPDATE`. */
class RacingCatalog extends MemoryCatalog {
  private reads = 0;

  constructor(private readonly race: (catalog: MemoryCatalog) => void) {
    super();
  }

  override async blocks(): Promise<AdCatalogBlock[]> {
    const rows = await super.blocks();
    this.reads += 1;
    if (this.reads === 1) this.race(this);
    return rows;
  }
}

function setup(repository: MemoryCatalog = new MemoryCatalog()) {
  const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
  const accounts = new MemoryAccountRepository();
  const roles = new MemoryRolesRepository();
  let forgotten = 0;
  const ads = { forgetBlocks: () => forgotten++ } as unknown as AdsService;
  const rolesService = new RolesService(config, roles, accounts);
  const archive = new AdBlockArchiveService(repository, rolesService, ads);
  const catalog = new AdsCatalogService(repository, rolesService, ads, panelSettings());
  return { config, repository, accounts, roles, archive, catalog, forgotten: () => forgotten };
}

async function person(ctx: ReturnType<typeof setup>, id: string, role: "admin" | "game_designer" | "moderator"): Promise<AccountRef> {
  const account = await ctx.accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, Date.now());
  await ctx.roles.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

const edit = (overrides: Partial<AdBlockEdit> = {}): AdBlockEdit => ({
  blockId: BLOCK,
  networkKey: "adsgram",
  place: "wheel_spin",
  externalId: "5678",
  success: "view",
  active: true,
  platforms: ["telegram"],
  devices: [],
  ...overrides,
});

const auditOf = async (ctx: ReturnType<typeof setup>, action: string) => (await ctx.roles.recentAudit(20)).filter((entry) => entry.action === action);

describe("архив рекламных блоков: сервис", () => {
  it("«В архив» выключает блок и ставит отметку; одна запись аудита, запас блоков сброшен один раз, строка лога", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    try {
      const ctx = setup();
      const admin = await person(ctx, "801", "admin");

      const archived = await ctx.archive.archive(admin, BLOCK, AT);
      expect(archived).toMatchObject({ blockId: BLOCK, active: false, archivedAt: AT.toISOString() });
      expect(ctx.repository.writes).toBe(1);

      const audit = await auditOf(ctx, "ads.block.archive");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorAccountId: admin.accountId, target: BLOCK, before: { active: true, archivedAt: null }, after: { active: false, archivedAt: AT.toISOString() } });
      expect(ctx.forgotten()).toBe(1);

      const lines = log.mock.calls.map(([message]) => String(message)).filter((message) => message.includes("ad_block_archived"));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "{}")).toEqual({ module: "ads", event: "ad_block_archived", blockId: BLOCK, actor: admin.accountId });
    } finally {
      log.mockRestore();
    }
  });

  it("повторный «В архив»: тот же блок, записи, аудита и сброса запаса нет", async () => {
    const ctx = setup();
    const admin = await person(ctx, "802", "admin");
    const first = await ctx.archive.archive(admin, BLOCK, AT);

    const again = await ctx.archive.archive(admin, BLOCK, new Date(AT.getTime() + 60_000));
    expect(again).toEqual(first);
    expect(again.archivedAt).toBe(AT.toISOString());
    expect(ctx.repository.writes).toBe(1);
    expect(await auditOf(ctx, "ads.block.archive")).toHaveLength(1);
    expect(ctx.forgotten()).toBe(1);
  });

  it("«Вернуть» снимает отметку, но блок остаётся выключенным; аудит ads.block.unarchive", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    try {
      const ctx = setup();
      const admin = await person(ctx, "803", "admin");
      await ctx.archive.archive(admin, BLOCK, AT);

      const restored = await ctx.archive.unarchive(admin, BLOCK, new Date(AT.getTime() + 60_000));
      expect(restored).toMatchObject({ blockId: BLOCK, active: false, archivedAt: null });
      expect(ctx.repository.archived.has(BLOCK)).toBe(false);

      const audit = await auditOf(ctx, "ads.block.unarchive");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorAccountId: admin.accountId, target: BLOCK, before: { active: false, archivedAt: AT.toISOString() }, after: { active: false, archivedAt: null } });
      expect(ctx.forgotten()).toBe(2);

      const lines = log.mock.calls.map(([message]) => String(message)).filter((message) => message.includes("ad_block_unarchived"));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "{}")).toEqual({ module: "ads", event: "ad_block_unarchived", blockId: BLOCK, actor: admin.accountId });
    } finally {
      log.mockRestore();
    }
  });

  it("«Вернуть» для блока не из архива: тот же блок, без записи, аудита и сброса запаса", async () => {
    const ctx = setup();
    const admin = await person(ctx, "804", "admin");

    const block = await ctx.archive.unarchive(admin, BLOCK, AT);
    expect(block).toMatchObject({ blockId: BLOCK, active: true, archivedAt: null });
    expect(ctx.repository.writes).toBe(0);
    expect(await ctx.roles.recentAudit(10)).toHaveLength(0);
    expect(ctx.forgotten()).toBe(0);
  });

  it("неизвестный блок — 404 ad_block_not_found для обоих действий, ничего не записано", async () => {
    const ctx = setup();
    const admin = await person(ctx, "805", "admin");
    for (const act of [ctx.archive.archive.bind(ctx.archive), ctx.archive.unarchive.bind(ctx.archive)]) {
      const error = await act(admin, MISSING_BLOCK, AT).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AdCatalogNotFoundError);
      expect(error).toMatchObject({ code: "ad_block_not_found", status: 404 });
    }
    expect(ctx.repository.writes).toBe(0);
    expect(await ctx.roles.recentAudit(10)).toHaveLength(0);
  });

  it("без ads.edit — отказ, записи, аудита и сброса запаса нет (геймдизайнер только читает, модератор не видит)", async () => {
    const ctx = setup();
    const designer = await person(ctx, "806", "game_designer");
    const moderator = await person(ctx, "807", "moderator");
    for (const actor of [designer, moderator]) {
      for (const act of [ctx.archive.archive.bind(ctx.archive), ctx.archive.unarchive.bind(ctx.archive)]) {
        const error = await act(actor, BLOCK, AT).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: "forbidden", status: 403 });
      }
    }
    expect(ctx.repository.writes).toBe(0);
    expect(ctx.repository.blockRows[0]?.active).toBe(true);
    expect(await ctx.roles.recentAudit(10)).toHaveLength(0);
    expect(ctx.forgotten()).toBe(0);
  });
});

describe("архив рекламных блоков: правка и список", () => {
  it("правка блока в архиве — 409 ad_block_archived, строка не изменилась, аудита и сброса запаса нет", async () => {
    const ctx = setup();
    const admin = await person(ctx, "811", "admin");
    await ctx.archive.archive(admin, BLOCK, AT);
    const forgottenBefore = ctx.forgotten();

    const error = await ctx.catalog.saveBlock(admin, edit()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdBlockArchivedError);
    expect(error).toMatchObject({ code: "ad_block_archived", status: 409 });
    expect(ctx.repository.blockRows[0]).toEqual(row({ active: false }));
    expect(await auditOf(ctx, "ads.block.update")).toHaveLength(0);
    expect(ctx.forgotten()).toBe(forgottenBefore);
  });

  it("после «Вернуть» блок правится как прежде, и включают его правкой", async () => {
    const ctx = setup();
    const admin = await person(ctx, "812", "admin");
    await ctx.archive.archive(admin, BLOCK, AT);
    await ctx.archive.unarchive(admin, BLOCK, AT);

    expect(await ctx.catalog.saveBlock(admin, edit({ active: true }))).toMatchObject({ blockId: BLOCK, externalId: "5678", active: true });
    expect(ctx.repository.blockRows[0]).toMatchObject({ externalId: "5678", active: true });
  });

  it("блок ушёл в архив между чтением правки и записью: условие в записи не даёт его включить, ответ тот же 409", async () => {
    const catalog = new RacingCatalog((racing) => void racing.archived.set(BLOCK, AT.toISOString()));
    const ctx = setup(catalog);
    const admin = await person(ctx, "813", "admin");

    await expect(ctx.catalog.saveBlock(admin, edit({ active: true }))).rejects.toBeInstanceOf(AdBlockArchivedError);
    expect(catalog.blockRows[0]).toEqual(row());
    expect(await auditOf(ctx, "ads.block.update")).toHaveLength(0);
  });

  it("блок пропал между чтением правки и записью — 404, а не 409", async () => {
    const catalog = new RacingCatalog((racing) => void (racing.blockRows = []));
    const ctx = setup(catalog);
    const admin = await person(ctx, "814", "admin");

    await expect(ctx.catalog.saveBlock(admin, edit())).rejects.toBeInstanceOf(AdCatalogNotFoundError);
  });

  it("панель получает отметку архива строкой ISO у блока в архиве и null у остальных", async () => {
    const ctx = setup();
    ctx.repository.blockRows.push(row({ blockId: OTHER_BLOCK, place: "run_double", externalId: "9876" }));
    const admin = await person(ctx, "815", "admin");
    await ctx.archive.archive(admin, BLOCK, AT);

    const view = await ctx.catalog.view(admin, 7, NOON);
    expect(view.blocks.map((block) => [block.blockId, block.archivedAt, block.active])).toEqual([
      [BLOCK, AT.toISOString(), false],
      [OTHER_BLOCK, null, true],
    ]);
  });
});

describe("архив рекламных блоков по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("архив и возврат: 201 с блоком, не UUID — 400, неизвестный — 404, без заголовка панели — 403, геймдизайнеру закрыто", async () => {
    const ctx = setup();
    const store = new MemoryAdminSessionStore();
    @Module({
      controllers: [AdminAdBlockArchiveController],
      providers: [
        { provide: APP_CONFIG, useValue: ctx.config },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ACCOUNT_REPOSITORY, useValue: ctx.accounts },
        { provide: ROLES_REPOSITORY, useValue: ctx.roles },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: AdBlockArchiveService, useValue: ctx.archive },
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

    const admin = await person(ctx, "821", "admin");
    await store.put(hashSessionToken("admin"), { ...admin, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    const cookie = `${ADMIN_SESSION_COOKIE}=admin`;
    const headers = { cookie, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE };

    const archived = await app.inject({ method: "POST", url: `/api/v1/admin/ads/blocks/${BLOCK}/archive`, headers });
    expect(archived.statusCode).toBe(201);
    expect(archived.json<{ data: { blockId: string; active: boolean; archivedAt: string | null } }>().data).toMatchObject({ blockId: BLOCK, active: false });
    expect(archived.json<{ data: { archivedAt: string | null } }>().data.archivedAt).not.toBeNull();

    const restored = await app.inject({ method: "POST", url: `/api/v1/admin/ads/blocks/${BLOCK}/unarchive`, headers });
    expect(restored.statusCode).toBe(201);
    expect(restored.json<{ data: { active: boolean; archivedAt: string | null } }>().data).toMatchObject({ active: false, archivedAt: null });

    expect((await app.inject({ method: "POST", url: "/api/v1/admin/ads/blocks/not-a-uuid/archive", headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/ads/blocks/not-a-uuid/unarchive", headers })).statusCode).toBe(400);
    const missing = await app.inject({ method: "POST", url: `/api/v1/admin/ads/blocks/${MISSING_BLOCK}/archive`, headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe("ad_block_not_found");

    // без заголовка панели изменяющая ручка закрыта
    expect((await app.inject({ method: "POST", url: `/api/v1/admin/ads/blocks/${BLOCK}/archive`, headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/v1/admin/ads/blocks/${BLOCK}/archive` })).statusCode).toBe(401);

    const designer = await person(ctx, "822", "game_designer");
    await store.put(hashSessionToken("designer"), { ...designer, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    const asDesigner = { cookie: `${ADMIN_SESSION_COOKIE}=designer`, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE };
    expect((await app.inject({ method: "POST", url: `/api/v1/admin/ads/blocks/${BLOCK}/archive`, headers: asDesigner })).statusCode).toBe(403);
    expect(ctx.repository.archived.has(BLOCK)).toBe(false);
  });
});
