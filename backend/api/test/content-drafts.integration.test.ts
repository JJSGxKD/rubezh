import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildExport, HASH_FILE } from "../../../scripts/content/export-snapshot";
import { CONTENT_SNAPSHOT } from "../../../packages/core-game/src/content/snapshot";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { PayloadTooLargeError } from "../src/common/domain-error.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminContentController } from "../src/modules/admin/admin-content.controller.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE } from "../src/modules/admin/admin-session.store.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { BullContentCheckQueue, CONTENT_CHECK_QUEUE, type CheckJobPayload, type CheckJobState, type ContentCheckQueue } from "../src/modules/content/content-check.queue.js";
import { ContentCheckService } from "../src/modules/content/content-check.service.js";
import { ContentCheckBusyError } from "../src/modules/content/content-errors.js";
import { importContentVersion, parseContentExport, readContentExport } from "../src/modules/content/content-import.js";
import { CONTENT_REPOSITORY, PrismaContentRepository } from "../src/modules/content/content.repository.js";
import { ContentService } from "../src/modules/content/content.service.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPanelLoginStore } from "./helpers/memory-panel-login.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Черновики контента на живом Postgres (tasks/T-0303; адрес — TEST_DATABASE_URL,
 * без него пропуск): версия 0 из выгрузки, черновик, правка, проверка и разница
 * через настоящие охранники и права панели. Очередь проверок — подмена: за
 * настоящий BullMQ отвечает второй блок (нужен Redis, PLAYTEST_TEST_REDIS_URL).
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 5);
const OWNER_ID = "777000222";
const BASE = "/api/v1/admin/content";

interface Snap {
  enemies: { id: string; hp: number }[];
}
const SNAPSHOT = JSON.parse(JSON.stringify(CONTENT_SNAPSHOT)) as Snap;
const ENEMY = SNAPSHOT.enemies[0];
if (ENEMY === undefined) throw new Error("в контенте нет врагов");
const HP_PATH = `enemies[id=${ENEMY.id}].hp`;

/** Хэш для версии теста: база общая и между прогонами, настоящий хэш повторного прогона уже занят. */
const randomHash = (): string => randomBytes(4).toString("hex");

class FakeQueue implements ContentCheckQueue {
  readonly jobs: CheckJobPayload[] = [];
  readonly states = new Map<string, CheckJobState>();
  async submit(job: CheckJobPayload): Promise<void> {
    this.jobs.push(JSON.parse(JSON.stringify(job)) as CheckJobPayload);
    this.states.set(job.checkId, { state: "pending" });
  }
  async poll(checkId: string): Promise<CheckJobState> {
    return this.states.get(checkId) ?? { state: "missing" };
  }
  async cancel(): Promise<void> {}
  finish(checkId: string): void {
    this.states.set(checkId, {
      state: "finished",
      result: { checkId, schemaProblems: [], contentProblems: [], report: { timeout: false, seeds: 2, scenarios: [], corridors: [] }, elapsedMs: 5 },
    });
  }
}

