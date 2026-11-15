import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createHttpApp } from "../src/http-app.js";
import { createPrisma } from "../src/infra/database.js";
import { REDIS, closeRedis, createRedis } from "../src/infra/redis.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminRunReviewController } from "../src/modules/admin/admin-run-review.controller.js";
import { AdminRunsController } from "../src/modules/admin/admin-runs.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { ACCOUNT_REPOSITORY, PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { RestrictionsHooks } from "../src/modules/restrictions/restrictions-hooks.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { PrismaRolesRepository, ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { ALL_BOARDS, RedisLeaderboardStore } from "../src/modules/runs/leaderboard.store.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { RunExtras } from "../src/modules/runs/run-details.js";
import { RunLoadouts } from "../src/modules/runs/run-loadouts.js";
import { RunPrestige } from "../src/modules/runs/run-prestige.js";
import { PrismaRunReviewRepository } from "../src/modules/runs/run-review.repository.js";
import { RunReviewService } from "../src/modules/runs/run-review.service.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { RunsViewService } from "../src/modules/runs/runs-view.service.js";
import { PrismaRunsRepository, type RunFinishRecord } from "../src/modules/runs/runs.repository.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { RedisSeasonBoardStore } from "../src/modules/seasons/season-board.store.js";
import { seasonOf, type Season } from "../src/modules/seasons/season-rules.js";
import { SeasonSchedule } from "../src/modules/seasons/seasons-schedule.js";
import { SeasonsProjection } from "../src/modules/seasons/seasons-projection.js";
import { PrismaSeasonsRepository } from "../src/modules/seasons/seasons.repository.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { ratingRestrictions, secondsScore } from "./helpers/memory-runs.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { panelSettings } from "./helpers/settings.js";
import { uniquePlatformUserId } from "./helpers/player-ids.js";

/**
 * Решения разбора забегов на настоящих Postgres и Redis (Р203, tasks/T-0419).
 * Адреса — TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL; без них файл пропускается.
 *
 * Память не покажет главного: условное обновление `review_outcome` в Postgres
 * (два одновременных решения дают одну запись журнала), расширенное условие
 * `UNRANKED_BY_MODERATOR` в настоящем запросе Prisma и то, что доска и таблица
 * недели пересчитываются по базе, а награды и закрытые сезоны остаются как были.
 *
 * Забеги пишутся прямо в базу: очки, вердикт и ранг задаёт тест. «Сейчас» —
 * настоящее время: недельную таблицу `SeasonsProjection.refresh` считает по нему.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 5);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe.skipIf(!live)("разбор забегов на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let accounts: PrismaAccountRepository;
  let rolesRepository: PrismaRolesRepository;
  let runs: PrismaRunsRepository;
  let reviews: PrismaRunReviewRepository;
  let board: RedisLeaderboardStore;
  let seasonStore: RedisSeasonBoardStore;
  let service: RunsService;
  let view: RunsViewService;
  let schedule: SeasonSchedule;
  let app: NestFastifyApplication;
  let moderator: AccountRef;

  async function player(name = "Игрок"): Promise<string> {
    const created = await accounts.upsert({ platform: "telegram", platformUserId: uniquePlatformUserId(), displayName: name, username: null, photoUrl: null }, Date.now());
    return created.accountId;
  }

  /** Забег прямо в базе; по умолчанию — подозрительный, рейтинговой сложности, без читов, не в рейтинге, закончен только что. */
  function record(accountId: string, patch: Partial<RunFinishRecord> = {}): RunFinishRecord {
    const points = patch.score?.points ?? 600;
    return {
      runId: randomUUID(),
      accountId,
      difficulty: "hard",
      startingWeaponId: "knife",
      contentHash: "abc",
      finishedAt: new Date(Date.now() - 60_000),
      outcome: "died",
      survivalSec: points,
      level: 6,
      enemiesKilled: 300,
      weapons: [{ id: "knife", level: 2 }],
      details: null,
      deathCause: null,
      cheats: false,
      continues: [],
      ranked: false,
      ratingRestricted: null,
      verdict: "suspicious",
      verdictReasons: ["kill_rate"],
      rubezhReached: false,
      rubezhClearedSec: null,
      score: secondsScore(points),
      ...patch,
    };
  }

  async function save(row: RunFinishRecord): Promise<RunFinishRecord> {
    expect(await runs.finish(row)).toBe("finished");
    return row;
  }

  /** Честный рейтинговый забег: в базе рейтинговый, на доске и в таблице недели — как после приёма итога. */
  async function saveRanked(accountId: string, points: number, finishedAt = new Date(Date.now() - 30_000)): Promise<RunFinishRecord> {
    const row = await save(record(accountId, { ranked: true, verdict: "ok", verdictReasons: [], score: secondsScore(points), finishedAt }));
    await board.submit("hard", accountId, points, ALL_BOARDS);
    const season = schedule.current(finishedAt);
    if (season !== null) await seasonStore.submit(schedule.boardSeason(season), "hard", accountId, points, ALL_BOARDS);
    return row;
  }

  async function post(runId: string, action: string, payload: Record<string, unknown> = {}) {
    return await app.inject({ method: "POST", url: `/api/v1/admin/runs/${runId}/${action}`, headers: { cookie: `${ADMIN_SESSION_COOKIE}=mod`, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE }, payload });
  }

  async function audit(action: string, accountId: string) {
    return await prisma.auditEntry.findMany({ where: { action, target: accountId } });
  }

  async function stored(runId: string) {
    return await prisma.run.findUniqueOrThrow({ where: { runId }, select: { ranked: true, reviewOutcome: true, reviewedAt: true, reviewedBy: true } });
  }

  async function inQueue(runId: string): Promise<boolean> {
    return (await runs.review(10_000)).some((row) => row.runId === runId);
  }

  /** Недельная таблица текущего сезона — тот же ключ, что у проекции. */
  function currentBoardKey(): string {
    const season = schedule.current(new Date());
    if (season === null) throw new Error("сезоны не идут");
    return schedule.boardSeason(season).key;
  }

  /** Закрытый сезон с итогом, наградой и кошельком игрока: то, что решения разбора менять не вправе. */
  async function closedSeasonOf(accountId: string): Promise<Season> {
    for (;;) {
      const season = seasonOf(new Date(Date.UTC(2000, 0, 3) + Math.floor(Math.random() * 1_000) * 7 * DAY));
      if ((await prisma.season.count({ where: { seasonKey: season.key } })) > 0) continue;
      await prisma.season.create({ data: { seasonKey: season.key, startsAt: season.startsAt, endsAt: season.endsAt, closedAt: season.endsAt, players: 1, rewarded: 1 } });
      await prisma.seasonResult.create({ data: { seasonKey: season.key, accountId, difficulty: "hard", bestSec: 700, place: 1, boardSize: 1, board: "common", division: "gold" } });
      await prisma.seasonReward.create({ data: { seasonKey: season.key, accountId, coins: 500, prestige: 3, difficulty: "hard", place: 1, kind: "place", status: "pending" } });
      await prisma.walletBalance.upsert({ where: { accountId_resource: { accountId, resource: "coins" } }, create: { accountId, resource: "coins", balance: 1_234n, updatedAt: new Date() }, update: { balance: 1_234n } });
      return season;
    }
  }

  /** Всё, что решения разбора менять не вправе: итоги и награды закрытых сезонов и кошелёк игрока. */
  async function untouched(accountId: string) {
    const [results, rewards, balances, entries] = await Promise.all([
      prisma.seasonResult.findMany({ where: { accountId }, orderBy: { seasonKey: "asc" } }),
      prisma.seasonReward.findMany({ where: { accountId }, orderBy: { seasonKey: "asc" } }),
      prisma.walletBalance.findMany({ where: { accountId }, orderBy: { resource: "asc" } }),
      prisma.walletEntry.count({ where: { accountId } }),
    ]);
    return { results, rewards, balances: balances.map((row) => [row.resource, row.balance.toString()]), entries };
  }

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    redis = createRedis(config);
    await redis.connect();
    accounts = new PrismaAccountRepository(prisma);
    rolesRepository = new PrismaRolesRepository(prisma);
    runs = new PrismaRunsRepository(prisma);
    reviews = new PrismaRunReviewRepository(prisma);
    board = new RedisLeaderboardStore(redis);
    seasonStore = new RedisSeasonBoardStore(redis);

    // Сезоны идут с понедельника трёхнедельной давности, по очкам; рейтинг считает забеги с 2020 года.
    const start = seasonOf(new Date(Date.now() - 21 * DAY)).startsAt;
    const settings = panelSettings({
      [SETTINGS.seasonsStartDate.key]: Number(start.toISOString().slice(0, 10).replaceAll("-", "")),
      [SETTINGS.ratingPointsFrom.key]: Number(start.toISOString().slice(0, 10).replaceAll("-", "")),
      [SETTINGS.ratingSinceDate.key]: 20200101,
    });
    schedule = new SeasonSchedule(settings);
    const hooks = new RunsHooks();
    const rating = ratingRestrictions(runs, board, undefined, settings);
    const roles = new RolesService(config, rolesRepository, accounts);
    service = new RunsService(config, runs, board, roles, hooks, new RunContinues(), new RunLoadouts(), rating.rating);
    new SeasonsProjection(schedule, seasonStore, new PrismaSeasonsRepository(prisma), hooks, new RestrictionsHooks(), rating.gate, rating.rating, { set: async () => "OK", eval: async () => 1 } as never).onModuleInit();
    view = new RunsViewService(runs, board, new RunExtras(), rating.rating, new RunPrestige());
    const review = new RunReviewService(reviews, service, rating.rating, roles, accounts);

    const moderatorId = await player("Модератор");
    await rolesRepository.grant(moderatorId, "moderator", null);
    moderator = { accountId: moderatorId, platform: "telegram", platformUserId: "1" };
    const store = new MemoryAdminSessionStore();
    await store.put(hashSessionToken("mod"), { ...moderator, issuedAtMs: 1, expiresAtMs: Date.now() + 3_600_000 });

    @Module({
      controllers: [AdminRunReviewController, AdminRunsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: REDIS, useValue: redis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: rolesRepository },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: RunsService, useValue: service },
        { provide: RunsViewService, useValue: view },
        { provide: RunReviewService, useValue: review },
        { provide: RolesService, useValue: roles },
        RateLimiter,
        PermissionGuard,
        AdminSessionService,
        AdminSessionGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  describe("«Честный»", () => {
    it("подозрительный годный забег: уходит из очереди, возвращается в доску, журнал — решение и возврат", async () => {
      const accountId = await player();
      const run = await save(record(accountId, { score: secondsScore(600) }));
      expect(await inQueue(run.runId)).toBe(true);
      expect(await board.best("hard", accountId, "common")).toBeNull();

      const response = await post(run.runId, "honest");

      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({ review: { outcome: "honest", reviewedBy: moderator.accountId }, rating: { ranked: true } });
      expect(await inQueue(run.runId)).toBe(false);
      const row = await stored(run.runId);
      expect(row).toMatchObject({ ranked: true, reviewOutcome: "honest", reviewedBy: moderator.accountId });
      expect(row.reviewedAt).toBeInstanceOf(Date);
      expect(await board.best("hard", accountId, "common")).toBe(600);
      expect(await audit("players.run.honest", accountId)).toHaveLength(1);
      expect(await audit("players.run.rerank", accountId)).toHaveLength(1);
    });

    it("забег с читами: из очереди уходит, в доску не возвращается, возврата в журнале нет", async () => {
      const accountId = await player();
      const run = await save(record(accountId, { cheats: true }));

      const response = await post(run.runId, "honest");

      expect(response.statusCode).toBe(200);
      expect(await inQueue(run.runId)).toBe(false);
      expect(await stored(run.runId)).toMatchObject({ ranked: false, reviewOutcome: "honest" });
      expect(await board.best("hard", accountId, "common")).toBeNull();
      expect(await audit("players.run.honest", accountId)).toHaveLength(1);
      expect(await audit("players.run.rerank", accountId)).toHaveLength(0);
    });

    it("забег прошлой недели: в доске сложности есть, в таблице текущей недели нет, закрытый сезон и кошелёк не тронуты", async () => {
      const accountId = await player();
      const lastWeek = seasonOf(new Date(Date.now() - 7 * DAY));
      const closed = await closedSeasonOf(accountId);
      const run = await save(record(accountId, { score: secondsScore(800), finishedAt: new Date(lastWeek.startsAt.getTime() + 2 * HOUR) }));
      const before = await untouched(accountId);

      const response = await post(run.runId, "honest");

      expect(response.statusCode).toBe(200);
      expect(await stored(run.runId)).toMatchObject({ ranked: true, reviewOutcome: "honest" });
      expect(await board.best("hard", accountId, "common")).toBe(800);
      expect(await seasonStore.best(currentBoardKey(), "hard", accountId, "common")).toBeNull();
      expect(await untouched(accountId)).toEqual(before);
      expect(before.results.map((result) => result.seasonKey)).toEqual([closed.key]);
    });

    it("повтор — тот же ответ без второй записи; аннулированный — 409; ok-забег — 409", async () => {
      const accountId = await player();
      const run = await save(record(accountId));

      expect((await post(run.runId, "honest")).statusCode).toBe(200);
      expect((await post(run.runId, "honest", { comment: "ещё раз" })).statusCode).toBe(200);
      expect(await audit("players.run.honest", accountId)).toHaveLength(1);
      expect(await audit("players.run.rerank", accountId)).toHaveLength(1);

      const annulled = await save(record(accountId));
      expect((await post(annulled.runId, "annul", { comment: "накрутка" })).statusCode).toBe(200);
      const refused = await post(annulled.runId, "honest");
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.message).toContain("Вернуть забег");

      const clean = await saveRanked(accountId, 300);
      expect((await post(clean.runId, "honest")).statusCode).toBe(409);
    });

    it("честный возвращённый забег: «Не учитывать…» и «Вернуть…» карточки игрока работают — условие базы его пропускает", async () => {
      const accountId = await player();
      const run = await save(record(accountId, { score: secondsScore(650) }));
      expect((await post(run.runId, "honest")).statusCode).toBe(200);
      expect(await stored(run.runId)).toMatchObject({ ranked: true });

      const unrank = await post(run.runId, "unrank", { comment: "сомнение" });
      expect(unrank.statusCode).toBeLessThan(300);
      expect(await stored(run.runId)).toMatchObject({ ranked: false, reviewOutcome: "honest" });
      expect(await board.best("hard", accountId, "common")).toBeNull();

      const rerank = await post(run.runId, "rerank", { comment: "всё же честный" });
      expect(rerank.statusCode).toBeLessThan(300);
      expect(await stored(run.runId)).toMatchObject({ ranked: true });
      expect(await board.best("hard", accountId, "common")).toBe(650);
    });

    it("забег, записанный до миграции (колонки null): отчёт читает его без решения, подозрительный — в очереди", async () => {
      const accountId = await player();
      const run = await save(record(accountId));

      const report = await reviews.report(run.runId);

      expect(report).toMatchObject({ runId: run.runId, reviewOutcome: null, reviewedAt: null, reviewedBy: null, verdict: "suspicious", verdictReasons: ["kill_rate"] });
      expect(await inQueue(run.runId)).toBe(true);
    });
  });

  describe("«Аннулировать» и «Вернуть забег»", () => {
    it("лучший рейтинговый забег: с доски и из таблицы недели уходит, место — по следующему лучшему; «Вернуть…» карточки его не принимает", async () => {
      const accountId = await player();
      const weaker = await saveRanked(accountId, 400);
      const best = await saveRanked(accountId, 900);
      expect(await board.best("hard", accountId, "common")).toBe(900);
      expect(await seasonStore.best(currentBoardKey(), "hard", accountId, "common")).toBe(900);

      const response = await post(best.runId, "annul", { comment: "накрутка" });

      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({ review: { outcome: "annulled" }, rating: { ranked: false }, actions: { restore: true } });
      expect(await stored(best.runId)).toMatchObject({ ranked: false, reviewOutcome: "annulled", reviewedBy: moderator.accountId });
      expect(await board.best("hard", accountId, "common")).toBe(400);
      expect(await seasonStore.best(currentBoardKey(), "hard", accountId, "common")).toBe(400);
      expect(await stored(weaker.runId)).toMatchObject({ ranked: true, reviewOutcome: null });
      expect(await audit("players.run.annul", accountId)).toHaveLength(1);
      expect(await audit("players.run.unrank", accountId)).toHaveLength(1);

      // «Вернуть…» из карточки игрока аннулированный не пропускает; в «Рекордах в рейтинге» его нет.
      expect((await post(best.runId, "rerank", { comment: "попытка" })).statusCode).toBe(409);
      const listed = (await view.moderationRuns(accountId)).hard.map((item) => item.runId);
      expect(listed).toContain(weaker.runId);
      expect(listed).not.toContain(best.runId);
    });

    it("единственный забег: после аннулирования игрока нет ни в доске, ни в таблице недели", async () => {
      const accountId = await player();
      const only = await saveRanked(accountId, 500);

      expect((await post(only.runId, "annul", { comment: "накрутка" })).statusCode).toBe(200);

      expect(await board.best("hard", accountId, "common")).toBeNull();
      expect(await seasonStore.best(currentBoardKey(), "hard", accountId, "common")).toBeNull();
    });

    it("«Вернуть забег»: honest, ranked, место снова по нему; в «Рекордах» он снова есть; журнал — возврат и решение", async () => {
      const accountId = await player();
      const run = await saveRanked(accountId, 900);
      await post(run.runId, "annul", { comment: "накрутка" });
      expect(await board.best("hard", accountId, "common")).toBeNull();

      const response = await post(run.runId, "restore", { comment: "проверили, честный" });

      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({ review: { outcome: "honest" }, rating: { ranked: true }, actions: { annul: true, restore: false } });
      expect(await stored(run.runId)).toMatchObject({ ranked: true, reviewOutcome: "honest", reviewedBy: moderator.accountId });
      expect(await board.best("hard", accountId, "common")).toBe(900);
      expect(await seasonStore.best(currentBoardKey(), "hard", accountId, "common")).toBe(900);
      expect((await view.moderationRuns(accountId)).hard.map((item) => item.runId)).toContain(run.runId);
      const restored = await audit("players.run.restore", accountId);
      expect(restored).toHaveLength(1);
      expect(restored[0]?.before).toEqual({ reviewOutcome: "annulled" });
      expect(await audit("players.run.rerank", accountId)).toHaveLength(1);

      // Повтор и возврат неразобранного.
      expect((await post(run.runId, "restore", { comment: "ещё раз" })).statusCode).toBe(200);
      expect(await audit("players.run.restore", accountId)).toHaveLength(1);
      const open = await save(record(accountId));
      expect((await post(open.runId, "restore", { comment: "зачем" })).statusCode).toBe(409);
    });

    it("пересборка доски после аннулирования забег не возвращает, после «Вернуть забег» — возвращает", async () => {
      const accountId = await player();
      const run = await saveRanked(accountId, 700);

      await post(run.runId, "annul", { comment: "накрутка" });
      await service.rebuildLeaderboard();
      expect(await board.best("hard", accountId, "common")).toBeNull();

      await post(run.runId, "restore", { comment: "ошиблись" });
      await service.rebuildLeaderboard();
      expect(await board.best("hard", accountId, "common")).toBe(700);
    });

    it("баланс кошелька, награды и итоги закрытого сезона до и после аннулирования и возврата совпадают", async () => {
      const accountId = await player();
      await closedSeasonOf(accountId);
      const run = await saveRanked(accountId, 800);
      const before = await untouched(accountId);

      await post(run.runId, "annul", { comment: "накрутка" });
      expect(await untouched(accountId)).toEqual(before);
      await post(run.runId, "restore", { comment: "ошиблись" });
      expect(await untouched(accountId)).toEqual(before);
    });

    it("аннулирование нерейтингового забега: решение записано, доска не тронута", async () => {
      const accountId = await player();
      const easy = await save(record(accountId, { difficulty: "easy", verdict: "ok", verdictReasons: [] }));

      const response = await post(easy.runId, "annul", { comment: "по ссылке из жалобы" });

      expect(response.statusCode).toBe(200);
      expect(await stored(easy.runId)).toMatchObject({ ranked: false, reviewOutcome: "annulled" });
      expect(await audit("players.run.unrank", accountId)).toHaveLength(0);
    });
  });

  describe("гонки: решение — одно условное обновление", () => {
    it("два параллельных «Аннулировать» одного забега: оба 200, запись решения и снятия — по одной", async () => {
      const accountId = await player();
      const run = await saveRanked(accountId, 900);

      const [first, second] = await Promise.all([post(run.runId, "annul", { comment: "раз" }), post(run.runId, "annul", { comment: "два" })]);

      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      expect(await audit("players.run.annul", accountId)).toHaveLength(1);
      expect(await audit("players.run.unrank", accountId)).toHaveLength(1);
      expect(await stored(run.runId)).toMatchObject({ ranked: false, reviewOutcome: "annulled" });
    });

    it("два параллельных «Вернуть забег»: оба 200, по одной записи возврата и решения", async () => {
      const accountId = await player();
      const run = await saveRanked(accountId, 900);
      await post(run.runId, "annul", { comment: "накрутка" });

      const [first, second] = await Promise.all([post(run.runId, "restore", { comment: "раз" }), post(run.runId, "restore", { comment: "два" })]);

      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      expect(await audit("players.run.restore", accountId)).toHaveLength(1);
      expect(await audit("players.run.rerank", accountId)).toHaveLength(1);
      expect(await stored(run.runId)).toMatchObject({ ranked: true, reviewOutcome: "honest" });
    });

    it("репозиторий: второй mark с тем же допустимым прежним состоянием проигрывает", async () => {
      const accountId = await player();
      const run = await save(record(accountId));
      const at = new Date();

      expect(await reviews.mark(run.runId, "honest", [null], moderator.accountId, at)).toBe(true);
      expect(await reviews.mark(run.runId, "honest", [null], moderator.accountId, at)).toBe(false);
      expect(await reviews.mark(run.runId, "annulled", [null, "honest"], moderator.accountId, at)).toBe(true);
      expect(await reviews.mark(run.runId, "honest", ["annulled"], moderator.accountId, at)).toBe(true);
      // Забега, которого нет, mark не трогает.
      expect(await reviews.mark(randomUUID(), "honest", [null], moderator.accountId, at)).toBe(false);
    });
  });
});
