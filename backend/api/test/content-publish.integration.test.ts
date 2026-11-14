import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildExport } from "../../../scripts/content/export-snapshot";
import { CONTENT_SNAPSHOT } from "../../../packages/core-game/src/content/snapshot";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminContentController } from "../src/modules/admin/admin-content.controller.js";
import { AdminContentPublishController } from "../src/modules/admin/admin-content-publish.controller.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE } from "../src/modules/admin/admin-session.store.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { CONTENT_CHECK_QUEUE, type CheckJobPayload, type CheckJobState, type ContentCheckQueue } from "../src/modules/content/content-check.queue.js";
import { ContentCheckService } from "../src/modules/content/content-check.service.js";
import { adoptRepoVersion } from "../src/modules/content/content-adopt.js";
import { ContentDeliveryController } from "../src/modules/content/content-delivery.controller.js";
import { ContentDeliveryService } from "../src/modules/content/content-delivery.service.js";
import { snapshotHash } from "../src/modules/content/content-hash.js";
import { importContentVersion, type ParsedContentExport } from "../src/modules/content/content-import.js";
import { CONTENT_PUBLISH_LOCK, RedisContentPublishLock, type ContentPublishLock } from "../src/modules/content/content-publish-lock.js";
import { ContentPublishService } from "../src/modules/content/content-publish.service.js";
import { CONTENT_PUBLISH_REPOSITORY, PrismaContentPublishRepository } from "../src/modules/content/content-publish.repository.js";
import { CONTENT_REPOSITORY, PrismaContentRepository } from "../src/modules/content/content.repository.js";
import { ContentService } from "../src/modules/content/content.service.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../src/modules/settings/settings.service.js";
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
 * Публикация контента на живом Postgres (tasks/T-0306; адрес — TEST_DATABASE_URL,
 * без него пропуск): версия сначала команде, потом всем, только после свежей
 * зелёной проверки; откат; версия для клиента по его схеме; снимок по хэшу;
 * версии «из кода» при выкате. Очередь проверок — подмена, замок — в памяти;
 * настоящий замок на Redis — второй блок (PLAYTEST_TEST_REDIS_URL).
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 6);
const OWNER_ID = "777000306";
const ADMIN = "/api/v1/admin/content";

interface Snap {
  schemaVersion: number;
  enemies: { id: string; hp: number; size?: number }[];
}
const SNAPSHOT = JSON.parse(JSON.stringify(CONTENT_SNAPSHOT)) as Snap;
const ENEMY = SNAPSHOT.enemies[0];
const SECOND = SNAPSHOT.enemies[1];
if (ENEMY === undefined || SECOND === undefined) throw new Error("в контенте меньше двух врагов");
const HP_PATH = `enemies[id=${ENEMY.id}].hp`;

/** Хэш версии «из кода» для теста: база общая и между прогонами, настоящий хэш повторного прогона уже занят. */
const randomHash = (): string => randomBytes(4).toString("hex");

type Verdict = "in" | "below" | "above";

/** Строка отчёта воркера (`apps/sim-worker/src/report.ts`): метрика черновика и её вердикт по коридору. */
function corridor(verdict: Verdict) {
  const bounds = { min: 150, max: 480 };
  return {
    id: "dodgingMedianSec",
    title: "Уклоняющийся бот: медиана жизни, с",
    corridor: bounds,
    baseCorridor: bounds,
    draft: { value: verdict === "in" ? 300 : 700, verdict },
    base: { value: 300, verdict: "in" },
  };
}

interface ReportOptions {
  verdict?: Verdict;
  schemaProblems?: { path: string; message: string }[];
  contentProblems?: { path: string; message: string }[];
  timeout?: boolean;
  corridors?: unknown[];
}

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
  finish(checkId: string, options: ReportOptions = {}): void {
    const { verdict = "in", schemaProblems = [], contentProblems = [], timeout = false } = options;
    const corridors = options.corridors ?? [corridor(verdict)];
    this.states.set(checkId, {
      state: "finished",
      result: { checkId, schemaProblems, contentProblems, report: { timeout, seeds: 2, scenarios: [], corridors }, elapsedMs: 5 },
    });
  }
}

/** Замок в памяти процесса: один держатель, остальные ждут — как `SET NX` в Redis. */
class MemoryLock implements ContentPublishLock {
  held: string | null = null;
  async acquire(token: string): Promise<boolean> {
    if (this.held !== null) return false;
    this.held = token;
    return true;
  }
  async release(token: string): Promise<void> {
    if (this.held === token) this.held = null;
  }
}

/** Замок, который всегда отдаётся: целостность версии обязана держаться и без него. */
class OpenLock implements ContentPublishLock {
  async acquire(): Promise<boolean> {
    return true;
  }
  async release(): Promise<void> {}
}

/** Настройки теста: значения по умолчанию из каталога, поверх — то, что задал кейс. */
class StubSettings implements SettingsReader {
  readonly overrides = new Map<string, boolean>();
  get<T extends string | boolean | number>(setting: { key: string; fallback: T }): T {
    return (this.overrides.get(setting.key) as T | undefined) ?? setting.fallback;
  }
  onChange(): void {}
}

