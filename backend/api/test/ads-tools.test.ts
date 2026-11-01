import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { PLACE_FORMAT } from "../src/modules/ads/ad-networks.js";
import { ADS_CATALOG_REPOSITORY, type AdBlockDef, type AdFunnelRow, type AdNetworkRow, type AdPassRow, type AdsCatalogRepository } from "../src/modules/ads/ads-catalog.repository.js";
import { AdsToolsController } from "../src/modules/ads/ads-tools.controller.js";
import { AdsToolsService } from "../src/modules/ads/ads-tools.service.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import type { Role } from "../src/modules/roles/permissions.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Проверка рекламы командой (docs/35-stage4-plan.md, Р165; tasks/T-0333): каталог
 * SDK-сетей и блоков и приём исхода проверки. Ничего не начисляется и не
 * создаётся — исход идёт в аудит и в лог.
 */

const NOW = Date.UTC(2026, 9, 27, 9);
const BLOCK_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_NETWORK_BLOCK = "00000000-0000-4000-8000-000000000002";
const INTERSTITIAL_BLOCK = "00000000-0000-4000-8000-000000000003";
const MISSING_BLOCK = "00000000-0000-4000-8000-0000000000ff";

class MemoryCatalog implements AdsCatalogRepository {
  networksRows: AdNetworkRow[] = [
    { networkKey: "richads", name: "RichAds", active: true, priority: 30, keys: { pubId: "792361", appId: "1396", secret: "не отдавать" } },
    { networkKey: "adsgram", name: "AdsGram", active: true, priority: 10, keys: {} },
    { networkKey: "adsonar", name: "AdSonar", active: false, priority: 20, keys: { appId: "app_abc" } },
    { networkKey: "taddy", name: "Taddy", active: true, priority: 5, keys: {} },
  ];
  blockRows: AdBlockDef[] = [
    { blockId: BLOCK_ID, networkKey: "adsgram", place: "wheel_spin", externalId: "1234", success: "view", active: true, platforms: ["telegram"], devices: [] },
    { blockId: OTHER_NETWORK_BLOCK, networkKey: "adsonar", place: "second_chance", externalId: "rewarded_x", success: "view", active: false, platforms: [], devices: [] },
    { blockId: INTERSTITIAL_BLOCK, networkKey: "adsgram", place: "interstitial", externalId: "5678", success: "view", active: true, platforms: ["telegram"], devices: [] },
    { blockId: "00000000-0000-4000-8000-000000000004", networkKey: "adsgram", place: "task", externalId: "9", success: "view", active: true, platforms: [], devices: [] },
    { blockId: "00000000-0000-4000-8000-000000000005", networkKey: "taddy", place: "wheel_spin", externalId: null, success: "view", active: true, platforms: [], devices: [] },
  ];

  async networks(): Promise<AdNetworkRow[]> {
    return this.networksRows.map((row) => ({ ...row }));
  }

  async blocks(): Promise<AdBlockDef[]> {
    return this.blockRows.map((row) => ({ ...row }));
  }

  async updateNetwork(): Promise<boolean> {
    throw new Error("проверка рекламы сети не правит");
  }

  async reorderNetworks(): Promise<never> {
    throw new Error("проверка рекламы порядок сетей не меняет");
  }

  async insertBlock(): Promise<AdBlockDef | null> {
    throw new Error("проверка рекламы блоки не заводит");
  }

  async updateBlock(): Promise<boolean> {
    throw new Error("проверка рекламы блоки не правит");
  }

  async passes(): Promise<AdPassRow[]> {
    return [];
  }

  async funnel(): Promise<AdFunnelRow[]> {
    throw new Error("проверка рекламы воронку не двигает");
  }
}

const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

