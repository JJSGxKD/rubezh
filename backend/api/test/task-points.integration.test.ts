import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { Prisma, type PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { POINT_STEPS, type PointsView } from "../src/modules/tasks/task-points.js";
import { PrismaTaskPointsRepository } from "../src/modules/tasks/task-points.repository.js";
import { TaskPointsService } from "../src/modules/tasks/task-points.service.js";
import { rotationAt } from "../src/modules/tasks/task-pool.js";
import type { TaskDef } from "../src/modules/tasks/task-rules.js";
import { TaskPointsNotReachedError, TaskPointsStepNotFoundError } from "../src/modules/tasks/tasks-errors.js";
import { PrismaTasksRepository, type TaskDelta } from "../src/modules/tasks/tasks.repository.js";
import { TasksService } from "../src/modules/tasks/tasks.service.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { WALLET_DAILY_CAPS } from "../src/modules/wallet/wallet-limits.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Очки заданий на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск; tasks/T-0105): полоса дня и недели
 * считается из выполненного, а не забранного; недельная включает ежедневные;
 * ступень забирается однажды — и под гонкой, и под суточным потолком
 * кошелька; прошлые сутки не забираются.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
/** среда, 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));
/** вторник, 29.09.2026, 12:00 по Москве — та же неделя, прошлые сутки */
const TUESDAY = new Date(NOON.getTime() - 24 * 3_600_000);
/** понедельник, 05.10.2026, 12:00 по Москве — следующая неделя */
const NEXT_WEEK = new Date(NOON.getTime() + 5 * 24 * 3_600_000);

