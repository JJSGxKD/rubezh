import "reflect-metadata";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { AdminAdsController } from "../src/modules/admin/admin-ads.controller.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";
import type { AdBlockDef, AdFunnelRow, AdNetworkEdit, AdNetworkRow, AdsCatalogRepository } from "../src/modules/ads/ads-catalog.repository.js";
import { AdsCatalogService, blockEditSchema, networkEditSchema, type AdBlockEdit } from "../src/modules/ads/ads-catalog.service.js";
import { AD_NETWORK_PROFILES } from "../src/modules/ads/ad-networks.js";
import {
  AdBlockInvalidError,
  AdBlockLimitError,
  AdBlockShapeLockedError,
  AdCatalogNotFoundError,
  AdNetworkIncompleteError,
  AdNetworkKeysError,
} from "../src/modules/ads/ads-errors.js";
import type { AdsService } from "../src/modules/ads/ads.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPanelLoginStore } from "./helpers/memory-panel-login.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Реклама в панели (docs/29-admin-panel.md, WP12): сети включают и ставят в
 * круг, блоки заводят и правят без релиза — под своими правами, с аудитом, и
 * выдача показа видит правку сразу.
 */

const OWNER_ID = "777000333";
const NOON = new Date(Date.UTC(2026, 8, 30, 9));

class MemoryCatalog implements AdsCatalogRepository {
  networksRows: AdNetworkRow[] = [
    { networkKey: "adsgram", name: "AdsGram", active: false, priority: 10, keys: {} },
    { networkKey: "richads", name: "RichAds", active: false, priority: 30, keys: {} },
    { networkKey: "taddy", name: "Taddy", active: false, priority: 40, keys: {} },
  ];
  blockRows: AdBlockDef[] = [];
  funnelFrom: Date | null = null;
  private blockNo = 0;

  async networks(): Promise<AdNetworkRow[]> {
    return this.networksRows.map((row) => ({ ...row }));
  }

  async blocks(): Promise<AdBlockDef[]> {
    return this.blockRows.map((row) => ({ ...row }));
  }

  async updateNetwork(edit: AdNetworkEdit): Promise<boolean> {
    const row = this.networksRows.find((network) => network.networkKey === edit.networkKey);
    if (row === undefined) return false;
    Object.assign(row, { active: edit.active, priority: edit.priority, keys: { ...edit.keys } });
    return true;
  }

  async insertBlock(block: Omit<AdBlockDef, "blockId">): Promise<AdBlockDef | null> {
    if (!this.networksRows.some((network) => network.networkKey === block.networkKey)) return null;
    const created = { ...block, blockId: `00000000-0000-4000-8000-${String(++this.blockNo).padStart(12, "0")}` };
    this.blockRows.push(created);
    return { ...created };
  }

  async updateBlock(block: AdBlockDef): Promise<boolean> {
    const index = this.blockRows.findIndex((row) => row.blockId === block.blockId);
    if (index < 0) return false;
    this.blockRows[index] = { ...block };
    return true;
  }

  async funnel(from: Date): Promise<AdFunnelRow[]> {
    this.funnelFrom = from;
    return [{ networkKey: "adsgram", place: "wheel_spin", offered: 10, shown: 8, clicked: 1, completed: 7, claimed: 6, failed: 2 }];
  }
}

function setup(config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv)) {
  const repository = new MemoryCatalog();
  const accounts = new MemoryAccountRepository();
  const roles = new MemoryRolesRepository();
  let forgotten = 0;
  const ads = { forgetBlocks: () => forgotten++ } as unknown as AdsService;
  const settings = panelSettings();
  const service = new AdsCatalogService(repository, new RolesService(config, roles, accounts), ads, settings);
  return { repository, roles, accounts, settings, service, forgotten: () => forgotten };
}

async function person(ctx: ReturnType<typeof setup>, id: string, role?: "admin" | "game_designer" | "moderator"): Promise<AccountRef> {
  const account = await ctx.accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, Date.now());
  if (role !== undefined) await ctx.roles.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

