import { Logger, Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createHttpApp } from "../src/http-app.js";
import { createPrisma } from "../src/infra/database.js";
import { REDIS, closeRedis, createRedis } from "../src/infra/redis.js";
import { PrismaAchievementsRepository } from "../src/modules/achievements/achievements.repository.js";
import { AchievementsService } from "../src/modules/achievements/achievements.service.js";
import { PrismaEmblemsRepository } from "../src/modules/achievements/emblems.repository.js";
import { EmblemsService } from "../src/modules/achievements/emblems.service.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { PrismaFriendsRepository } from "../src/modules/friends/friends.repository.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PrismaProgressRepository } from "../src/modules/progress/progress.repository.js";
import { ProgressService } from "../src/modules/progress/progress.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import { SECRETS_CODEX_KINDS, SECRETS_CODEX_REWARD_TASK_ID, type SecretKind } from "../src/modules/secrets-codex/secrets-codex-rules.js";
import { SecretsCodexController } from "../src/modules/secrets-codex/secrets-codex.controller.js";
import { PrismaSecretsCodexRepository } from "../src/modules/secrets-codex/secrets-codex.repository.js";
import { SecretsCodexService } from "../src/modules/secrets-codex/secrets-codex.service.js";
import { PrismaTasksRepository } from "../src/modules/tasks/tasks.repository.js";
import { TasksService } from "../src/modules/tasks/tasks.service.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Кодекс тайников на живых Postgres и Redis (tasks/T-0261,
 * docs/17-testing-strategy.md §4.2; адреса — TEST_DATABASE_URL и
 * PLAYTEST_TEST_REDIS_URL, без них пропуск). Достижение «Следопыт» — из
 * миграции. Redis — своя база (сдвиг 14), без `flushdb`: её делят другие файлы.
 *
 * Память этого не покажет: «найдено однажды» держит первичный ключ и
 * `ON CONFLICT DO NOTHING`, а повтор забега и два забега разом — именно то, что
 * ключ обязан выдержать.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 14);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