describe.skipIf(DATABASE_URL === "")("очки заданий на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let tasks: PrismaTasksRepository;
  let wallet: WalletService;
  let points: TaskPointsService;
  let service: TasksService;
  let catalog: TaskDef[];
  const extraTasks: string[] = [];

  async function person(): Promise<AccountRef> {
    const created = await accounts.upsert({ platform: "telegram", platformUserId: String(780_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Очки", username: null }, Date.now());
    return { accountId: created.accountId, platform: "telegram", platformUserId: "1" };
  }

  let runNo = 0;
  const runId = () => `points-it-${String(Date.now())}-${String(runNo++)}`;

  /** Выполнить задания: забег двигает их до цели. */
  async function complete(accountId: string, taskIds: readonly string[], at: Date): Promise<void> {
    const deltas: TaskDelta[] = taskIds.map((taskId) => {
      const task = catalog.find((candidate) => candidate.taskId === taskId);
      if (task === undefined) throw new Error(`нет задания ${taskId}`);
      return { taskId, period: task.period, target: task.target, op: task.kind === "best_survival_sec" || task.kind === "run_level" ? "max" : "sum", amount: task.target };
    });
    await tasks.applyRun({ runId: runId(), accountId, at, deltas });
  }

  const idsOf = (period: "daily" | "weekly", at: Date): string[] => rotationAt(catalog, at)[period];
  const pointsOf = (taskIds: readonly string[]): number => taskIds.reduce((sum, id) => sum + (catalog.find((task) => task.taskId === id)?.passPoints ?? 0), 0);

  async function coinEntries(accountId: string): Promise<{ count: number; amount: number; sources: string[] }> {
    const rows = await prisma.$queryRaw<{ amount: number; source: string | null }[]>`
      SELECT amount::int AS amount, source FROM wallet_entry WHERE account_id = ${accountId}::uuid AND resource = 'coins' AND reason = 'task_reward' ORDER BY created_at, idempotency_key`;
    return { count: rows.length, amount: rows.reduce((sum, row) => sum + row.amount, 0), sources: rows.map((row) => row.source ?? "") };
  }

  beforeAll(async () => {
    const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 10);
    accounts = new PrismaAccountRepository(prisma);
    tasks = new PrismaTasksRepository(prisma);
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    points = new TaskPointsService(new PrismaTaskPointsRepository(prisma), wallet);
    const unused = {} as never;
    service = new TasksService(tasks, wallet, new RunsHooks(), unused, unused, unused, unused, points);
    catalog = await tasks.catalog();
  });

  afterAll(async () => {
    if (extraTasks.length > 0) {
      await prisma.$executeRaw`DELETE FROM task_progress WHERE task_id IN (${Prisma.join(extraTasks)})`;
      await prisma.$executeRaw`DELETE FROM task_def WHERE task_id IN (${Prisma.join(extraTasks)})`;
    }
    await prisma.$disconnect();
  });

  it("миграция: у строк со ступенью очки 10 / 20 / 40 (день) и 20 / 40 / 80 (неделя), у остальных — нуль", () => {
    const expected = { daily: { easy: 10, medium: 20, hard: 40 }, weekly: { easy: 20, medium: 40, hard: 80 } } as const;
    const tiered = catalog.filter((task) => task.tier !== null && (task.period === "daily" || task.period === "weekly"));
    expect(tiered.length).toBeGreaterThanOrEqual(32);
    for (const task of tiered) expect(task.passPoints, task.taskId).toBe(expected[task.period as "daily" | "weekly"][task.tier ?? "easy"]);
    for (const task of catalog.filter((candidate) => candidate.tier === null)) expect(task.passPoints, task.taskId).toBe(0);
  });

  it("полный набор дня даёт 100 очков, недели — 240; недельная полоса включает и ежедневные", async () => {
    const dailySet = idsOf("daily", NOON);
    const weeklySet = idsOf("weekly", NOON);
    expect(pointsOf(dailySet)).toBe(100);
    expect(pointsOf(weeklySet)).toBe(240);

    const me = await person();
    await complete(me.accountId, [...dailySet, ...weeklySet], NOON);

    const view = await points.view(me.accountId, NOON);
    expect(view.daily.total).toBe(100);
    expect(view.weekly.total).toBe(340);
    expect(view.daily.steps.map((step) => step.state)).toEqual(["ready", "ready", "ready"]);
    expect(view.weekly.steps.map((step) => step.state)).toEqual(["ready", "locked", "locked"]);
  });

  it("очки идут по выполненному, а не по забранному: забирать само задание не нужно", async () => {
    const me = await person();
    const [first] = idsOf("daily", NOON);
    await complete(me.accountId, [first ?? ""], NOON);
    expect((await points.view(me.accountId, NOON)).daily.total).toBe(pointsOf([first ?? ""]));
    // Не доведено до цели — очков нет. Берём задание, где до цели можно не дойти: у части целей она равна единице.
    const other = await person();
    const task = idsOf("daily", NOON)
      .map((id) => catalog.find((candidate) => candidate.taskId === id))
      .find((candidate) => (candidate?.target ?? 0) >= 2);
    expect(task, "в наборе дня есть задание с целью больше единицы").toBeDefined();
    await tasks.applyRun({ runId: runId(), accountId: other.accountId, at: NOON, deltas: [{ taskId: task?.taskId ?? "", period: "daily", target: task?.target ?? 2, op: "sum", amount: (task?.target ?? 2) - 1 }] });
    expect((await points.view(other.accountId, NOON)).daily.total).toBe(0);
  });

  it("выполненное вчера в полосу дня не входит, в полосу недели той же недели входит, в полосу следующей недели — нет", async () => {
    const me = await person();
    const set = idsOf("daily", TUESDAY);
    await complete(me.accountId, set, TUESDAY);
    const earned = pointsOf(set);
    expect(earned).toBeGreaterThan(0);

    expect(await points.view(me.accountId, TUESDAY)).toMatchObject({ daily: { total: earned }, weekly: { total: earned } });
    const today = await points.view(me.accountId, NOON);
    expect(today.daily.total).toBe(0);
    expect(today.weekly.total).toBe(earned);
    expect(await points.view(me.accountId, NEXT_WEEK)).toMatchObject({ daily: { total: 0 }, weekly: { total: 0 } });
  });

  it("партнёрское задание с параметрами и задание с нулевыми очками очков не дают", async () => {
    const taskIds = ["it_pts_partner", "it_pts_zero"];
    extraTasks.push(...taskIds);
    await prisma.$executeRaw`
      INSERT INTO task_def (task_id, period, kind, target, coins, pass_points, params, created_at, updated_at)
      VALUES ('it_pts_partner', 'daily', 'link', 1, 10, 50, '{"url":"https://example.com/p"}'::jsonb, now(), now()),
             ('it_pts_zero', 'daily', 'runs', 1, 10, 0, NULL, now(), now())
      ON CONFLICT (task_id) DO NOTHING`;
    try {
      catalog = await tasks.catalog();
      const me = await person();
      await complete(me.accountId, taskIds, NOON);
      expect(await points.view(me.accountId, NOON)).toMatchObject({ daily: { total: 0 }, weekly: { total: 0 } });
    } finally {
      await prisma.$executeRaw`UPDATE task_def SET active = false WHERE task_id IN (${Prisma.join(taskIds)})`;
      catalog = await tasks.catalog();
    }
  });

  it("правка очков в каталоге пересчитывает набранное в текущем сроке; выключенное задание очков не даёт", async () => {
    const me = await person();
    const [first] = idsOf("daily", NOON);
    await complete(me.accountId, [first ?? ""], NOON);
    const before = (await points.view(me.accountId, NOON)).daily.total;

    await prisma.$executeRaw`UPDATE task_def SET pass_points = pass_points + 5 WHERE task_id = ${first ?? ""}`;
    try {
      expect((await points.view(me.accountId, NOON)).daily.total).toBe(before + 5);
      await prisma.$executeRaw`UPDATE task_def SET active = false WHERE task_id = ${first ?? ""}`;
      expect((await points.view(me.accountId, NOON)).daily.total).toBe(0);
    } finally {
      await prisma.$executeRaw`UPDATE task_def SET pass_points = pass_points - 5, active = true WHERE task_id = ${first ?? ""}`;
    }
  });

  it("забор ступени: монеты на балансе, одна запись кошелька с ключом и источником; повтор ничего не даёт", async () => {
    const me = await person();
    await complete(me.accountId, idsOf("daily", NOON), NOON);

    const first = await points.claim(me, "daily", 20, NOON);
    expect(first).toEqual({ claimed: true, credited: { coins: 40, gems: 0, shards: 0 }, points: 20 });
    expect(await coinEntries(me.accountId)).toEqual({ count: 1, amount: 40, sources: ["task_points:daily:20"] });
    const [key] = await prisma.$queryRaw<{ idempotency_key: string }[]>`
      SELECT idempotency_key FROM wallet_entry WHERE account_id = ${me.accountId}::uuid AND resource = 'coins' AND reason = 'task_reward'`;
    expect(key?.idempotency_key).toBe(`task_points:${me.accountId}:daily:2026-09-30:20:coins`);

    const again = await points.claim(me, "daily", 20, NOON);
    expect(again).toEqual({ claimed: false, credited: { coins: 0, gems: 0, shards: 0 }, points: 20 });
    expect(await coinEntries(me.accountId)).toMatchObject({ count: 1, amount: 40 });
    expect((await points.view(me.accountId, NOON)).daily.steps.map((step) => step.state)).toEqual(["claimed", "ready", "ready"]);
  });

  it("верхняя ступень дня — монеты и осколки двумя записями кошелька", async () => {
    const me = await person();
    await complete(me.accountId, idsOf("daily", NOON), NOON);

    expect(await points.claim(me, "daily", 100, NOON)).toEqual({ claimed: true, credited: { coins: 150, gems: 0, shards: 3 }, points: 100 });
    const rows = await prisma.$queryRaw<{ resource: string; amount: number }[]>`
      SELECT resource::text, amount::int AS amount FROM wallet_entry WHERE account_id = ${me.accountId}::uuid AND reason = 'task_reward' ORDER BY resource::text`;
    expect(rows).toEqual([
      { resource: "coins", amount: 150 },
      { resource: "shard_common", amount: 3 },
    ]);
  });

  it("два запроса и шесть разом на одну ступень начисляют однажды", async () => {
    const me = await person();
    await complete(me.accountId, idsOf("daily", NOON), NOON);

    const results = await Promise.all(Array.from({ length: 6 }, () => points.claim(me, "daily", 50, NOON)));

    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(results.filter((result) => !result.claimed).every((result) => result.credited.coins === 0)).toBe(true);
    expect(await coinEntries(me.accountId)).toMatchObject({ count: 1, amount: 80 });
  });

  it("ступень недели собирается из недельных и ежедневных заданий: 150 очков — 150 монет", async () => {
    const me = await person();
    await complete(me.accountId, [...idsOf("weekly", NOON), ...idsOf("daily", NOON)], NOON);
    // недельная полоса — 340, дневная — 100: недельные 150 готовы, а 400 нет.
    expect((await points.view(me.accountId, NOON)).weekly.total).toBe(340);

    expect(await points.claim(me, "weekly", 150, NOON)).toEqual({ claimed: true, credited: { coins: 150, gems: 0, shards: 0 }, points: 150 });
    expect(await coinEntries(me.accountId)).toEqual({ count: 1, amount: 150, sources: ["task_points:weekly:150"] });
    await expect(points.claim(me, "weekly", 400, NOON)).rejects.toBeInstanceOf(TaskPointsNotReachedError);
  });

  it("не хватает очков — task_points_not_reached, несуществующий порог — task_points_step_not_found; ничего не начислено", async () => {
    const me = await person();
    const [first] = idsOf("daily", NOON);
    await complete(me.accountId, [first ?? ""], NOON);

    const notReached = await points.claim(me, "daily", 100, NOON).catch((error: unknown) => error);
    expect(notReached).toBeInstanceOf(TaskPointsNotReachedError);
    expect(notReached).toMatchObject({ code: "task_points_not_reached", status: 409 });
    const missing = await points.claim(me, "daily", 30, NOON).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(TaskPointsStepNotFoundError);
    expect(missing).toMatchObject({ code: "task_points_step_not_found", status: 404 });
    expect(await coinEntries(me.accountId)).toMatchObject({ count: 0, amount: 0 });
  });

  it("ступень вчерашних суток после полуночи не забирается: срок ключуется началом суток", async () => {
    const me = await person();
    await complete(me.accountId, idsOf("daily", TUESDAY), TUESDAY);
    expect((await points.view(me.accountId, TUESDAY)).daily.steps[0]?.state).toBe("ready");

    await expect(points.claim(me, "daily", 20, NOON)).rejects.toBeInstanceOf(TaskPointsNotReachedError);
    expect(await coinEntries(me.accountId)).toMatchObject({ count: 0 });
    // а в свои сутки — забирается
    expect((await points.claim(me, "daily", 20, TUESDAY)).claimed).toBe(true);
  });

  it("суточный потолок кошелька режет награду: credited меньше, отметка стоит, повтор ничего не даёт", async () => {
    const me = await person();
    await complete(me.accountId, idsOf("daily", NOON), NOON);
    const cap = WALLET_DAILY_CAPS.task_reward.coins ?? 0;
    // до потолка остаётся 10 монет: награда ступени — 40
    await wallet.grant({ accountId: me.accountId, resource: "coins", amount: cap - 10, reason: "task_reward", source: "it:cap", idempotencyKey: `points-it-cap:${me.accountId}`, at: NOON });

    const result = await points.claim(me, "daily", 20, NOON);

    expect(result.claimed).toBe(true);
    expect(result.credited.coins).toBe(10);
    const again = await points.claim(me, "daily", 20, NOON);
    expect(again).toMatchObject({ claimed: false, credited: { coins: 0 } });
    const [balance] = await prisma.$queryRaw<{ amount: number }[]>`
      SELECT COALESCE(SUM(amount), 0)::int AS amount FROM wallet_entry WHERE account_id = ${me.accountId}::uuid AND resource = 'coins' AND reason = 'task_reward'`;
    expect(balance?.amount).toBe(cap);
  });

  it("знак: готовые ступени прибавляются к невзятым наградам заданий и убывают после забора", async () => {
    const me = await person();
    const dailySet = idsOf("daily", NOON);
    await complete(me.accountId, dailySet, NOON);

    // пять заданий ждут забора и готовы три ступени дня; недельная полоса — 100 очков, ступени нет
    expect(await service.badge(me.accountId, NOON)).toBe(dailySet.length + 3);
    await points.claim(me, "daily", 20, NOON);
    expect(await service.badge(me.accountId, NOON)).toBe(dailySet.length + 2);
    await points.claim(me, "daily", 50, NOON);
    await points.claim(me, "daily", 100, NOON);
    expect(await service.badge(me.accountId, NOON)).toBe(dailySet.length);
  });

  it("представление сервиса заданий: points — та же полоса, что у сервиса очков; без сервиса очков — null", async () => {
    const me = await person();
    await complete(me.accountId, idsOf("daily", NOON), NOON);
    const view = (await service.pointsView(me.accountId, NOON)) as PointsView;
    expect(view.daily.total).toBe(100);
    expect(view.daily.steps.map((step) => step.points)).toEqual(POINT_STEPS.daily.map((step) => step.points));

    const unused = {} as never;
    const bare = new TasksService(tasks, wallet, new RunsHooks(), unused, unused, unused, unused);
    expect(await bare.pointsView(me.accountId, NOON)).toBeNull();
  });
});