describe("проверка рекламы командой", () => {
  let app: NestFastifyApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(catalog = new MemoryCatalog()) {
    const rolesRepository = new MemoryRolesRepository();
    const accounts = new MemoryAccountRepository();

    @Module({
      controllers: [AdsToolsController],
      providers: [
        { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv) },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ADS_CATALOG_REPOSITORY, useValue: catalog },
        { provide: ROLES_REPOSITORY, useValue: rolesRepository },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        RolesService,
        AdsToolsService,
        RateLimiter,
        AuthGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    /** Заголовок входа для аккаунта с ролью (или без роли). */
    const as = async (role?: Role) => {
      const accountId = randomUUID();
      if (role !== undefined) await rolesRepository.grant(accountId, role, null);
      const token = await signAccessToken({ accountId, platform: "telegram", platformUserId: "555000444" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, NOW + 1e12);
      return { accountId, headers: { authorization: `Bearer ${token}` } };
    };
    return { app, catalog, rolesRepository, as };
  }

  const result = (patch: Record<string, unknown> = {}) => ({ network: "adsgram", format: "rewarded", blockId: BLOCK_ID, live: false, outcome: "completed", ms: 14_200, ...patch });

  describe("каталог", () => {
    it("без токена — 401, без права tools.dev — 403, с правом — 200", async () => {
      const { app: server, as } = await start();
      expect((await server.inject({ method: "GET", url: "/api/v1/tools/ads/catalog" })).statusCode).toBe(401);
      for (const role of ["moderator", "marketer"] as const) {
        const { headers } = await as(role);
        expect((await server.inject({ method: "GET", url: "/api/v1/tools/ads/catalog", headers })).statusCode, role).toBe(403);
      }
      for (const role of ["owner", "admin", "game_designer"] as const) {
        const { headers } = await as(role);
        expect((await server.inject({ method: "GET", url: "/api/v1/tools/ads/catalog", headers })).statusCode, role).toBe(200);
      }
    });

    it("только SDK-сети: Taddy и формат task не входят, выключенное остаётся с active: false", async () => {
      const { app: server, as } = await start();
      const { headers } = await as("owner");
      const body = (await server.inject({ method: "GET", url: "/api/v1/tools/ads/catalog", headers })).json() as { data: { networks: { network: string; active: boolean; formats: string[] }[]; blocks: { blockId: string; network: string; place: string; format: string; active: boolean }[] } };

      expect(body.data.networks.map((network) => network.network)).toEqual(["adsgram", "adsonar", "richads"]);
      expect(body.data.networks.find((network) => network.network === "adsonar")).toMatchObject({ active: false, formats: ["rewarded", "interstitial"] });
      expect(body.data.networks.some((network) => network.network === "taddy")).toBe(false);

      expect(body.data.blocks.some((block) => block.format === "task" || block.network === "taddy")).toBe(false);
      expect(body.data.blocks.find((block) => block.blockId === OTHER_NETWORK_BLOCK)).toMatchObject({ network: "adsonar", active: false });
      for (const block of body.data.blocks) expect(block.format).toBe(PLACE_FORMAT[block.place as keyof typeof PLACE_FORMAT]);
    });

    it("наружу идут только ключи из профиля сети", async () => {
      const { app: server, as } = await start();
      const { headers } = await as("owner");
      const body = (await server.inject({ method: "GET", url: "/api/v1/tools/ads/catalog", headers })).json() as { data: { networks: { network: string; keys: Record<string, string> }[] } };
      expect(body.data.networks.find((network) => network.network === "richads")?.keys).toEqual({ pubId: "792361", appId: "1396" });
    });

    it("порядок: сети по priority, блоки по сети, месту и id", async () => {
      const { app: server, as } = await start();
      const { headers } = await as("owner");
      const body = (await server.inject({ method: "GET", url: "/api/v1/tools/ads/catalog", headers })).json() as { data: { blocks: { blockId: string; network: string; place: string }[] } };
      const order = body.data.blocks.map((block) => `${block.network}:${block.place}:${block.blockId}`);
      expect(order).toEqual([...order].sort());
    });

    it("пустой каталог — пустые списки", async () => {
      const catalog = new MemoryCatalog();
      catalog.networksRows = [];
      catalog.blockRows = [];
      const { app: server, as } = await start(catalog);
      const { headers } = await as("owner");
      expect((await server.inject({ method: "GET", url: "/api/v1/tools/ads/catalog", headers })).json()).toEqual({ data: { networks: [], blocks: [] } });
    });
  });

  describe("результат проверки", () => {
    const post = (server: NestFastifyApplication, headers: Record<string, string>, payload: unknown) => server.inject({ method: "POST", url: "/api/v1/tools/ads/test-results", headers, payload: payload as object });

    it("без токена — 401, без права — 403 и аудит пуст", async () => {
      const { app: server, as, rolesRepository } = await start();
      expect((await server.inject({ method: "POST", url: "/api/v1/tools/ads/test-results", payload: result() })).statusCode).toBe(401);
      const { headers } = await as("moderator");
      // Тело заведомо битое: до разбора дело не доходит.
      expect((await post(server, headers, { мусор: 1 })).statusCode).toBe(403);
      expect(rolesRepository.entries).toEqual([]);
    });

    it("успех: 200, одна запись аудита ads.test с целью «сеть:формат» и телом", async () => {
      const { app: server, as, rolesRepository } = await start();
      const { accountId, headers } = await as("owner");
      const response = await post(server, headers, result());
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { ok: true } });
      expect(rolesRepository.entries).toHaveLength(1);
      expect(rolesRepository.entries[0]).toMatchObject({ action: "ads.test", target: "adsgram:rewarded", actorAccountId: accountId, after: result() });
    });

    it("failed с причиной — принят; без причины — 400; completed с причиной — 400", async () => {
      const { app: server, as, rolesRepository } = await start();
      const { headers } = await as("owner");
      expect((await post(server, headers, result({ outcome: "failed", reason: "no_fill" }))).statusCode).toBe(200);
      expect((await post(server, headers, result({ outcome: "failed" }))).statusCode).toBe(400);
      expect((await post(server, headers, result({ outcome: "completed", reason: "no_fill" }))).statusCode).toBe(400);
      expect(rolesRepository.entries).toHaveLength(1);
    });

    it("блока может не быть: richads · interstitial с blockId null", async () => {
      const { app: server, as } = await start();
      const { headers } = await as("owner");
      expect((await post(server, headers, result({ network: "richads", format: "interstitial", blockId: null }))).statusCode).toBe(200);
    });

    it("строгое тело: лишнее поле, ms вне границ и дробный, format task, taddy, чужая причина, не uuid — 400", async () => {
      const { app: server, as, rolesRepository } = await start();
      const { headers } = await as("owner");
      const bad: Record<string, unknown>[] = [
        { extra: 1 },
        { ms: 600_001 },
        { ms: -1 },
        { ms: 1.5 },
        { format: "task" },
        { network: "taddy" },
        { outcome: "failed", reason: "foo" },
        { blockId: "не-uuid" },
        { live: "да" },
      ];
      for (const patch of bad) expect((await post(server, headers, result(patch))).statusCode, JSON.stringify(patch)).toBe(400);
      expect(rolesRepository.entries).toEqual([]);
    });

    it("блок чужой сети, чужого формата или несуществующий — 400, аудит пуст", async () => {
      const { app: server, as, rolesRepository } = await start();
      const { headers } = await as("owner");
      expect((await post(server, headers, result({ blockId: OTHER_NETWORK_BLOCK }))).statusCode).toBe(400);
      expect((await post(server, headers, result({ blockId: INTERSTITIAL_BLOCK }))).statusCode).toBe(400);
      expect((await post(server, headers, result({ blockId: MISSING_BLOCK }))).statusCode).toBe(400);
      expect(rolesRepository.entries).toEqual([]);
    });

    it("ничего не создаётся: сервис собран без AdsService, каталог не правится", async () => {
      const { app: server, as } = await start();
      const { headers } = await as("owner");
      // Репозиторий каталога бросает на любой записи: если бы сервис писал, ответ был бы 500.
      expect((await post(server, headers, result())).statusCode).toBe(200);
      expect((await server.inject({ method: "GET", url: "/api/v1/tools/ads/catalog", headers })).statusCode).toBe(200);
      const source = readFileSync(new URL("../src/modules/ads/ads-tools.service.ts", import.meta.url), "utf8");
      expect(source).not.toMatch(/from "\.\/ads\.(service|repository)\.js"|AdsService|ADS_REPOSITORY/);
    });
  });
});