describe.skipIf(DATABASE_URL === "")("публикация контента на живом Postgres", () => {
  let prisma: PrismaClient;
  let repository: PrismaContentRepository;
  let publishRepository: PrismaContentPublishRepository;
  let app: NestFastifyApplication | null = null;
  const versionNos: number[] = [];
  const draftIds: string[] = [];
  let savedPointers: { audience: string; versionNo: number; setBy: string | null; setAt: Date }[] = [];

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 10);
    repository = new PrismaContentRepository(prisma);
    publishRepository = new PrismaContentPublishRepository(prisma);
    // Указатели общие на всю базу: чужие откладываются и возвращаются после файла.
    savedPointers = await prisma.contentCurrent.findMany();
  });

  beforeEach(async () => {
    await prisma.contentCurrent.deleteMany();
  });

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  afterAll(async () => {
    await prisma.contentCurrent.deleteMany();
    await prisma.contentCheck.deleteMany({ where: { draftId: { in: draftIds } } });
    await prisma.contentDraft.deleteMany({ where: { draftId: { in: draftIds } } });
    await prisma.contentVersion.deleteMany({ where: { versionNo: { in: versionNos } } });
    if (savedPointers.length > 0) await prisma.contentCurrent.createMany({ data: savedPointers, skipDuplicates: true });
    await prisma.$disconnect();
  });

  const track = (versionNo: number): number => {
    versionNos.push(versionNo);
    return versionNo;
  };

  /**
   * Версий панели в базе: соседние файлы тестов идут параллельно и заводят версии «из кода», так что
   * общий счёт между двумя чтениями меняется не только нами; версии панели в этих файлах не заводит никто.
   */
  const panelVersions = (): Promise<number> => prisma.contentVersion.count({ where: { source: "panel" } });

  /** Версия «из кода» с произвольным снимком: ровно то, что кладёт `content:import`. */
  async function importSnapshot(snapshot: Snap = SNAPSHOT, hash = randomHash()): Promise<{ created: boolean; versionNo: number; contentHash: string }> {
    const files = buildExport(CONTENT_SNAPSHOT, { "enemy.swarm_rat.name": "Крыса" }).files;
    const parsed: ParsedContentExport = {
      contentHash: hash,
      schemaVersion: snapshot.schemaVersion,
      snapshot,
      jsonSchema: JSON.parse(files["content-snapshot.schema.json"] ?? "{}") as unknown,
      names: { "enemy.swarm_rat.name": "Крыса" },
    };
    const outcome = await importContentVersion(repository, parsed, new Date());
    if (outcome.created) track(outcome.versionNo);
    return outcome;
  }

  async function start(options: { lock?: ContentPublishLock } = {}) {
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    const accounts = new MemoryAccountRepository();
    const roles = new MemoryRolesRepository();
    const queue = new FakeQueue();
    const settings = new StubSettings();
    // Redis нет: счётчик лимита уходит в память процесса.
    const redis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;
    @Module({
      controllers: [AdminSessionController, AdminContentController, AdminContentPublishController, ContentDeliveryController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: redis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: roles },
        { provide: ADMIN_SESSION_STORE, useValue: new MemoryAdminSessionStore() },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: AppLinks, useValue: new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]) },
        { provide: CONTENT_REPOSITORY, useValue: repository },
        { provide: CONTENT_PUBLISH_REPOSITORY, useValue: publishRepository },
        { provide: CONTENT_PUBLISH_LOCK, useValue: options.lock ?? new MemoryLock() },
        { provide: CONTENT_CHECK_QUEUE, useValue: queue },
        { provide: SETTINGS_READER, useValue: settings },
        ContentService,
        ContentCheckService,
        ContentPublishService,
        ContentDeliveryService,
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
    const owner = { cookie: await login(`dev-${OWNER_ID}:Владелец`), [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE };
    const adminCall = (method: "GET" | "POST" | "PATCH", url: string, payload?: Record<string, unknown>, headers: Record<string, string> = owner) =>
      app!.inject({ method, url: `${ADMIN}${url}`, headers, ...(payload === undefined ? {} : { payload }) });

    /** Аккаунт игрока: токен для клиентских маршрутов; роль выдаётся, если задана. */
    const player = async (id: string, role?: "analyst" | "game_designer" | "moderator") => {
      const account = await accounts.upsert({ platform: "telegram", platformUserId: `dev-player-${id}`, displayName: `Игрок ${id}`, username: null, photoUrl: null }, Date.now());
      if (role !== undefined) await roles.grant(account.accountId, role, null);
      const token = await signAccessToken({ accountId: account.accountId, platform: "telegram", platformUserId: `dev-player-${id}` }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
      const bearer = { authorization: `Bearer ${token}` };
      const current = async (schema: number | string = 1) => {
        const response = await app!.inject({ method: "GET", url: `/api/v1/content/current?schema=${String(schema)}`, headers: bearer });
        return { status: response.statusCode, data: (response.json() as { data?: { versionNo: number; hash: string; url: string } | null }).data };
      };
      const panelHeaders = async () => ({ cookie: await login(`dev-player-${id}:${id}`), [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE });
      return { account, bearer, current, panelHeaders };
    };

    /** Черновик с правкой hp и (по желанию) зелёной проверкой по его текущему снимку. */
    const draftOf = async (baseVersionNo: number, options: { hp?: number; check?: ReportOptions | false } = {}) => {
      const created = await adminCall("POST", "/drafts", { title: `Публикация ${randomUUID().slice(0, 6)}`, baseVersionNo });
      const draftId = created.json<{ data: { draftId: string } }>().data.draftId;
      draftIds.push(draftId);
      if (options.hp !== undefined) expect((await adminCall("PATCH", `/drafts/${draftId}`, { path: HP_PATH, value: options.hp })).statusCode).toBe(200);
      const checked = async (report: ReportOptions = {}) => {
        const started = await adminCall("POST", `/drafts/${draftId}/check`);
        const checkId = started.json<{ data: { check: { checkId: string } } }>().data.check.checkId;
        queue.finish(checkId, report);
        await adminCall("GET", `/checks/${checkId}`);
        return checkId;
      };
      if (options.check !== false && options.check !== undefined) await checked(options.check);
      return { draftId, checked };
    };

    const publish = async (draftId: string, audience: "team" | "all", headers: Record<string, string> = owner) => {
      const response = await adminCall("POST", `/drafts/${draftId}/publish`, { audience }, headers);
      const body = response.json<{ data?: { versionNo: number; contentHash: string; created: boolean; changed: boolean; previousVersionNo: number | null; audience: string }; error?: { code: string; message: string } }>();
      if (body.data !== undefined) track(body.data.versionNo);
      return { status: response.statusCode, data: body.data, error: body.error };
    };
    const rollback = async (audience: "team" | "all", versionNo: number, headers: Record<string, string> = owner) => {
      const response = await adminCall("POST", "/rollback", { audience, versionNo }, headers);
      const body = response.json<{ data?: { versionNo: number; previousVersionNo: number | null; changed: boolean }; error?: { code: string; message: string } }>();
      return { status: response.statusCode, data: body.data, error: body.error };
    };
    const pointers = async () => {
      const response = await adminCall("GET", "/current");
      const data = response.json<{ data: { team: { versionNo: number } | null; all: { versionNo: number } | null } }>().data;
      return { team: data.team, all: data.all };
    };
    return { accounts, roles, queue, settings, owner, login, adminCall, player, draftOf, publish, rollback, pointers };
  }

  it("публикация без свежей проверки — 409 content_check_required с причиной; версии и указателя нет", async () => {
    const base = await importSnapshot();
    const ctx = await start();
    const { draftId } = await ctx.draftOf(base.versionNo, { hp: 7 });
    const before = await panelVersions();

    // проверки не было вовсе
    const none = await ctx.publish(draftId, "team");
    expect(none.status).toBe(409);
    expect(none.error?.code).toBe("content_check_required");
    expect(none.error?.message).toContain("Проверить");

    // проверка поставлена, итога ещё нет
    const started = await ctx.adminCall("POST", `/drafts/${draftId}/check`);
    const checkId = started.json<{ data: { check: { checkId: string } } }>().data.check.checkId;
    const waiting = await ctx.publish(draftId, "all");
    expect(waiting.status).toBe(409);
    expect(waiting.error?.message).toContain("идёт");

    // воркер вернул «вне коридора»: публиковать нельзя, а в причине — метрика
    ctx.queue.finish(checkId, { verdict: "above" });
    await ctx.adminCall("GET", `/checks/${checkId}`);
    const outside = await ctx.publish(draftId, "all");
    expect(outside.status).toBe(409);
    expect(outside.error?.code).toBe("content_check_required");
    expect(outside.error?.message).toContain("Уклоняющийся бот: медиана жизни");

    expect(await panelVersions()).toBe(before);
    expect(await ctx.pointers()).toEqual({ team: null, all: null });
    expect(ctx.roles.entries.filter((entry) => entry.action.startsWith("content.publish"))).toHaveLength(0);
  });

  it("проверка с проблемами схемы или контента, по таймауту и без метрик — не годится для публикации", async () => {
    const base = await importSnapshot();
    const ctx = await start();

    const withSchema = await ctx.draftOf(base.versionNo, { hp: 11, check: { schemaProblems: [{ path: "enemies.0.hp", message: "должно быть больше 0" }] } });
    const schema = await ctx.publish(withSchema.draftId, "team");
    expect(schema.status).toBe(409);
    expect(schema.error?.message).toContain("enemies.0.hp");

    const withContent = await ctx.draftOf(base.versionNo, { hp: 12, check: { contentProblems: [{ path: "timeline", message: "бюджет угрозы убывает" }] } });
    expect((await ctx.publish(withContent.draftId, "team")).error?.message).toContain("бюджет угрозы убывает");

    const timedOut = await ctx.draftOf(base.versionNo, { hp: 13, check: { timeout: true } });
    expect((await ctx.publish(timedOut.draftId, "team")).status).toBe(409);

    // отчёт без единой метрики: рельсы панели такой прогон тоже не засчитывают
    const empty = await ctx.draftOf(base.versionNo, { hp: 14, check: { corridors: [] } });
    const noMetrics = await ctx.publish(empty.draftId, "team");
    expect(noMetrics.status).toBe(409);
    expect(noMetrics.error?.message).toContain("метрик");

    expect(await ctx.pointers()).toEqual({ team: null, all: null });
  });

  it("проверка по другому хэшу: правка после проверки делает её негодной, новая проверка — годной", async () => {
    const base = await importSnapshot();
    const ctx = await start();
    const { draftId, checked } = await ctx.draftOf(base.versionNo, { hp: 7, check: {} });
    await ctx.adminCall("PATCH", `/drafts/${draftId}`, { path: HP_PATH, value: 8 });

    const stale = await ctx.publish(draftId, "team");
    expect(stale.status).toBe(409);
    expect(stale.error?.code).toBe("content_check_required");
    expect(stale.error?.message).toContain("менялся после проверки");

    await checked();
    const fresh = await ctx.publish(draftId, "team");
    expect(fresh.status).toBe(201);
    const stored = await repository.version(fresh.data?.versionNo ?? 0);
    expect((stored?.snapshot as Snap).enemies[0]?.hp).toBe(8);
  });

  it("«Команде» — версия у аккаунта с ролью, у игрока прежняя; «Всем» — у всех", async () => {
    const base = await importSnapshot();
    const ctx = await start();
    const teammate = await ctx.player("9301", "analyst");
    const gamer = await ctx.player("9302");
    // до публикации: у всех встроенное — сервер версию не называет
    expect((await gamer.current()).data).toBeNull();
    expect(await adoptRepoVersion(publishRepository, base.versionNo, new Date())).toMatchObject({ adopted: ["all"] });
    expect((await gamer.current()).data?.versionNo).toBe(base.versionNo);
    expect((await teammate.current()).data?.versionNo).toBe(base.versionNo);

    const { draftId } = await ctx.draftOf(base.versionNo, { hp: 9, check: {} });
    const toTeam = await ctx.publish(draftId, "team");
    expect(toTeam.status).toBe(201);
    expect(toTeam.data).toMatchObject({ audience: "team", created: true, changed: true, previousVersionNo: base.versionNo });
    const published = toTeam.data?.versionNo ?? 0;
    expect(published).toBeGreaterThan(base.versionNo);

    const team = await teammate.current();
    expect(team.data?.versionNo).toBe(published);
    expect(team.data?.hash).toBe(snapshotHash((await repository.version(published))?.snapshot));
    expect(team.data?.url).toBe(`/api/v1/content/v/${team.data?.hash ?? ""}.json`);
    expect((await gamer.current()).data?.versionNo).toBe(base.versionNo);
    expect(await ctx.pointers()).toMatchObject({ team: { versionNo: published }, all: { versionNo: base.versionNo } });

    // тот же снимок «Всем»: новой версии нет, указатель «всем» переезжает
    const toAll = await ctx.publish(draftId, "all");
    expect(toAll.status).toBe(201);
    expect(toAll.data).toMatchObject({ audience: "all", created: false, changed: true, versionNo: published, previousVersionNo: base.versionNo });
    expect((await gamer.current()).data?.versionNo).toBe(published);
    expect((await teammate.current()).data?.versionNo).toBe(published);
    expect(await ctx.pointers()).toMatchObject({ team: { versionNo: published }, all: { versionNo: published } });

    // повтор — ничего не меняет и не пишется в аудит
    const auditBefore = ctx.roles.entries.filter((entry) => entry.action === "content.publish").length;
    const again = await ctx.publish(draftId, "all");
    expect(again.data).toMatchObject({ created: false, changed: false, versionNo: published });
    expect(ctx.roles.entries.filter((entry) => entry.action === "content.publish")).toHaveLength(auditBefore);

    const stored = await repository.version(published);
    expect(stored).toMatchObject({ source: "panel", schemaVersion: 1, names: { "enemy.swarm_rat.name": "Крыса" } });
    expect(stored?.publishedAt).not.toBeNull();
    expect(stored?.createdBy).toBe(ctx.roles.entries.find((entry) => entry.action === "content.publish")?.actorAccountId);
  });

  it("публикация «Всем» сразу, без «Команде», ставит оба указателя", async () => {
    const base = await importSnapshot();
    const ctx = await start();
    const { draftId } = await ctx.draftOf(base.versionNo, { hp: 10, check: {} });
    const result = await ctx.publish(draftId, "all");
    expect(result.status).toBe(201);
    expect(await ctx.pointers()).toMatchObject({ team: { versionNo: result.data?.versionNo }, all: { versionNo: result.data?.versionNo } });
  });

  it("откат возвращает прошлую версию той же аудитории; новой версии нет; в аудите", async () => {
    const base = await importSnapshot();
    const ctx = await start();
    const gamer = await ctx.player("9311");
    await adoptRepoVersion(publishRepository, base.versionNo, new Date());
    const first = await ctx.draftOf(base.versionNo, { hp: 21, check: {} });
    const v1 = (await ctx.publish(first.draftId, "all")).data?.versionNo ?? 0;
    const second = await ctx.draftOf(base.versionNo, { hp: 22, check: {} });
    const v2 = (await ctx.publish(second.draftId, "all")).data?.versionNo ?? 0;
    expect((await gamer.current()).data?.versionNo).toBe(v2);
    const versionsBefore = await panelVersions();

    const back = await ctx.rollback("all", v1);
    expect(back.status).toBe(201);
    expect(back.data).toMatchObject({ versionNo: v1, previousVersionNo: v2, changed: true });
    expect((await gamer.current()).data?.versionNo).toBe(v1);
    expect(await panelVersions()).toBe(versionsBefore);
    // «Команде» откат «Всем» не трогает: она остаётся на новой версии
    expect(await ctx.pointers()).toMatchObject({ team: { versionNo: v2 }, all: { versionNo: v1 } });

    // и на версию из кода, которая была в игре до панели
    expect((await ctx.rollback("all", base.versionNo)).data?.versionNo).toBe(base.versionNo);
    expect((await gamer.current()).data?.versionNo).toBe(base.versionNo);

    // второй откат: с v1 на версию из кода
    const entry = ctx.roles.entries.filter((row) => row.action === "content.rollback")[1];
    expect(entry).toMatchObject({ target: "all", before: { versionNo: v1 }, after: { versionNo: base.versionNo } });
    // повтор на ту же версию — не событие
    const count = ctx.roles.entries.filter((row) => row.action === "content.rollback").length;
    expect((await ctx.rollback("all", base.versionNo)).data?.changed).toBe(false);
    expect(ctx.roles.entries.filter((row) => row.action === "content.rollback")).toHaveLength(count);
  });

  it("откат на версию, которой не было в игре, на несуществующую и «Всем» без публикаций — отказ", async () => {
    const base = await importSnapshot();
    const unpublished = await importSnapshot(SNAPSHOT, randomHash());
    const ctx = await start();

    // нечего откатывать: для всех ничего не публиковалось
    const nothing = await ctx.rollback("all", base.versionNo);
    expect(nothing.status).toBe(409);
    expect(nothing.error?.code).toBe("content_rollback_invalid");

    await adoptRepoVersion(publishRepository, base.versionNo, new Date());
    const never = await ctx.rollback("all", unpublished.versionNo);
    expect(never.status).toBe(409);
    expect(never.error?.message).toContain("не публиковалась");
    expect((await ctx.rollback("all", 2_000_000_000)).status).toBe(404);
    expect(await ctx.pointers()).toMatchObject({ all: { versionNo: base.versionNo } });
  });

  it("две публикации разом — одна версия; даже без замка", async () => {
    const base = await importSnapshot();
    for (const lock of [undefined, new OpenLock()]) {
      const ctx = await start(lock === undefined ? {} : { lock });
      const { draftId } = await ctx.draftOf(base.versionNo, { hp: 30 + (lock === undefined ? 0 : 1), check: {} });
      const before = await panelVersions();
      const results = await Promise.all([ctx.publish(draftId, "all"), ctx.publish(draftId, "all"), ctx.publish(draftId, "team")]);
      expect(results.map((result) => result.status)).toEqual([201, 201, 201]);
      expect(new Set(results.map((result) => result.data?.versionNo)).size).toBe(1);
      expect(results.filter((result) => result.data?.created)).toHaveLength(1);
      expect(await panelVersions()).toBe(before + 1);
      await app?.close();
      app = null;
    }
  });

  it("замок занят дольше срока ожидания — 409 content_publish_busy, ничего не записано", async () => {
    const base = await importSnapshot();
    const stuck = new MemoryLock();
    stuck.held = "другая-реплика";
    const ctx = await start({ lock: stuck });
    const { draftId } = await ctx.draftOf(base.versionNo, { hp: 33, check: {} });
    const before = await panelVersions();
    const result = await ctx.publish(draftId, "all");
    expect(result.status).toBe(409);
    expect(result.error?.code).toBe("content_publish_busy");
    expect(await panelVersions()).toBe(before);
    expect((await ctx.rollback("all", base.versionNo)).error?.code).toBe("content_publish_busy");
  }, 20_000);

  it("клиент со схемой 1 при текущей версии со схемой 2 получает последнюю опубликованную со схемой 1", async () => {
    const base = await importSnapshot();
    const ctx = await start();
    const gamer = await ctx.player("9321");
    const { draftId } = await ctx.draftOf(base.versionNo, { hp: 41, check: {} });
    const schema1 = (await ctx.publish(draftId, "all")).data?.versionNo ?? 0;
    // версия со схемой 2, опубликованная панелью: заводится строкой — форму 2 редактор ещё не умеет
    const row = await prisma.contentVersion.create({
      data: {
        contentHash: randomBytes(32).toString("hex"),
        schemaVersion: 2,
        snapshot: { ...SNAPSHOT, schemaVersion: 2 },
        jsonSchema: {},
        names: {},
        source: "panel",
        publishedAt: new Date(),
      },
    });
    track(row.versionNo);
    expect((await ctx.rollback("all", row.versionNo)).status).toBe(201);

    expect((await gamer.current(1)).data).toMatchObject({ versionNo: schema1 });
    expect((await gamer.current(2)).data).toMatchObject({ versionNo: row.versionNo, hash: row.contentHash });
    expect((await gamer.current(3)).data).toMatchObject({ versionNo: row.versionNo });
    // схемы 0 не бывает: клиент без схемы версию не получает вовсе
    expect((await gamer.current(0)).status).toBe(400);
  });

  it("у текущей версии схема новее клиента: клиент получает последнюю из бывших в игре, которую понимает", async () => {
    const ctx = await start();
    const gamer = await ctx.player("9322");
    const row = await prisma.contentVersion.create({
      data: { contentHash: randomBytes(32).toString("hex"), schemaVersion: 5, snapshot: {}, jsonSchema: {}, names: {}, source: "panel", publishedAt: new Date() },
    });
    track(row.versionNo);
    await prisma.contentCurrent.create({ data: { audience: "all", versionNo: row.versionNo, setAt: new Date() } });
    // База общая: версии соседних тестов тоже бывали в игре, поэтому ждём ровно последнюю из них, а не пустоту.
    const older = await prisma.contentVersion.findFirst({ where: { publishedAt: { not: null }, versionNo: { lt: row.versionNo }, schemaVersion: { lte: 1 } }, orderBy: { versionNo: "desc" } });
    expect((await gamer.current(1)).data?.versionNo ?? null).toBe(older?.versionNo ?? null);
    expect((await gamer.current(5)).data?.versionNo).toBe(row.versionNo);  });

  it("клиентский маршрут: без токена — 401, схема обязательна и целая", async () => {
    const ctx = await start();
    const gamer = await ctx.player("9323");
    expect((await app!.inject({ method: "GET", url: "/api/v1/content/current?schema=1" })).statusCode).toBe(401);
    for (const schema of ["", "abc", "1.5", "-1", "0", "70000"]) {
      const response = await app!.inject({ method: "GET", url: `/api/v1/content/current?schema=${schema}`, headers: gamer.bearer });
      expect(response.statusCode, `schema=${schema}`).toBe(400);
    }
    expect((await app!.inject({ method: "GET", url: "/api/v1/content/current", headers: gamer.bearer })).statusCode).toBe(400);
    // параметра «команда» нет: сервер берёт аудиторию из сессии, а не из запроса
    const base = await importSnapshot();
    await adoptRepoVersion(publishRepository, base.versionNo, new Date());
    const { draftId } = await ctx.draftOf(base.versionNo, { hp: 51, check: {} });
    const teamVersion = (await ctx.publish(draftId, "team")).data?.versionNo ?? 0;
    const forged = await app!.inject({ method: "GET", url: "/api/v1/content/current?schema=1&team=1", headers: gamer.bearer });
    expect(forged.json<{ data: { versionNo: number } }>().data.versionNo).toBe(base.versionNo);
    expect(teamVersion).not.toBe(base.versionNo);
  });

  it("снимок по хэшу — вечный кеш, ETag и 304; неопубликованная версия, чужой хэш и мусор — 404", async () => {
    const base = await importSnapshot();
    const unpublished = await importSnapshot(SNAPSHOT, randomHash());
    const ctx = await start();
    await adoptRepoVersion(publishRepository, base.versionNo, new Date());
    const { draftId } = await ctx.draftOf(base.versionNo, { hp: 61, check: {} });
    const version = (await ctx.publish(draftId, "all")).data;
    const hash = version?.contentHash ?? "";

    const response = await app!.inject({ method: "GET", url: `/api/v1/content/v/${hash}.json` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers.etag).toBe(`"${hash}"`);
    // тело — сам снимок, без конверта: клиент проверяет его схемой и хэшем
    const body = response.json<Snap>();
    expect(body.enemies[0]?.hp).toBe(61);
    expect(snapshotHash(body)).toBe(hash);

    const revalidated = await app!.inject({ method: "GET", url: `/api/v1/content/v/${hash}.json`, headers: { "if-none-match": `"${hash}"` } });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.body).toBe("");

    // версия «из кода», которая в игре была, отдаётся; которой не было — нет
    expect((await app!.inject({ method: "GET", url: `/api/v1/content/v/${base.contentHash}.json` })).statusCode).toBe(200);
    expect((await app!.inject({ method: "GET", url: `/api/v1/content/v/${unpublished.contentHash}.json` })).statusCode).toBe(404);
    expect((await app!.inject({ method: "GET", url: `/api/v1/content/v/${"0".repeat(64)}.json` })).statusCode).toBe(404);
    for (const bad of ["../x.json", "ZZZZZZZZ.json", `${hash}.html`, `${hash}`, "abc.json"]) {
      expect((await app!.inject({ method: "GET", url: `/api/v1/content/v/${bad}` })).statusCode, bad).toBe(404);
    }
  });

  it("импорт из кода при текущей версии panel — версия рядом, указатели не тронуты; при repo — указатель идёт за кодом", async () => {
    const base = await importSnapshot();
    const ctx = await start();
    // до первой публикации указателей нет: выкат делает версию текущей для всех
    expect(await adoptRepoVersion(publishRepository, base.versionNo, new Date())).toEqual({ adopted: ["all"] });
    expect(await ctx.pointers()).toEqual({ team: null, all: expect.objectContaining({ versionNo: base.versionNo, setBy: null }) });
    expect((await repository.version(base.versionNo))?.publishedAt).not.toBeNull();

    // следующий выкат: текущая — из кода, значит идёт за кодом
    const next = await importSnapshot(SNAPSHOT, randomHash());
    expect(await adoptRepoVersion(publishRepository, next.versionNo, new Date())).toEqual({ adopted: ["all"] });
    expect((await ctx.pointers()).all?.versionNo).toBe(next.versionNo);
    // повтор того же выката — ничего не меняет
    expect(await adoptRepoVersion(publishRepository, next.versionNo, new Date())).toEqual({ adopted: [] });

    // публикация из панели: дальше код указатель не двигает
    const { draftId } = await ctx.draftOf(next.versionNo, { hp: 71, check: {} });
    const panel = (await ctx.publish(draftId, "all")).data?.versionNo ?? 0;
    const newer = await importSnapshot(SNAPSHOT, randomHash());
    expect(await adoptRepoVersion(publishRepository, newer.versionNo, new Date())).toEqual({ adopted: [] });
    expect(await ctx.pointers()).toMatchObject({ team: { versionNo: panel }, all: { versionNo: panel } });
    // версия заведена и ждёт в истории, но «опубликованной» не считается: откатиться на неё нельзя
    expect((await repository.version(newer.versionNo))?.publishedAt).toBeNull();
    expect((await ctx.rollback("all", newer.versionNo)).status).toBe(409);
  });

  it("«Команде» из панели, «Всем» из кода: указатель команды панель держит, указатель «всем» идёт за кодом", async () => {
    const base = await importSnapshot();
    const ctx = await start();
    await adoptRepoVersion(publishRepository, base.versionNo, new Date());
    const { draftId } = await ctx.draftOf(base.versionNo, { hp: 72, check: {} });
    const panel = (await ctx.publish(draftId, "team")).data?.versionNo ?? 0;
    const next = await importSnapshot(SNAPSHOT, randomHash());
    expect(await adoptRepoVersion(publishRepository, next.versionNo, new Date())).toEqual({ adopted: ["all"] });
    expect(await ctx.pointers()).toMatchObject({ team: { versionNo: panel }, all: { versionNo: next.versionNo } });
  });

  it("«Взять из кода»: новые id и поля добавляются, значения существующих не меняются, основа переезжает на версию из кода", async () => {
    const base = await importSnapshot();
    const ctx = await start();
    const { draftId } = await ctx.draftOf(base.versionNo, { hp: 81 });
    // версия из кода: новый враг, новое поле у второго врага и другое число у первого
    const fromCode = JSON.parse(JSON.stringify(SNAPSHOT)) as Snap;
    fromCode.enemies.push({ ...JSON.parse(JSON.stringify(ENEMY)), id: "new_enemy_from_code" });
    fromCode.enemies[1] = { ...fromCode.enemies[1]!, size: 1.2 };
    fromCode.enemies[0] = { ...fromCode.enemies[0]!, hp: 999 };
    const code = await importSnapshot(fromCode, randomHash());

    const merged = await ctx.adminCall("POST", `/drafts/${draftId}/merge-code`, { versionNo: code.versionNo });
    expect(merged.statusCode).toBe(201);
    expect(merged.json<{ data: unknown }>().data).toMatchObject({ baseVersionNo: code.versionNo, fromVersionNo: code.versionNo, changed: true });
    expect(merged.json<{ data: { added: number } }>().data.added).toBeGreaterThanOrEqual(2);

    const stored = (await repository.draft(draftId))!;
    expect(stored.baseVersionNo).toBe(code.versionNo);
    const snap = stored.snapshot as Snap;
    expect(snap.enemies.find((enemy) => enemy.id === "new_enemy_from_code")).toBeDefined();
    expect(snap.enemies.find((enemy) => enemy.id === SECOND.id)?.size).toBe(1.2);
    // значения, уже бывшие в черновике, — свои: и правка человека, и число, которое в коде другое
    expect(snap.enemies.find((enemy) => enemy.id === ENEMY.id)?.hp).toBe(81);
    expect(snap.enemies.find((enemy) => enemy.id === SECOND.id)?.hp).toBe(SECOND.hp);

    // основа — версия из кода: разница показывает только то, что отличается от неё, и правки дальше принимаются
    const diff = await ctx.adminCall("GET", `/drafts/${draftId}/diff`);
    expect(diff.json<{ data: { baseVersionNo: number; changes: { path: string }[] } }>().data.baseVersionNo).toBe(code.versionNo);
    expect((await ctx.adminCall("PATCH", `/drafts/${draftId}`, { path: HP_PATH, value: 82 })).statusCode).toBe(200);

    // повтор — нечего добавлять
    const again = await ctx.adminCall("POST", `/drafts/${draftId}/merge-code`, { versionNo: code.versionNo });
    expect(again.json<{ data: unknown }>().data).toMatchObject({ added: 0, changed: false });
    expect(ctx.roles.entries.some((entry) => entry.action === "content.draft.merge-code")).toBe(true);

    // без номера берётся последняя версия из кода; панельная версия «из кода» не годится
    const panel = await ctx.draftOf(code.versionNo, { hp: 83, check: {} });
    const published = (await ctx.publish(panel.draftId, "team")).data?.versionNo ?? 0;
    expect((await ctx.adminCall("POST", `/drafts/${draftId}/merge-code`, { versionNo: published })).statusCode).toBe(409);
    expect((await ctx.adminCall("POST", `/drafts/${draftId}/merge-code`, { versionNo: 2_000_000_000 })).statusCode).toBe(404);
  });

  it("предпросмотр публикации: готовность с причиной и правки против версии, которая в игре у аудитории", async () => {
    const base = await importSnapshot();
    const ctx = await start();
    await adoptRepoVersion(publishRepository, base.versionNo, new Date());
    const { draftId, checked } = await ctx.draftOf(base.versionNo, { hp: 91 });

    const notReady = await ctx.adminCall("GET", `/drafts/${draftId}/publication?audience=all`);
    expect(notReady.statusCode).toBe(200);
    expect(notReady.json<{ data: unknown }>().data).toMatchObject({ audience: "all", liveVersionNo: base.versionNo, ready: false, alreadyLive: false, onTeam: false, truncated: false });
    expect(notReady.json<{ data: { reason: string } }>().data.reason).toContain("Проверить");
    expect(notReady.json<{ data: { changes: unknown[] } }>().data.changes).toEqual([{ path: HP_PATH, from: ENEMY.hp, to: 91 }]);

    await checked();
    const ready = await ctx.adminCall("GET", `/drafts/${draftId}/publication?audience=all`);
    expect(ready.json<{ data: unknown }>().data).toMatchObject({ ready: true, reason: null });

    await ctx.publish(draftId, "team");
    const afterTeam = await ctx.adminCall("GET", `/drafts/${draftId}/publication?audience=all`);
    expect(afterTeam.json<{ data: unknown }>().data).toMatchObject({ onTeam: true, alreadyLive: false });
    await ctx.publish(draftId, "all");
    const afterAll = await ctx.adminCall("GET", `/drafts/${draftId}/publication?audience=all`);
    expect(afterAll.json<{ data: unknown }>().data).toMatchObject({ onTeam: true, alreadyLive: true, changes: [] });
    expect((await ctx.adminCall("GET", `/drafts/${draftId}/publication?audience=everyone`)).statusCode).toBe(400);
    expect((await ctx.adminCall("GET", `/drafts/${draftId}/publication`)).statusCode).toBe(400);
  });

  it("ключ content.publish-require-check = false обходит проверку; обход виден в аудите, умолчание — проверка нужна", async () => {
    expect(SETTINGS.contentPublishRequireCheck.key).toBe("content.publish-require-check");
    expect(SETTINGS.contentPublishRequireCheck.fallback).toBe(true);
    const base = await importSnapshot();
    const ctx = await start();
    const { draftId } = await ctx.draftOf(base.versionNo, { hp: 101 });
    expect((await ctx.publish(draftId, "team")).status).toBe(409);

    // панель по ключу знает, нужны ли зелёные рельсы
    expect((await ctx.adminCall("GET", "/current")).json<{ data: { requireCheck: boolean } }>().data.requireCheck).toBe(true);
    ctx.settings.overrides.set(SETTINGS.contentPublishRequireCheck.key, false);
    expect((await ctx.adminCall("GET", "/current")).json<{ data: { requireCheck: boolean } }>().data.requireCheck).toBe(false);
    const forced = await ctx.publish(draftId, "team");
    expect(forced.status).toBe(201);
    expect(ctx.roles.entries.find((entry) => entry.action === "content.publish")).toMatchObject({ after: expect.objectContaining({ checkBypassed: true, audience: "team" }) });
    const preview = await ctx.adminCall("GET", `/drafts/${draftId}/publication?audience=all`);
    expect(preview.json<{ data: unknown }>().data).toMatchObject({ ready: true });
  });

  it("права: публиковать и откатывать может content.publish; читать указатели — content.view; без права — 403", async () => {
    const base = await importSnapshot();
    const ctx = await start();
    await adoptRepoVersion(publishRepository, base.versionNo, new Date());
    const { draftId } = await ctx.draftOf(base.versionNo, { hp: 111, check: {} });
    const analyst = await (await ctx.player("9331", "analyst")).panelHeaders();
    const moderator = await (await ctx.player("9332", "moderator")).panelHeaders();
    const designer = await (await ctx.player("9333", "game_designer")).panelHeaders();

    expect((await ctx.publish(draftId, "team", analyst)).status).toBe(403);
    expect((await ctx.rollback("all", base.versionNo, analyst)).status).toBe(403);
    expect((await ctx.adminCall("GET", "/current", undefined, analyst)).statusCode).toBe(200);
    expect((await ctx.adminCall("GET", `/drafts/${draftId}/publication?audience=team`, undefined, analyst)).statusCode).toBe(200);
    expect((await ctx.adminCall("POST", `/drafts/${draftId}/merge-code`, {}, analyst)).statusCode).toBe(403);
    expect((await ctx.adminCall("GET", "/current", undefined, moderator)).statusCode).toBe(403);
    expect((await ctx.publish(draftId, "team", moderator)).status).toBe(403);

    const allowed = await ctx.publish(draftId, "team", designer);
    expect(allowed.status).toBe(201);
    expect(await ctx.pointers()).toMatchObject({ team: { versionNo: allowed.data?.versionNo } });
    // без заголовка панели изменяющий запрос не принимается и у владельца
    const noCsrf = await app!.inject({ method: "POST", url: `${ADMIN}/rollback`, headers: { cookie: ctx.owner.cookie }, payload: { audience: "all", versionNo: base.versionNo } });
    expect(noCsrf.statusCode).toBe(403);
  });

  it("тело запроса: аудитория из списка, номер целый — иначе 400; публикация архивного и чужого черновика — отказ", async () => {
    const base = await importSnapshot();
    const ctx = await start();
    const { draftId } = await ctx.draftOf(base.versionNo, { hp: 121, check: {} });
    for (const payload of [{}, { audience: "everyone" }, { audience: "ALL" }, { audience: 1 }]) {
      expect((await ctx.adminCall("POST", `/drafts/${draftId}/publish`, payload as Record<string, unknown>)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    for (const payload of [{ audience: "all" }, { audience: "all", versionNo: "x" }, { audience: "all", versionNo: 0 }, { audience: "all", versionNo: 1.5 }]) {
      expect((await ctx.adminCall("POST", "/rollback", payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await ctx.adminCall("POST", "/drafts/не-uuid/publish", { audience: "all" })).statusCode).toBe(400);
    expect((await ctx.publish(randomUUID(), "all")).status).toBe(404);
    await ctx.adminCall("POST", `/drafts/${draftId}/archive`);
    expect((await ctx.publish(draftId, "all")).status).toBe(409);
  });

  it("аудит публикации: аудитория, версия, хэш и предыдущая версия; указатель знает автора", async () => {
    const base = await importSnapshot();
    const ctx = await start();
    await adoptRepoVersion(publishRepository, base.versionNo, new Date());
    const { draftId } = await ctx.draftOf(base.versionNo, { hp: 131, check: {} });
    const result = await ctx.publish(draftId, "all");
    const entry = ctx.roles.entries.find((row) => row.action === "content.publish");
    expect(entry).toMatchObject({
      target: draftId,
      after: { audience: "all", versionNo: result.data?.versionNo, contentHash: result.data?.contentHash, previousVersionNo: base.versionNo, created: true },
    });
    const pointer = await prisma.contentCurrent.findUnique({ where: { audience: "all" } });
    expect(pointer?.setBy).toBe(entry?.actorAccountId);
  });

  it("база держит указатель: аудитория из списка, версия существует и не удаляется, пока на неё есть указатель", async () => {
    const base = await importSnapshot();
    await expect(prisma.$executeRaw`INSERT INTO content_current (audience, version_no, set_at) VALUES ('any', ${base.versionNo}, now())`).rejects.toThrow(/content_current_audience/);
    await expect(prisma.$executeRaw`INSERT INTO content_current (audience, version_no, set_at) VALUES ('all', 2000000000, now())`).rejects.toThrow();
    await prisma.contentCurrent.create({ data: { audience: "all", versionNo: base.versionNo, setAt: new Date() } });
    await expect(prisma.contentVersion.delete({ where: { versionNo: base.versionNo } })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Настоящий замок на Redis
// ---------------------------------------------------------------------------

describe.skipIf(REDIS_URL === "")("замок публикации на живом Redis", () => {
  const clients: Redis[] = [];
  afterAll(async () => {
    for (const client of clients) await client.quit();
  });
  const lockOn = async () => {
    const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    clients.push(client);
    await client.del("content:publish:lock");
    return new RedisContentPublishLock(client);
  };

  it("берёт один держатель, чужой токен замок не снимает, свой — снимает", async () => {
    const lock = await lockOn();
    expect(await lock.acquire("a", 30_000)).toBe(true);
    expect(await lock.acquire("b", 30_000)).toBe(false);
    await lock.release("b");
    expect(await lock.acquire("b", 30_000)).toBe(false);
    await lock.release("a");
    expect(await lock.acquire("b", 30_000)).toBe(true);
    await lock.release("b");
  });

  it("замок живёт ограниченно: умершая реплика не держит публикацию вечно", async () => {
    const lock = await lockOn();
    expect(await lock.acquire("a", 200)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await lock.acquire("b", 30_000)).toBe(true);
    await lock.release("b");
  });
});