/** среда, 21.10.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 9, 21, 9));
const LATER = new Date(NOON.getTime() + 3_600_000);
const STAMP = String(Date.now());

describe.skipIf(!live)("кодекс тайников на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let accounts: PrismaAccountRepository;
  let tasks: TasksService;
  let wallet: WalletService;
  let hooks: RunsHooks;
  let codex: SecretsCodexService;
  let emblems: EmblemsService;
  let achievements: AchievementsService;

  async function player(): Promise<AccountRef> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(980_000_000 + Math.floor(Math.random() * 15_000_000)), displayName: "Следопыт", username: null },
      Date.now(),
    );
    return { accountId: created.accountId, platform: "telegram", platformUserId: "1" };
  }

  let runNo = 0;
  function recorded(accountId: string, secretsFound: SecretKind[], patch: Partial<RecordedRun> = {}): RecordedRun {
    return {
      runId: `secrets-codex-it-${STAMP}-${String(runNo++)}`,
      accountId,
      difficulty: "hard",
      outcome: "died",
      survivalSec: 400,
      level: 22,
      enemiesKilled: 400,
      startingWeaponId: "spark",
      weapons: [{ id: "spark", level: 3 }],
      boosts: [],
      xpCollected: 600,
      counters: null,
      secretsFound,
      deathCause: null,
      cheats: false,
      continues: 0,
      ranked: true,
      verdict: "ok",
      reasons: [],
      finishedAt: NOON,
      ...patch,
    };
  }

  const rowsOf = async (accountId: string) =>
    await prisma.$queryRaw<{ kind: string; first_at: Date }[]>`SELECT kind, first_at FROM secret_found WHERE account_id = ${accountId}::uuid ORDER BY kind`;

  async function taskRow(accountId: string, taskId: string): Promise<{ value: number; done: boolean } | undefined> {
    const rows = await prisma.$queryRaw<{ value: number; done: boolean }[]>`
      SELECT value::int AS value, (completed_at IS NOT NULL) AS done FROM task_progress WHERE account_id = ${accountId}::uuid AND task_id = ${taskId}`;
    return rows[0];
  }

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    redis = createRedis(config);
    await redis.connect();
    accounts = new PrismaAccountRepository(prisma);
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    const unused = {} as never;
    hooks = new RunsHooks();
    tasks = new TasksService(new PrismaTasksRepository(prisma), wallet, hooks, unused, unused, unused, unused);
    codex = new SecretsCodexService(new PrismaSecretsCodexRepository(prisma), tasks, hooks);
    const achievementsRepository = new PrismaAchievementsRepository(prisma);
    emblems = new EmblemsService(tasks, new PrismaEmblemsRepository(prisma), achievementsRepository, panelSettings());
    const friends = new PrismaFriendsRepository(prisma);
    achievements = new AchievementsService(
      tasks,
      achievementsRepository,
      { friendCount: (accountId) => friends.count(accountId) },
      new ProgressService(new PrismaProgressRepository(prisma)),
      panelSettings(),
      emblems,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  beforeEach(() => {
    // Строки лога модуля в вывод тестов не попадают.
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("запись по итогу забега", () => {
    it("забег с найденными капищем и кладом — два вида в кодексе", async () => {
      const me = await player();
      await codex.onRun(recorded(me.accountId, ["shrine", "hoard"]));
      expect((await rowsOf(me.accountId)).map((row) => row.kind)).toEqual(["hoard", "shrine"]);
      expect((await codex.view(me.accountId)).found).toEqual(["shrine", "hoard"]);
    });

    it("тот же забег, записанный повторно, и два забега разом дублей не дают, first_at остаётся прежним", async () => {
      const me = await player();
      const run = recorded(me.accountId, ["shrine", "hoard"]);
      await codex.onRun(run);
      const before = await rowsOf(me.accountId);
      await codex.onRun({ ...run, finishedAt: LATER });
      await Promise.all([codex.onRun(run), codex.onRun(run)]);
      expect(await rowsOf(me.accountId)).toEqual(before);
    });

    it("второй забег добавляет только новый вид со своим временем", async () => {
      const me = await player();
      await codex.onRun(recorded(me.accountId, ["shrine"]));
      await codex.onRun(recorded(me.accountId, ["shrine", "tree"], { finishedAt: LATER }));
      const rows = await rowsOf(me.accountId);
      expect(rows.map((row) => row.kind)).toEqual(["shrine", "tree"]);
      expect(rows.find((row) => row.kind === "shrine")?.first_at).toEqual(NOON);
      expect(rows.find((row) => row.kind === "tree")?.first_at).toEqual(LATER);
    });

    it("забег с читом, отклонённый разбором и пролог кодекс не пишут", async () => {
      const me = await player();
      await codex.onRun(recorded(me.accountId, ["shrine"], { cheats: true }));
      await codex.onRun(recorded(me.accountId, ["shrine"], { verdict: "rejected" }));
      await codex.onRun(recorded(me.accountId, ["shrine"], { mode: "prologue" }));
      expect(await rowsOf(me.accountId)).toEqual([]);
      expect(await taskRow(me.accountId, SECRETS_CODEX_REWARD_TASK_ID)).toBeUndefined();
    });

    it("вид не из списка не пишется", async () => {
      const me = await player();
      await codex.onRun(recorded(me.accountId, ["ghost", "'; DROP TABLE secret_found; --", "wisp"] as unknown as SecretKind[]));
      expect((await rowsOf(me.accountId)).map((row) => row.kind)).toEqual(["wisp"]);
    });

    it("сбой хранилища слушатель не пробрасывает: забег он не ломает", async () => {
      const broken = new SecretsCodexService(
        {
          found: async () => {
            throw new Error("база недоступна");
          },
          record: async () => [],
        },
        tasks,
        new RunsHooks(),
      );
      const me = await player();
      await expect(broken.onRun(recorded(me.accountId, ["shrine"]))).resolves.toBeUndefined();
    });

    it("слушатель подписан на запись забега: событие хуков открывает виды", async () => {
      const own = new RunsHooks();
      const service = new SecretsCodexService(new PrismaSecretsCodexRepository(prisma), tasks, own);
      service.onModuleInit();
      const me = await player();
      await own.emit(recorded(me.accountId, ["shrine", "stone"]));
      expect(await rowsOf(me.accountId)).toHaveLength(2);
    });
  });

  describe("достижение «Следопыт»", () => {
    it("строка каталога из миграции: цель 6, престиж 40, коллекция, знак «эпический», награда монетами", async () => {
      const rows = await prisma.$queryRaw<
        { task_id: string; title: string; kind: string; target: number; prestige: number; coins: number; gems: number; shards: number; category: string; emblem_tier: string; active: boolean; hidden: boolean; period: string }[]
      >`SELECT task_id, title, kind, target, prestige, coins, gems, shards, category, emblem_tier, active, hidden, period::text AS period FROM task_def WHERE kind = 'secrets_kinds'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        task_id: SECRETS_CODEX_REWARD_TASK_ID,
        title: "Следопыт",
        kind: "secrets_kinds",
        target: 6,
        prestige: 40,
        gems: 0,
        shards: 0,
        category: "collection",
        emblem_tier: "epic",
        active: true,
        hidden: false,
        period: "achievement",
      });
      expect(rows[0]?.coins).toBeGreaterThan(0);
    });

    it("четыре вида из шести — прогресс четыре, не выполнено", async () => {
      const me = await player();
      await codex.onRun(recorded(me.accountId, ["shrine", "hoard", "tree", "rift"]));
      expect(await taskRow(me.accountId, SECRETS_CODEX_REWARD_TASK_ID)).toEqual({ value: 4, done: false });
    });

    it("витрина достижений не затирает прогресс уровнем аккаунта", async () => {
      const me = await player();
      await codex.onRun(recorded(me.accountId, ["shrine", "hoard"]));
      await prisma.$executeRaw`INSERT INTO account_progress (account_id, xp, level, updated_at) VALUES (${me.accountId}::uuid, 0, 12, now())`;
      await achievements.view(me, NOON);
      expect((await taskRow(me.accountId, SECRETS_CODEX_REWARD_TASK_ID))?.value).toBe(2);
    });

    it("все шесть видов за несколько забегов — достижение выполнено, знак держится и носится", async () => {
      const me = await player();
      await codex.onRun(recorded(me.accountId, ["shrine", "hoard", "tree"]));
      await codex.onRun(recorded(me.accountId, ["tree", "rift", "stone", "wisp"], { finishedAt: LATER }));
      expect(await taskRow(me.accountId, SECRETS_CODEX_REWARD_TASK_ID)).toEqual({ value: 6, done: true });
      const view = await emblems.listFor(me.accountId, LATER);
      const item = view.items.find((candidate) => candidate.id === SECRETS_CODEX_REWARD_TASK_ID);
      expect(item).toMatchObject({ held: true, title: "Следопыт", tier: "epic" });
      expect(await emblems.choose(me.accountId, SECRETS_CODEX_REWARD_TASK_ID, LATER)).toEqual({ shown: SECRETS_CODEX_REWARD_TASK_ID, auto: false });
    });

    it("награда забирается один раз, повтор ничего не начисляет", async () => {
      const me = await player();
      await codex.onRun(recorded(me.accountId, [...SECRETS_CODEX_KINDS]));
      const before = (await wallet.balances(me.accountId)).coins;
      const first = await tasks.claim(me, SECRETS_CODEX_REWARD_TASK_ID, NOON);
      expect(first.claimed).toBe(true);
      const second = await tasks.claim(me, SECRETS_CODEX_REWARD_TASK_ID, NOON);
      expect(second.claimed).toBe(false);
      expect((await wallet.balances(me.accountId)).coins).toBe(before + first.credited.coins);
    });
  });

  describe("ответ кодекса", () => {
    it("у нового аккаунта ничего не найдено", async () => {
      const me = await player();
      expect(await codex.view(me.accountId)).toEqual({ found: [] });
    });

    it("виды отдаются в каноническом порядке, а запись о неизвестном виде из базы не попадает в ответ", async () => {
      const me = await player();
      await prisma.$executeRaw`INSERT INTO secret_found (account_id, kind, first_at) VALUES (${me.accountId}::uuid, 'wisp', ${NOON}), (${me.accountId}::uuid, 'shrine', ${NOON}), (${me.accountId}::uuid, 'old_kind', ${NOON})`;
      expect(await codex.view(me.accountId)).toEqual({ found: ["shrine", "wisp"] });
    });
  });

  describe("аккаунт", () => {
    it("записи уходят вместе с аккаунтом (ON DELETE CASCADE)", async () => {
      const me = await player();
      await codex.onRun(recorded(me.accountId, ["shrine", "hoard"]));
      expect(await rowsOf(me.accountId)).toHaveLength(2);
      await prisma.$executeRaw`DELETE FROM account WHERE account_id = ${me.accountId}::uuid`;
      expect(await rowsOf(me.accountId)).toEqual([]);
    });

    it("база не принимает запись чужого аккаунта и повтор пары", async () => {
      const me = await player();
      await expect(prisma.$executeRaw`INSERT INTO secret_found (account_id, kind, first_at) VALUES (${"00000000-0000-4000-8000-000000000000"}::uuid, 'shrine', now())`).rejects.toThrow();
      await prisma.$executeRaw`INSERT INTO secret_found (account_id, kind, first_at) VALUES (${me.accountId}::uuid, 'shrine', now())`;
      await expect(prisma.$executeRaw`INSERT INTO secret_found (account_id, kind, first_at) VALUES (${me.accountId}::uuid, 'shrine', now())`).rejects.toThrow();
    });
  });

  describe("миграция только добавляет", () => {
    it("таблица secret_found с первичным ключом (аккаунт, вид), прежние достижения на месте", async () => {
      const columns = await prisma.$queryRaw<{ column_name: string; is_nullable: string }[]>`
        SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'secret_found' ORDER BY column_name`;
      expect(columns.map((column) => column.column_name)).toEqual(["account_id", "first_at", "kind"]);
      expect(columns.every((column) => column.is_nullable === "NO")).toBe(true);
      const keys = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT a.attname AS column_name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'secret_found'::regclass AND i.indisprimary ORDER BY a.attname`;
      expect(keys.map((key) => key.column_name)).toEqual(["account_id", "kind"]);
      const [kept] = await prisma.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM task_def WHERE task_id IN ('ach_survive_1', 'ach_friends_25', 'ach_kills_100')`;
      expect(kept?.count).toBe(3);
    });
  });

  describe("по HTTP", () => {
    let app: NestFastifyApplication | null = null;

    afterEach(async () => {
      await app?.close();
      app = null;
    });

    it("без токена — 401; с токеном ответ по форме из задачи, чужие записи не видны", async () => {
      @Module({
        controllers: [SecretsCodexController],
        providers: [{ provide: APP_CONFIG, useValue: config }, { provide: REDIS, useValue: redis }, { provide: SecretsCodexService, useValue: codex }, RateLimiter, AuthGuard],
      })
      class TestModule {}
      app = await createHttpApp(TestModule, { logger: false });
      await app.init();
      await app.getHttpAdapter().getInstance().ready();

      const me = await player();
      const other = await player();
      await codex.onRun(recorded(me.accountId, ["shrine", "hoard"]));
      await codex.onRun(recorded(other.accountId, ["wisp"]));
      const token = await signAccessToken({ accountId: me.accountId, platform: "telegram", platformUserId: me.platformUserId }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());

      expect((await app.inject({ method: "GET", url: "/api/v1/codex/secrets" })).statusCode).toBe(401);
      const response = await app.inject({ method: "GET", url: "/api/v1/codex/secrets", headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { found: ["shrine", "hoard"] } });
    });
  });
});