describe.skipIf(DATABASE_URL === "")("контент на живом Postgres", () => {
  let prisma: PrismaClient;
  let repository: PrismaContentRepository;
  let app: NestFastifyApplication | null = null;
  const versionNos: number[] = [];
  const draftIds: string[] = [];
  let dir = "";

  beforeAll(() => {
    prisma = testPrisma(DATABASE_URL, 10);
    repository = new PrismaContentRepository(prisma);
    dir = mkdtempSync(join(tmpdir(), "content-integration-"));
  });

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  afterAll(async () => {
    // Своё убираем: проверки, черновики, версии — иначе общая база копит строки, а потолок черновиков их считает.
    await prisma.contentCheck.deleteMany({ where: { draftId: { in: draftIds } } });
    await prisma.contentDraft.deleteMany({ where: { draftId: { in: draftIds } } });
    await prisma.contentVersion.deleteMany({ where: { versionNo: { in: versionNos } } });
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Выгрузка под случайным хэшем: ровно то, что кладёт `pnpm content:export`, кроме хэша движка. */
  async function importVersion(hash = randomHash()): Promise<{ created: boolean; versionNo: number; contentHash: string }> {
    const files = buildExport(CONTENT_SNAPSHOT, { "enemy.swarm_rat.name": "Крыса" }).files;
    for (const [name, text] of Object.entries({ ...files, [HASH_FILE]: JSON.stringify({ hash }) })) writeFileSync(join(dir, name), text, "utf8");
    const outcome = await importContentVersion(repository, parseContentExport(readContentExport(dir)), new Date());
    if (outcome.created) versionNos.push(outcome.versionNo);
    return outcome;
  }

  it("версия 0: первый импорт заводит версию repo, повторный того же файла — ничего; номера без дыр", async () => {
    const hash = randomHash();
    const first = await importVersion(hash);
    expect(first.created).toBe(true);
    const stored = await repository.version(first.versionNo);
    expect(stored).toMatchObject({ contentHash: hash, source: "repo", schemaVersion: 1, createdBy: null, publishedAt: null, names: { "enemy.swarm_rat.name": "Крыса" } });
    expect(stored?.snapshot).toEqual(SNAPSHOT);
    expect(stored?.jsonSchema).toMatchObject({ type: "object" });

    const repeats = await Promise.all([importVersion(hash), importVersion(hash), importVersion(hash)]);
    for (const again of repeats) expect(again).toEqual({ created: false, versionNo: first.versionNo, contentHash: hash });
    const count = await prisma.contentVersion.count({ where: { contentHash: hash } });
    expect(count).toBe(1);

    const next = await importVersion();
    expect(next.versionNo).toBe(first.versionNo + 1);
  });

  it("гонка двух импортов одного хэша: одна версия, оба ответа сходятся", async () => {
    const hash = randomHash();
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => importVersion(hash)));
    expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
    expect(new Set(outcomes.map((outcome) => outcome.versionNo)).size).toBe(1);
  });

  it("проверки базы: источник версии и статус проверки — из списка, хэш уникален", async () => {
    const first = await importVersion();
    const second = await importVersion();
    const firstHash = (await repository.version(first.versionNo))?.contentHash ?? "";
    await expect(prisma.$executeRaw`UPDATE content_version SET source = 'cloud' WHERE version_no = ${second.versionNo}`).rejects.toThrow(/content_version_source/);
    await expect(prisma.$executeRaw`UPDATE content_version SET content_hash = ${firstHash} WHERE version_no = ${second.versionNo}`).rejects.toThrow(/content_hash/);
    const draftId = randomUUID();
    draftIds.push(draftId);
    await repository.addDraft({ draftId, baseVersionNo: first.versionNo, title: "Проверки базы", snapshot: SNAPSHOT, author: randomUUID(), updatedAt: new Date(), archivedAt: null });
    await expect(prisma.$executeRaw`INSERT INTO content_check (check_id, draft_id, snapshot_hash, status, created_at) VALUES (gen_random_uuid(), ${draftId}::uuid, 'h', 'unknown', now())`).rejects.toThrow(/content_check_status/);
  });

  it("снимок и хэш переживают jsonb: порядок ключей в базе другой, а хэш тот же", async () => {
    const version = await importVersion();
    const draftId = randomUUID();
    draftIds.push(draftId);
    const { snapshotHash } = await import("../src/modules/content/content-hash.js");
    await repository.addDraft({ draftId, baseVersionNo: version.versionNo, title: "jsonb", snapshot: SNAPSHOT, author: randomUUID(), updatedAt: new Date(), archivedAt: null });
    const back = await repository.draft(draftId);
    expect(back?.snapshot).toEqual(SNAPSHOT);
    expect(snapshotHash(back?.snapshot)).toBe(snapshotHash(SNAPSHOT));
  });

  it("параллельные правки одного черновика не теряют друг друга", async () => {
    const version = await importVersion();
    const draftId = randomUUID();
    draftIds.push(draftId);
    await repository.addDraft({ draftId, baseVersionNo: version.versionNo, title: "Гонка правок", snapshot: SNAPSHOT, author: randomUUID(), updatedAt: new Date(0), archivedAt: null });
    const { editSnapshot } = await import("../src/modules/content/content-edit.js");
    const schema = (await repository.version(version.versionNo))?.jsonSchema;
    const targets = SNAPSHOT.enemies.slice(0, 6);
    await Promise.all(
      targets.map((enemy, index) =>
        repository.editDraft(draftId, new Date(), (current) => editSnapshot({ snapshot: current.snapshot, jsonSchema: schema, path: `enemies[id=${enemy.id}].hp`, value: 100 + index }).next),
      ),
    );
    const final = (await repository.draft(draftId))?.snapshot as Snap;
    expect(final.enemies.slice(0, 6).map((enemy) => enemy.hp)).toEqual(expect.arrayContaining([100, 101, 102, 103, 104, 105]));
  });

  it("проверка одного снимка черновика заводится один раз даже под гонкой", async () => {
    const version = await importVersion();
    const draftId = randomUUID();
    draftIds.push(draftId);
    await repository.addDraft({ draftId, baseVersionNo: version.versionNo, title: "Гонка проверок", snapshot: SNAPSHOT, author: randomUUID(), updatedAt: new Date(), archivedAt: null });
    const made = await Promise.all(
      Array.from({ length: 4 }, () => repository.addCheck({ checkId: randomUUID(), draftId, snapshotHash: "same-hash", status: "queued", report: null, createdAt: new Date() })),
    );
    expect(new Set(made.map((check) => check.checkId)).size).toBe(1);
    expect(await prisma.contentCheck.count({ where: { draftId } })).toBe(1);

    // Упавшая проверка место не занимает: после неё заводится новая.
    await repository.finishCheck(made[0]?.checkId ?? "", "failed", { error: "сбой" });
    const retried = await repository.addCheck({ checkId: randomUUID(), draftId, snapshotHash: "same-hash", status: "queued", report: null, createdAt: new Date() });
    expect(retried.checkId).not.toBe(made[0]?.checkId);
    expect(await repository.finishCheck(made[0]?.checkId ?? "", "done", {})).toBe(false);
  });

  async function start() {
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    const accounts = new MemoryAccountRepository();
    const roles = new MemoryRolesRepository();
    const queue = new FakeQueue();
    // Redis нет: счётчик лимита уходит в память процесса — те же 10 за 10 минут, что и с настоящим.
    const redis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;
    @Module({
      controllers: [AdminSessionController, AdminContentController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: redis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: new MemoryAdminSessionStore() },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: CONTENT_REPOSITORY, useValue: repository },
        { provide: CONTENT_CHECK_QUEUE, useValue: queue },
        ContentService,
        ContentCheckService,
        RateLimiter,
        PanelLoginService,
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

    const login = async (user: string) => {
      const response = await app!.inject({ method: "POST", url: "/api/v1/admin/session/dev", payload: { devUser: user } });
      return `${ADMIN_SESSION_COOKIE}=${/rubezh_admin_session=([^;]+)/.exec(String(response.headers["set-cookie"]))?.[1] ?? ""}`;
    };
    return { accounts, roles, queue, login };
  }

  const headers = (cookie: string) => ({ cookie, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE });

  it("HTTP: черновик → правка → разница → проверка; повтор с тем же снимком отдаёт прошлую", async () => {
    const version = await importVersion();
    const ctx = await start();
    const owner = headers(await ctx.login(`dev-${OWNER_ID}:Владелец`));
    const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: Record<string, unknown>, h = owner) => app!.inject({ method, url: `${BASE}${url}`, headers: h, ...(payload === undefined ? {} : { payload }) });

    const created = await call("POST", "/drafts", { title: "  Крысы потолще ", baseVersionNo: version.versionNo });
    expect(created.statusCode).toBe(201);
    const draft = created.json<{ data: { draftId: string; title: string; baseVersionNo: number; snapshotHash: string } }>().data;
    draftIds.push(draft.draftId);
    expect(draft).toMatchObject({ title: "Крысы потолще", baseVersionNo: version.versionNo });

    const patched = await call("PATCH", `/drafts/${draft.draftId}`, { path: HP_PATH, value: 7 });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<{ data: Record<string, unknown> }>().data).toMatchObject({ path: HP_PATH, from: ENEMY.hp, to: 7, changed: true });

    const diff = await call("GET", `/drafts/${draft.draftId}/diff`);
    expect(diff.statusCode).toBe(200);
    expect(diff.json<{ data: unknown }>().data).toEqual({ baseVersionNo: version.versionNo, changes: [{ path: HP_PATH, from: ENEMY.hp, to: 7 }], truncated: false });

    const detail = await call("GET", `/drafts/${draft.draftId}`);
    const stored = detail.json<{ data: { snapshot: Snap; snapshotHash: string; lastCheck: unknown } }>().data;
    expect(stored.snapshot.enemies[0]?.hp).toBe(7);
    expect(stored.snapshotHash).not.toBe(draft.snapshotHash);
    expect(stored.lastCheck).toBeNull();

    const first = await call("POST", `/drafts/${draft.draftId}/check`);
    expect(first.statusCode).toBe(201);
    const check = first.json<{ data: { reused: boolean; check: { checkId: string; status: string; snapshotHash: string } } }>().data;
    expect(check).toMatchObject({ reused: false, check: { status: "queued", snapshotHash: stored.snapshotHash } });
    expect(ctx.queue.jobs).toHaveLength(1);
    expect(ctx.queue.jobs[0]).toMatchObject({ checkId: check.check.checkId });
    expect((ctx.queue.jobs[0]?.snapshot as Snap).enemies[0]?.hp).toBe(7);
    expect((ctx.queue.jobs[0]?.baseSnapshot as Snap).enemies[0]?.hp).toBe(ENEMY.hp);

    ctx.queue.finish(check.check.checkId);
    const read = await call("GET", `/checks/${check.check.checkId}`);
    expect(read.json<{ data: { status: string; report: { elapsedMs: number } } }>().data).toMatchObject({ status: "done", report: { elapsedMs: 5 } });

    const repeat = await call("POST", `/drafts/${draft.draftId}/check`);
    expect(repeat.json<{ data: { reused: boolean; check: { checkId: string; status: string } } }>().data).toMatchObject({ reused: true, check: { checkId: check.check.checkId, status: "done" } });
    expect(ctx.queue.jobs).toHaveLength(1);

    const afterEdit = await call("PATCH", `/drafts/${draft.draftId}`, { path: HP_PATH, value: 8 });
    expect(afterEdit.statusCode).toBe(200);
    const fresh = await call("POST", `/drafts/${draft.draftId}/check`);
    expect(fresh.json<{ data: { reused: boolean } }>().data.reused).toBe(false);
    expect(ctx.queue.jobs).toHaveLength(2);

    const withCheck = await call("GET", `/drafts/${draft.draftId}`);
    expect(withCheck.json<{ data: { lastCheck: { status: string } } }>().data.lastCheck.status).toBe("queued");

    // аудит: создание, правки (путь, было → стало), проверки
    const actions = ctx.roles.entries.map((entry) => entry.action);
    expect(actions.filter((action) => action === "content.draft.patch")).toHaveLength(2);
    expect(actions).toEqual(expect.arrayContaining(["content.draft.create", "content.check.start"]));
    const patch = ctx.roles.entries.find((entry) => entry.action === "content.draft.patch");
    expect(patch).toMatchObject({ target: draft.draftId, before: { path: HP_PATH, value: ENEMY.hp }, after: { path: HP_PATH, value: 7 } });

    const archived = await call("POST", `/drafts/${draft.draftId}/archive`);
    expect(archived.statusCode).toBe(201);
    expect((await call("PATCH", `/drafts/${draft.draftId}`, { path: HP_PATH, value: 9 })).statusCode).toBe(409);
    const list = await call("GET", "/drafts");
    expect(list.json<{ data: { draftId: string }[] }>().data.some((row) => row.draftId === draft.draftId)).toBe(false);
  });

  it("HTTP: не та форма и несуществующий путь — 422 с путём; черновик не меняется", async () => {
    const version = await importVersion();
    const ctx = await start();
    const owner = headers(await ctx.login(`dev-${OWNER_ID}:Владелец`));
    const created = await app!.inject({ method: "POST", url: `${BASE}/drafts`, headers: owner, payload: { title: "422", baseVersionNo: version.versionNo } });
    const draftId = created.json<{ data: { draftId: string } }>().data.draftId;
    draftIds.push(draftId);
    const patch = (payload: Record<string, unknown>) => app!.inject({ method: "PATCH", url: `${BASE}/drafts/${draftId}`, headers: owner, payload });

    const wrongForm = await patch({ path: HP_PATH, value: "много" });
    expect(wrongForm.statusCode).toBe(422);
    expect(wrongForm.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: "content_value_invalid" });
    expect(wrongForm.json<{ error: { message: string } }>().error.message).toContain(HP_PATH);

    const missing = await patch({ path: "enemies[id=no_such_enemy].hp", value: 1 });
    expect(missing.statusCode).toBe(422);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe("content_path_invalid");

    expect((await patch({ value: 1 })).statusCode).toBe(400);
    expect((await patch({ path: HP_PATH })).statusCode).toBe(400);

    const stored = await repository.draft(draftId);
    expect(stored?.snapshot).toEqual(SNAPSHOT);
    expect(ctx.roles.entries.filter((entry) => entry.action === "content.draft.patch")).toHaveLength(0);
  });

  it("HTTP: без content.edit — 403 на правку и проверку, читать с content.view можно; без прав на контент — 403 на всё", async () => {
    const version = await importVersion();
    const ctx = await start();
    const owner = headers(await ctx.login(`dev-${OWNER_ID}:Владелец`));
    const created = await app!.inject({ method: "POST", url: `${BASE}/drafts`, headers: owner, payload: { title: "Права", baseVersionNo: version.versionNo } });
    const draftId = created.json<{ data: { draftId: string } }>().data.draftId;
    draftIds.push(draftId);

    const grant = async (id: string, role: "analyst" | "moderator") => {
      const account = await ctx.accounts.upsert({ platform: "telegram", platformUserId: `dev-player-${id}`, displayName: role, username: null, photoUrl: null }, Date.now());
      await ctx.roles.grant(account.accountId, role, null);
      return headers(await ctx.login(`dev-player-${id}:${role}`));
    };
    const analyst = await grant("9201", "analyst");
    const moderator = await grant("9202", "moderator");
    const inject = (h: ReturnType<typeof headers>, method: "GET" | "POST" | "PATCH", url: string, payload?: Record<string, unknown>) => app!.inject({ method, url: `${BASE}${url}`, headers: h, ...(payload === undefined ? {} : { payload }) });

    expect((await inject(analyst, "GET", "/drafts")).statusCode).toBe(200);
    expect((await inject(analyst, "GET", `/drafts/${draftId}`)).statusCode).toBe(200);
    expect((await inject(analyst, "GET", `/drafts/${draftId}/diff`)).statusCode).toBe(200);
    expect((await inject(analyst, "GET", "/versions")).statusCode).toBe(200);
    expect((await inject(analyst, "PATCH", `/drafts/${draftId}`, { path: HP_PATH, value: 7 })).statusCode).toBe(403);
    expect((await inject(analyst, "POST", "/drafts", { title: "x" })).statusCode).toBe(403);
    expect((await inject(analyst, "POST", `/drafts/${draftId}/check`)).statusCode).toBe(403);
    expect((await inject(analyst, "POST", `/drafts/${draftId}/archive`)).statusCode).toBe(403);
    expect((await inject(moderator, "GET", "/drafts")).statusCode).toBe(403);
    expect((await inject(moderator, "GET", "/versions")).statusCode).toBe(403);

    // Без заголовка панели изменяющий запрос не принимается и у владельца.
    const noCsrf = await app!.inject({ method: "PATCH", url: `${BASE}/drafts/${draftId}`, headers: { cookie: owner.cookie }, payload: { path: HP_PATH, value: 7 } });
    expect(noCsrf.statusCode).toBe(403);
    expect((await repository.draft(draftId))?.snapshot).toEqual(SNAPSHOT);
  });

  it("HTTP: 11-я проверка за 10 минут — 429, десять прошли", async () => {
    const version = await importVersion();
    const ctx = await start();
    const owner = headers(await ctx.login(`dev-${OWNER_ID}:Владелец`));
    const created = await app!.inject({ method: "POST", url: `${BASE}/drafts`, headers: owner, payload: { title: "Лимит", baseVersionNo: version.versionNo } });
    const draftId = created.json<{ data: { draftId: string } }>().data.draftId;
    draftIds.push(draftId);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await app!.inject({ method: "POST", url: `${BASE}/drafts/${draftId}/check`, headers: owner });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
    // повторы того же снимка — не новые задания, но лимит их считает: он бережёт запросы, а не воркер
    expect(ctx.queue.jobs).toHaveLength(1);
  });

  it("HTTP: список версий — без снимков; версия целиком — со снимком, именами и схемой", async () => {
    const version = await importVersion();
    const ctx = await start();
    const owner = headers(await ctx.login(`dev-${OWNER_ID}:Владелец`));
    const list = await app!.inject({ method: "GET", url: `${BASE}/versions`, headers: owner });
    const rows = list.json<{ data: Record<string, unknown>[] }>().data;
    expect(rows.find((row) => row.versionNo === version.versionNo)).toMatchObject({ source: "repo", schemaVersion: 1 });
    expect(rows[0]).not.toHaveProperty("snapshot");
    const full = await app!.inject({ method: "GET", url: `${BASE}/versions/${version.versionNo}`, headers: owner });
    expect(full.json<{ data: { snapshot: Snap; names: Record<string, string>; jsonSchema: unknown } }>().data).toMatchObject({ names: { "enemy.swarm_rat.name": "Крыса" }, jsonSchema: { type: "object" } });
    expect((await app!.inject({ method: "GET", url: `${BASE}/versions/999999999`, headers: owner })).statusCode).toBe(404);
    expect((await app!.inject({ method: "GET", url: `${BASE}/versions/abc`, headers: owner })).statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Настоящий BullMQ
// ---------------------------------------------------------------------------

describe.skipIf(REDIS_URL === "")("очередь проверок сервера на живом Redis", () => {
  const clients: Redis[] = [];
  const closers: (() => Promise<void>)[] = [];
  let queueName = "";
  let config: AppConfig;
  let inspect: Queue;

  const connection = (): Redis => {
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    clients.push(redis);
    return redis;
  };

  const job = (): CheckJobPayload => ({ checkId: randomUUID(), snapshot: SNAPSHOT, baseSnapshot: SNAPSHOT });

  beforeAll(() => {
    queueName = `content-check-test-${randomUUID()}`;
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, REDIS_URL } as NodeJS.ProcessEnv);
    inspect = new Queue(queueName, { connection: connection() });
  });

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await inspect.obliterate({ force: true });
  });

  afterAll(async () => {
    await inspect.close();
    for (const redis of clients) redis.disconnect();
  });

  function make(): BullContentCheckQueue {
    const queue = new BullContentCheckQueue(config, queueName);
    closers.push(() => queue.onModuleDestroy());
    return queue;
  }

  it("задание в форме воркера: идентификатор — id задания, умолчания дозаполнит воркер", async () => {
    const queue = make();
    const payload = job();
    await queue.submit(payload);
    const stored = await inspect.getJob(payload.checkId);
    expect(stored?.data).toEqual(payload);
    expect(await queue.poll(payload.checkId)).toEqual({ state: "pending" });
    expect(await queue.poll(randomUUID())).toEqual({ state: "missing" });
  });

  it("шестое ждущее задание отклоняется как «Проверка уже идёт, дождитесь»", async () => {
    const queue = make();
    for (let index = 0; index < 5; index += 1) await queue.submit(job());
    await expect(queue.submit(job())).rejects.toBeInstanceOf(ContentCheckBusyError);
    await expect(queue.submit(job())).rejects.toThrow("Проверка уже идёт, дождитесь");
  });

  it("снимок больше 2 МБ не ставится", async () => {
    const queue = make();
    const fat = { ...job(), snapshot: { pad: "я".repeat(2 * 1024 * 1024) } };
    await expect(queue.submit(fat)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("итог воркера читается заданием: готово и сбой", async () => {
    const queue = make();
    const ok = job();
    const bad = job();
    await queue.submit(ok);
    await queue.submit(bad);
    const worker = new Worker(
      queueName,
      async (received) => {
        if (received.id === bad.checkId) throw new Error("падение прогона");
        return { checkId: ok.checkId, schemaProblems: [], contentProblems: [], report: null, elapsedMs: 1 };
      },
      { connection: connection(), concurrency: 1 },
    );
    closers.push(() => worker.close());
    const deadline = Date.now() + 10_000;
    let states: [CheckJobState, CheckJobState] = [{ state: "pending" }, { state: "pending" }];
    while (Date.now() < deadline && states.some((state) => state.state === "pending")) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      states = [await queue.poll(ok.checkId), await queue.poll(bad.checkId)];
    }
    expect(states[0]).toEqual({ state: "finished", result: { checkId: ok.checkId, schemaProblems: [], contentProblems: [], report: null, elapsedMs: 1 } });
    expect(states[1]).toMatchObject({ state: "failed", reason: "падение прогона" });
  });

  it("отмена снимает ждущее задание", async () => {
    const queue = make();
    const payload = job();
    await queue.submit(payload);
    await queue.cancel(payload.checkId);
    expect(await queue.poll(payload.checkId)).toEqual({ state: "missing" });
  });
});
