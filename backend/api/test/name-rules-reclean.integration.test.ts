import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanAll } from "../src/cli/display-names-clean.js";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminNameRulesRecleanController } from "../src/modules/admin/admin-name-rules-reclean.controller.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { NameRuleConflictError } from "../src/modules/name-rules/name-rules-errors.js";
import { RECLEAN_LOCK_KEY, RECLEAN_STATE_KEY, RECLEAN_STOP_KEY, readRecleanState, type RecleanState } from "../src/modules/name-rules/name-rules-reclean-state.js";
import { NameRulesRecleanService, type RecleanJobData } from "../src/modules/name-rules/name-rules-reclean.service.js";
import { PrismaNameRulesRepository, loadNameRuleSet } from "../src/modules/name-rules/name-rules.repository.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPanelLoginStore } from "./helpers/memory-panel-login.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Перечистка ников из панели на живых Postgres и Redis (tasks/T-0339): три
 * пачки по 500, число предпросмотра равно тому, что изменил запуск, закреплённые
 * не тронуты, игрок, вошедший посреди прохода, не перезаписан, второй запуск
 * разом отклонён, контроллер закрыт сессией и правом. Без базы и Redis —
 * пропуск. Шаблон правила уникален на прогон: таблицы общие с соседними тестами.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 5);
const RUN = randomUUID().slice(0, 6);
const BRAND = `бренд-${RUN}`;
const OWNER_ID = "777000555";
const TIMEOUT_MS = 60_000;

