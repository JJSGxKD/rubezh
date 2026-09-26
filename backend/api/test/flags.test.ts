import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Module, type Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { bucketOf, isOn, type FlagRule } from "../src/modules/flags/flag-rollout.js";
import { FlagsController } from "../src/modules/flags/flags.controller.js";
import type { FlagRecord, FlagsRepository } from "../src/modules/flags/flags.repository.js";
import { FlagsService } from "../src/modules/flags/flags.service.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Фича-флаги (docs/09-ci-cd.md §11): доля выката устойчивая, площадка и
 * выключатель уважаются, изменение из панели — с правом и в аудит, а кеш
 * реплики сбрасывается сразу.
 */

class MemoryFlags implements FlagsRepository {
  readonly flags = new Map<string, FlagRecord>();
  reads = 0;
  async all(): Promise<FlagRecord[]> {
    this.reads++;
    return [...this.flags.values()];
  }
  async byKey(key: string): Promise<FlagRecord | null> {
    return this.flags.get(key) ?? null;
  }
  async save(flag: FlagRule & { note: string | null; updatedBy: string }): Promise<FlagRecord> {
    const record = { ...flag, platforms: [...flag.platforms], updatedAt: new Date() };
    this.flags.set(flag.key, record);
    return record;
  }
  async remove(key: string): Promise<boolean> {
    return this.flags.delete(key);
  }
}

const OWNER_ID = "777000111";
const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);

let accounts: MemoryAccountRepository;
let rolesRepository: MemoryRolesRepository;
let repository: MemoryFlags;
let service: FlagsService;

beforeEach(() => {
  accounts = new MemoryAccountRepository();
  rolesRepository = new MemoryRolesRepository();
  repository = new MemoryFlags();
  service = new FlagsService(repository, new RolesService(config(), rolesRepository, accounts));
});

describe("выкат флага", () => {
  const rule: FlagRule = { key: "shop.v2", enabled: true, platforms: [], percent: 30 };

  it("корзина игрока устойчива и своя у каждого флага", () => {
    expect(bucketOf("shop.v2", "a1")).toBe(bucketOf("shop.v2", "a1"));
    const ids = Array.from({ length: 400 }, (_, index) => `acc-${index}`);
    const differ = ids.filter((id) => bucketOf("shop.v2", id) !== bucketOf("ads.rewarded", id)).length;
    expect(differ).toBeGreaterThan(300);
  });

  it("доля выката близка к заданной, а при росте доли попавшие остаются", () => {
    const ids = Array.from({ length: 2000 }, (_, index) => `acc-${index}`);
    const on30 = ids.filter((accountId) => isOn(rule, { accountId, platform: "telegram" }));
    expect(on30.length / ids.length).toBeGreaterThan(0.25);
    expect(on30.length / ids.length).toBeLessThan(0.35);
    const on60 = new Set(ids.filter((accountId) => isOn({ ...rule, percent: 60 }, { accountId, platform: "telegram" })));
    expect(on30.every((accountId) => on60.has(accountId))).toBe(true);
  });

  it("выключенный — ни у кого, чужая площадка — мимо, 100 % — у всех, 0 % — ни у кого", () => {
    const account = { accountId: "a1", platform: "telegram" as const };
    expect(isOn({ ...rule, enabled: false, percent: 100 }, account)).toBe(false);
    expect(isOn({ ...rule, platforms: ["vk"], percent: 100 }, account)).toBe(false);
    expect(isOn({ ...rule, platforms: ["telegram"], percent: 100 }, account)).toBe(true);
    expect(isOn({ ...rule, percent: 0 }, account)).toBe(false);
  });
});

describe("флаги в сервисе", () => {
  async function owner() {
    const account = await accounts.upsert({ platform: "telegram", platformUserId: OWNER_ID, displayName: "Владелец", username: null, photoUrl: null }, Date.now());
    return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
  }

  it("изменение — с правом и в аудит, кеш реплики сбрасывается сразу", async () => {
    const actor = await owner();
    const player = { accountId: randomUUID(), platform: "telegram" as const };
    expect(await service.forAccount(player, 1_000)).toEqual({});
    expect(await service.forAccount(player, 2_000)).toEqual({});
    expect(repository.reads).toBe(1);

    await service.save(actor, { key: "shop.v2", enabled: true, platforms: [], percent: 100, note: "витрина" });
    expect(await service.forAccount(player, 3_000)).toEqual({ "shop.v2": true });
    expect(await service.isOn("shop.v2", player, 3_000)).toBe(true);
    expect(await service.isOn("unknown", player, 3_000)).toBe(false);

    await service.remove(actor, "shop.v2");
    expect(await service.forAccount(player, 4_000)).toEqual({});
    const audit = await rolesRepository.recentAudit(10);
    expect(audit.map((entry) => entry.action).sort()).toEqual(["flags.remove", "flags.save"]);
  });

  it("без права flags.edit — отказ", async () => {
    const stranger = await accounts.upsert({ platform: "telegram", platformUserId: "5", displayName: "Гость", username: null, photoUrl: null }, Date.now());
    const ref = { accountId: stranger.accountId, platform: stranger.platform, platformUserId: stranger.platformUserId };
    await expect(service.save(ref, { key: "shop.v2", enabled: true, platforms: [], percent: 100, note: null })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.list(ref)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("HTTP /flags", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("без токена — 401, с токеном — флаги игрока", async () => {
    repository.flags.set("shop.v2", { key: "shop.v2", enabled: true, platforms: [], percent: 100, note: null, updatedBy: null, updatedAt: new Date() });
    @Module({
      controllers: [FlagsController],
      providers: [{ provide: APP_CONFIG, useValue: config() }, { provide: REDIS, useValue: unavailableRedis }, { provide: FlagsService, useValue: service }, RateLimiter, AuthGuard],
    })
    class TestModule {}
    app = await createHttpApp(TestModule as Type<unknown>, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    expect((await app.inject({ method: "GET", url: "/api/v1/flags" })).statusCode).toBe(401);
    const token = await signAccessToken({ accountId: randomUUID(), platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    const response = await app.inject({ method: "GET", url: "/api/v1/flags", headers: { authorization: `Bearer ${token}` } });
    expect(response.json()).toEqual({ data: { flags: { "shop.v2": true } } });
  });
});