const block = (overrides: Partial<AdBlockEdit> = {}): AdBlockEdit => ({
  blockId: null,
  networkKey: "adsgram",
  place: "wheel_spin",
  externalId: "1234",
  success: "view",
  active: true,
  platforms: ["telegram"],
  devices: [],
  ...overrides,
});

const RICHADS_KEYS = { pubId: "792361", appId: "1396" };

describe("реклама в панели", () => {
  it("администратор включает сеть и заводит блок — в аудите, и выдача показа сбрасывает запас блоков", async () => {
    const ctx = setup();
    const admin = await person(ctx, "701", "admin");

    expect(await ctx.service.saveNetwork(admin, { networkKey: "adsgram", active: true, priority: 5 })).toEqual({
      networkKey: "adsgram",
      name: "AdsGram",
      active: true,
      priority: 5,
      keys: {},
      missing: [],
      problem: null,
    });
    const created = await ctx.service.saveBlock(admin, block());
    expect(created).toMatchObject({ networkKey: "adsgram", place: "wheel_spin", externalId: "1234", platforms: ["telegram"] });
    const updated = await ctx.service.saveBlock(admin, { ...block({ externalId: "5678", active: false, devices: ["android", "ios"] }), blockId: created.blockId });
    expect(updated).toMatchObject({ blockId: created.blockId, externalId: "5678", active: false, devices: ["android", "ios"] });

    const audit = (await ctx.roles.recentAudit(10)).map((entry) => entry.action).sort();
    expect(audit).toEqual(["ads.block.create", "ads.block.update", "ads.network.update"]);
    expect(ctx.forgotten()).toBe(3);
  });

  it("ключи сети — по виду из кабинета; без обязательных сеть не включить; пустое значение снимает ключ", async () => {
    const ctx = setup();
    const admin = await person(ctx, "706", "admin");
    await expect(ctx.service.saveNetwork(admin, { networkKey: "richads", active: true, priority: 30 })).rejects.toBeInstanceOf(AdNetworkIncompleteError);
    await expect(ctx.service.saveNetwork(admin, { networkKey: "richads", active: true, priority: 30, keys: { pubId: "792361" } })).rejects.toThrow(/App ID/);
    await expect(ctx.service.saveNetwork(admin, { networkKey: "richads", active: false, priority: 30, keys: { pubId: "pub-1", appId: "1396" } })).rejects.toBeInstanceOf(AdNetworkKeysError);
    await expect(ctx.service.saveNetwork(admin, { networkKey: "richads", active: false, priority: 30, keys: { token: "1" } })).rejects.toBeInstanceOf(AdNetworkKeysError);
    await expect(ctx.service.saveNetwork(admin, { networkKey: "taddy", active: false, priority: 40, keys: { pubId: "14cbeb98" } })).rejects.toBeInstanceOf(AdNetworkKeysError);
    expect(ctx.repository.networksRows.find((row) => row.networkKey === "richads")).toMatchObject({ active: false, keys: {} });

    // Выключенной сети ключи можно задавать по одному — она ещё готовится.
    expect(await ctx.service.saveNetwork(admin, { networkKey: "richads", active: false, priority: 30, keys: { pubId: "792361", appId: "" } })).toMatchObject({
      keys: { pubId: "792361" },
      missing: ["App ID (appId)"],
    });
    expect(await ctx.service.saveNetwork(admin, { networkKey: "richads", active: true, priority: 30, keys: RICHADS_KEYS })).toMatchObject({ active: true, keys: RICHADS_KEYS, missing: [] });
    // Без ключей в запросе — ключи прежние: место в круге меняют, не трогая их.
    expect(await ctx.service.saveNetwork(admin, { networkKey: "richads", active: true, priority: 3 })).toMatchObject({ priority: 3, keys: RICHADS_KEYS });
    await expect(ctx.service.saveNetwork(admin, { networkKey: "taddy", active: true, priority: 40, keys: { pubId: "14cbeb980853dd416003462ca4db7c12" } })).resolves.toMatchObject({ active: true });
  });

  it("блок — только по профилю сети: место её формата, идентификатор того вида, допустимое условие успеха", async () => {
    const ctx = setup();
    const admin = await person(ctx, "707", "admin");
    const invalid = async (edit: AdBlockEdit) => {
      await expect(ctx.service.saveBlock(admin, edit), JSON.stringify(edit)).rejects.toBeInstanceOf(AdBlockInvalidError);
    };
    // Задание AdsGram на крутку колеса не встаёт: у колеса формат видео за награду.
    await invalid(block({ externalId: "task-123" }));
    await invalid(block({ externalId: "int-123" }));
    await invalid(block({ place: "interstitial", externalId: "123" }));
    await invalid(block({ place: "task", externalId: "123" }));
    await invalid(block({ externalId: null }));
    await invalid(block({ success: "click" }));
    // RichAds показывает по ключам сети — блока в кабинете у него нет, и заданий нет вовсе.
    await invalid(block({ networkKey: "richads", externalId: "123" }));
    await invalid(block({ networkKey: "richads", place: "task", externalId: null }));
    await invalid(block({ networkKey: "taddy", place: "task", externalId: "feed" }));
    // SDK AdsGram живёт только в Telegram: блок для VK не сохранится.
    await invalid(block({ platforms: ["telegram", "vk"] }));
    await expect(ctx.service.saveBlock(admin, block({ platforms: ["vk"] }))).rejects.toThrow("AdsGram работает только в Telegram — в VK её SDK не поднимется");
    expect(ctx.repository.blockRows).toHaveLength(0);

    await ctx.service.saveBlock(admin, block({ place: "interstitial", externalId: "int-123" }));
    await ctx.service.saveBlock(admin, block({ place: "task", externalId: "task-123", success: undefined }));
    await ctx.service.saveBlock(admin, block({ networkKey: "richads", place: "run_double", externalId: null }));
    await ctx.service.saveBlock(admin, block({ networkKey: "taddy", place: "task", externalId: "app-task", success: undefined }));
    expect(ctx.repository.blockRows.map((row) => [row.networkKey, row.place, row.externalId, row.success])).toEqual([
      ["adsgram", "interstitial", "int-123", "view"],
      ["adsgram", "task", "task-123", "cpa"],
      ["richads", "run_double", null, "view"],
      ["taddy", "task", "app-task", "cpa"],
    ]);
  });

  it("Task-блок AdsGram — один включённый: кабинет держит один на аккаунт", async () => {
    const ctx = setup();
    const admin = await person(ctx, "708", "admin");
    const first = await ctx.service.saveBlock(admin, block({ success: "cpa", place: "task", externalId: "task-1" }));
    await expect(ctx.service.saveBlock(admin, block({ success: "cpa", place: "task", externalId: "task-2" }))).rejects.toBeInstanceOf(AdBlockLimitError);
    const second = await ctx.service.saveBlock(admin, block({ success: "cpa", place: "task", externalId: "task-2", active: false }));
    await ctx.service.saveBlock(admin, { ...block({ success: "cpa", place: "task", externalId: "task-1", active: false }), blockId: first.blockId });
    await expect(ctx.service.saveBlock(admin, { ...block({ success: "cpa", place: "task", externalId: "task-2" }), blockId: second.blockId })).resolves.toMatchObject({ active: true });
    // Правка единственного включённого лимит не трогает.
    await expect(ctx.service.saveBlock(admin, { ...block({ success: "cpa", place: "task", externalId: "task-2", devices: ["android"] }), blockId: second.blockId })).resolves.toMatchObject({ devices: ["android"] });
  });

  it("сеть и место у заведённого блока не меняются; сети без кода и несуществующего блока нет", async () => {
    const ctx = setup();
    const admin = await person(ctx, "702", "admin");
    const created = await ctx.service.saveBlock(admin, block());
    await expect(ctx.service.saveBlock(admin, { ...block({ networkKey: "taddy", externalId: null }), blockId: created.blockId })).rejects.toBeInstanceOf(AdBlockShapeLockedError);
    await expect(ctx.service.saveBlock(admin, { ...block({ place: "run_double" }), blockId: created.blockId })).rejects.toBeInstanceOf(AdBlockShapeLockedError);
    await expect(ctx.service.saveBlock(admin, block({ networkKey: "monetag" }))).rejects.toBeInstanceOf(AdCatalogNotFoundError);
    await expect(ctx.service.saveBlock(admin, { ...block(), blockId: "00000000-0000-4000-8000-999999999999" })).rejects.toBeInstanceOf(AdCatalogNotFoundError);
    await expect(ctx.service.saveNetwork(admin, { networkKey: "monetag", active: true, priority: 1 })).rejects.toBeInstanceOf(AdCatalogNotFoundError);
    expect(ctx.repository.blockRows).toHaveLength(1);
  });

  it("панель получает профили и форматы мест; блок, заведённый до профилей, — с объяснением, что не так", async () => {
    const ctx = setup();
    const designer = await person(ctx, "709", "game_designer");
    ctx.repository.networksRows[1] = { networkKey: "richads", name: "RichAds", active: true, priority: 30, keys: { pubId: "792361" } };
    ctx.repository.blockRows.push({ blockId: "legacy", networkKey: "adsgram", place: "wheel_spin", externalId: "task-9", success: "view", active: true, platforms: [], devices: [] });
    const view = await ctx.service.view(designer, 7, NOON);
    expect(view.profiles).toBe(AD_NETWORK_PROFILES);
    expect(view.formats).toMatchObject({ wheel_spin: "rewarded", interstitial: "interstitial", task: "task" });
    expect(view.networks.find((network) => network.networkKey === "richads")).toMatchObject({ missing: ["App ID (appId)"], problem: null });
    expect(view.blocks[0]?.problem).toMatch(/AdsGram: Block ID для этого места выглядит как «12345»/);
    // Тестовые показы панель видит, чтобы предупредить: сети за них не платят.
    expect(view.testMode).toBe(false);
    ctx.settings.set("ads.test-mode", true);
    expect((await ctx.service.view(designer, 7, NOON)).testMode).toBe(true);
  });

  it("геймдизайнер видит, но не правит; модератор не видит", async () => {
    const ctx = setup();
    const designer = await person(ctx, "703", "game_designer");
    const moderator = await person(ctx, "704", "moderator");
    const view = await ctx.service.view(designer, 7, NOON);
    expect(view).toMatchObject({ days: 7, places: ["second_chance", "wheel_spin", "run_double", "task", "interstitial"] });
    expect(view.networks.map((network) => network.networkKey)).toEqual(["adsgram", "richads", "taddy"]);
    expect(ctx.repository.funnelFrom).toEqual(new Date(NOON.getTime() - 7 * 86_400_000));

    await expect(ctx.service.saveNetwork(designer, { networkKey: "adsgram", active: true, priority: 1 })).rejects.toThrow();
    await expect(ctx.service.saveBlock(designer, block())).rejects.toThrow();
    await expect(ctx.service.view(moderator, 1, NOON)).rejects.toThrow();
    expect(ctx.repository.networksRows[0]?.active).toBe(false);
    expect(ctx.repository.blockRows).toHaveLength(0);
  });

  it("схемы панели: идентификатор обрезается, пустой — «блока нет»; списки — из известных и без повторов, лишнее поле — отказ", () => {
    expect(blockEditSchema.safeParse(block()).success).toBe(true);
    expect(blockEditSchema.parse(block({ externalId: "  int-1  " })).externalId).toBe("int-1");
    expect(blockEditSchema.parse(block({ externalId: "  " })).externalId).toBeNull();
    expect(blockEditSchema.parse({ ...block(), success: undefined }).success).toBeUndefined();
    for (const bad of [
      block({ externalId: "x".repeat(129) }),
      block({ platforms: ["telegram", "telegram"] }),
      { ...block(), devices: ["tv"] },
      { ...block(), place: "banner" },
      { ...block(), blockId: "not-a-uuid" },
      { ...block(), reward: 100 },
    ]) {
      expect(blockEditSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(networkEditSchema.safeParse({ networkKey: "adsgram", active: true, priority: -1 }).success).toBe(false);
    expect(networkEditSchema.safeParse({ networkKey: "adsgram", active: true, priority: 1, name: "X" }).success).toBe(false);
    expect(networkEditSchema.safeParse({ networkKey: "richads", active: true, priority: 1, keys: { pubId: 792361 } }).success).toBe(false);
    expect(networkEditSchema.parse({ networkKey: "richads", active: true, priority: 1, keys: { pubId: " 792361 " } }).keys).toEqual({ pubId: "792361" });
  });
});

describe("реклама в панели по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("владелец правит сеть и блоки; окно воронки — из списка, мусор — 400, без заголовка панели — 403, модератору закрыто", async () => {
    // Вход разработчика признаёт владельца только в разработке — сервису та же конфигурация.
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    const ctx = setup(cfg);
    const store = new MemoryAdminSessionStore();
    @Module({
      controllers: [AdminSessionController, AdminAdsController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ACCOUNT_REPOSITORY, useValue: ctx.accounts },
        { provide: ROLES_REPOSITORY, useValue: ctx.roles },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: AppLinks, useValue: new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]) },
        { provide: AdsCatalogService, useValue: ctx.service },
        PanelLoginService,
        RateLimiter,
        RolesService,
        PermissionGuard,
        AuthGuard,
        AdminSessionService,
        AdminSessionGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const login = await app.inject({ method: "POST", url: "/api/v1/admin/session/dev", payload: { devUser: `dev-${OWNER_ID}:Владелец` } });
    const cookie = `${ADMIN_SESSION_COOKIE}=${/rubezh_admin_session=([^;]+)/.exec(String(login.headers["set-cookie"]))?.[1] ?? ""}`;
    const headers = { cookie, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE };

    const view = await app.inject({ method: "GET", url: "/api/v1/admin/ads?days=30", headers });
    expect(view.statusCode).toBe(200);
    expect(view.json<{ data: { days: number; funnel: unknown[] } }>().data).toMatchObject({ days: 30, funnel: [expect.objectContaining({ networkKey: "adsgram", offered: 10 })] });
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/ads", headers })).json<{ data: { days: number } }>().data.days).toBe(7);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/ads?days=3", headers })).statusCode).toBe(400);

    expect((await app.inject({ method: "POST", url: "/api/v1/admin/ads/networks", headers: { cookie }, payload: { networkKey: "adsgram", active: true, priority: 1 } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/ads/networks", headers, payload: { networkKey: "adsgram", active: "да", priority: 1 } })).statusCode).toBe(400);
    const network = await app.inject({ method: "POST", url: "/api/v1/admin/ads/networks", headers, payload: { networkKey: "adsgram", active: true, priority: 1 } });
    expect(network.statusCode).toBe(201);
    expect(network.json<{ data: { active: boolean } }>().data.active).toBe(true);

    const invalid = await app.inject({ method: "POST", url: "/api/v1/admin/ads/blocks", headers, payload: { ...block(), externalId: "task-1" } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: { code: string } }>().error.code).toBe("ad_block_invalid");
    const incomplete = await app.inject({ method: "POST", url: "/api/v1/admin/ads/networks", headers, payload: { networkKey: "richads", active: true, priority: 3 } });
    expect(incomplete.statusCode).toBe(409);
    expect(incomplete.json<{ error: { code: string } }>().error.code).toBe("ad_network_incomplete");
    const created = await app.inject({ method: "POST", url: "/api/v1/admin/ads/blocks", headers, payload: block() });
    expect(created.statusCode).toBe(201);
    const blockId = created.json<{ data: { blockId: string } }>().data.blockId;
    const locked = await app.inject({ method: "POST", url: "/api/v1/admin/ads/blocks", headers, payload: { ...block({ place: "task" }), blockId } });
    expect(locked.statusCode).toBe(409);
    expect(locked.json<{ error: { code: string } }>().error.code).toBe("ad_block_shape_locked");
    const missing = await app.inject({ method: "POST", url: "/api/v1/admin/ads/blocks", headers, payload: block({ networkKey: "monetag" }) });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe("ad_network_not_found");

    const moderator = await person(ctx, "705", "moderator");
    await store.put(hashSessionToken("mod"), { ...moderator, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/ads", headers: { cookie: `${ADMIN_SESSION_COOKIE}=mod` } })).statusCode).toBe(403);
  });
});