describe.skipIf(DATABASE_URL === "" || REDIS_URL === "")("перечистка ников на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let service: NameRulesRecleanService;
  let httpService: NameRulesRecleanService | null = null;
  let owner: AccountRef;
  const jobs: RecleanJobData[] = [];
  const accountIds: string[] = [];
  let ruleId = "";
  let lockedId = "";

  const roles = new MemoryRolesRepository();
  const accounts = new MemoryAccountRepository();

  async function runJob(): Promise<RecleanState> {
    const job = jobs.at(-1);
    if (job === undefined) throw new Error("задание не поставлено");
    await service.process(job);
    return (await readRecleanState(redis)) as RecleanState;
  }

  const dirtyCount = () => prisma.account.count({ where: { accountId: { in: accountIds }, displayName: { contains: BRAND } } });

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 6);
    redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    await redis.del(RECLEAN_STATE_KEY, RECLEAN_LOCK_KEY, RECLEAN_STOP_KEY);

    const member = await accounts.upsert({ platform: "telegram", platformUserId: OWNER_ID, displayName: "Владелец", username: null, photoUrl: null }, Date.now());
    owner = { accountId: member.accountId, platform: member.platform, platformUserId: member.platformUserId };
    service = new NameRulesRecleanService(prisma, redis, new RolesService(config, roles, accounts), { enqueue: async (data) => void jobs.push(data) });
    service.sleep = async () => {};

    const at = new Date();
    ruleId = randomUUID();
    await new PrismaNameRulesRepository(prisma).insert({ ruleId, category: "brand", kind: "exact", pattern: BRAND, active: true, note: null, createdAt: at, updatedAt: at, updatedBy: null });

    // 1200 аккаунтов: три пачки по 500 на всю таблицу; 1000 с брендом, 50 закреплённых, остальные чистые.
    const rows = Array.from({ length: 1200 }, (_, index) => {
      const accountId = randomUUID();
      accountIds.push(accountId);
      const dirty = index < 1050;
      const name = dirty ? `Вася ${BRAND}` : "Вася";
      if (index >= 1000 && index < 1050) lockedId = accountId;
      return {
        accountId,
        platform: "telegram" as const,
        platformUserId: `rc-${RUN}-${index}`,
        displayName: name,
        platformName: name,
        createdAt: at,
        lastSeenAt: at,
        nameLockedAt: index >= 1000 && index < 1050 ? at : null,
      };
    });
    await prisma.account.createMany({ data: rows });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await prisma.account.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.nameRule.deleteMany({ where: { ruleId } });
    await redis.del(RECLEAN_STATE_KEY, RECLEAN_LOCK_KEY, RECLEAN_STOP_KEY);
    redis.disconnect();
    await prisma.$disconnect();
  }, TIMEOUT_MS);

  it("предпросмотр насчитал N, запуск изменил ровно N, закреплённые целы, повторный предпросмотр — ноль", async () => {
    await service.startPreview(owner);
    const preview = await runJob();
    expect(preview).toMatchObject({ mode: "preview", status: "done", updated: 0 });
    expect(preview.scanned).toBeGreaterThanOrEqual(1200);
    // 1000 с брендом наши; остальные аккаунты общей базы чужие, но их ники чистые.
    expect(preview.planned).toBeGreaterThanOrEqual(1000);
    expect(preview.locked).toBeGreaterThanOrEqual(50);
    expect(await dirtyCount()).toBe(1050);

    const run = await service.startRun(owner, { previewRunId: preview.runId });
    expect(run.status).toBe("queued");
    const done = await runJob();
    expect(done).toMatchObject({ mode: "run", status: "done", planned: preview.planned, updated: preview.planned, skipped: 0 });

    // Остались только закреплённые: displayName и platformName не изменились.
    expect(await dirtyCount()).toBe(50);
    const locked = await prisma.account.findUniqueOrThrow({ where: { accountId: lockedId }, select: { displayName: true, platformName: true } });
    expect(locked).toEqual({ displayName: `Вася ${BRAND}`, platformName: `Вася ${BRAND}` });
    // Исходный ник остался в platformName у тех, кого почистили.
    const cleaned = await prisma.account.findUniqueOrThrow({ where: { accountId: accountIds[0]! }, select: { displayName: true, platformName: true } });
    expect(cleaned).toEqual({ displayName: "Вася", platformName: `Вася ${BRAND}` });

    await service.startPreview(owner);
    expect(await runJob()).toMatchObject({ mode: "preview", status: "done", planned: 0 });
    expect(await redis.exists(RECLEAN_LOCK_KEY)).toBe(0);
  }, TIMEOUT_MS);

  it("игрок вошёл между чтением и записью — попал в skipped, не перезаписан", async () => {
    const target = randomUUID();
    accountIds.push(target);
    await prisma.account.create({
      data: { accountId: target, platform: "telegram", platformUserId: `rc-${RUN}-late`, displayName: `Петя ${BRAND}`, platformName: `Петя ${BRAND}`, createdAt: new Date(), lastSeenAt: new Date() },
    });
    const rules = await loadNameRuleSet(prisma);

    const result = await cleanAll(
      prisma,
      { dryRun: false },
      {
        afterRead: async (rows) => {
          if (rows.some((row) => row.accountId === target)) await prisma.account.update({ where: { accountId: target }, data: { displayName: "Петя вошёл" } });
        },
      },
      rules,
    );

    expect(result.skipped).toBe(1);
    expect((await prisma.account.findUniqueOrThrow({ where: { accountId: target }, select: { displayName: true } })).displayName).toBe("Петя вошёл");
  }, TIMEOUT_MS);

  it("два запуска разом: один принят, второй — конфликт; замок после прохода снят", async () => {
    await redis.del(RECLEAN_STATE_KEY, RECLEAN_LOCK_KEY, RECLEAN_STOP_KEY);
    const outcomes = await Promise.allSettled([service.startPreview(owner), service.startPreview(owner)]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(NameRuleConflictError);

    await runJob();
    expect(await redis.exists(RECLEAN_LOCK_KEY)).toBe(0);
  }, TIMEOUT_MS);

  it("контроллер: 401 без сессии, 403 без names.edit, 200 с ним; тело запуска проверяется", async () => {
    await redis.del(RECLEAN_STATE_KEY, RECLEAN_LOCK_KEY, RECLEAN_STOP_KEY);
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", DATABASE_URL, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    const store = new MemoryAdminSessionStore();

    @Module({
      controllers: [AdminSessionController, AdminNameRulesRecleanController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: redis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: AppLinks, useValue: new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]) },
        // Сервис собирается с правами самого модуля: у него тот же репозиторий ролей, что у сессии.
        { provide: NameRulesRecleanService, inject: [RolesService], useFactory: (moduleRoles: RolesService) => (httpService = new NameRulesRecleanService(prisma, redis, moduleRoles, { enqueue: async (data) => void jobs.push(data) })) },
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
    const app: NestFastifyApplication = await createHttpApp(TestModule, { logger: false });
    try {
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      const url = "/api/v1/admin/name-rules/reclean";

      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);

      const designer = await accounts.upsert({ platform: "telegram", platformUserId: "rc-designer", displayName: "Дизайнер", username: null, photoUrl: null }, Date.now());
      await roles.grant(designer.accountId, "game_designer", null);
      await store.put(hashSessionToken("designer"), { accountId: designer.accountId, platform: "telegram", platformUserId: "rc-designer", issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
      expect((await app.inject({ method: "GET", url, headers: { cookie: `${ADMIN_SESSION_COOKIE}=designer` } })).statusCode).toBe(403);

      const login = await app.inject({ method: "POST", url: "/api/v1/admin/session/dev", payload: { devUser: `dev-${OWNER_ID}:Владелец` } });
      const cookie = `${ADMIN_SESSION_COOKIE}=${/rubezh_admin_session=([^;]+)/.exec(String(login.headers["set-cookie"]))?.[1] ?? ""}`;
      const headers = { cookie, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE };

      const idle = await app.inject({ method: "GET", url, headers });
      expect(idle.statusCode).toBe(200);
      expect(idle.json<{ data: unknown }>().data).toBeNull();

      const started = await app.inject({ method: "POST", url: `${url}/preview`, headers });
      expect(started.statusCode).toBe(200);
      expect(started.json<{ data: RecleanState }>().data).toMatchObject({ mode: "preview", status: "queued" });
      expect((await app.inject({ method: "POST", url: `${url}/preview`, headers })).statusCode).toBe(409);

      expect((await app.inject({ method: "POST", url: `${url}/run`, headers, payload: {} })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: `${url}/run`, headers, payload: { previewRunId: "не-uuid" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: `${url}/run`, headers, payload: { previewRunId: randomUUID(), extra: 1 } })).statusCode).toBe(400);
      // валидное тело, но предпросмотр не доведён до конца — конфликт, а не 500
      expect((await app.inject({ method: "POST", url: `${url}/run`, headers, payload: { previewRunId: randomUUID() } })).statusCode).toBe(409);

      const stopped = await app.inject({ method: "POST", url: `${url}/stop`, headers });
      expect(stopped.statusCode).toBe(200);
      const job = jobs.at(-1) as RecleanJobData;
      await httpService?.process(job);
      expect((await app.inject({ method: "POST", url: `${url}/stop`, headers })).statusCode).toBe(409);
    } finally {
      await app.close();
    }
  }, TIMEOUT_MS);
});
