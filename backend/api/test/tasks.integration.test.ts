import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { rewardReason, type TaskParams, type TaskDef } from "../src/modules/tasks/task-rules.js";
import { ACHIEVEMENT_PERIOD_START, PrismaTasksRepository, type TaskDelta } from "../src/modules/tasks/tasks.repository.js";
import { WALLET_DAILY_CAPS } from "../src/modules/wallet/wallet-limits.js";

/**
 * Задания на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск): начало суток и недели считает база
 * по Москве, забег засчитывается однажды и под гонкой, прогресс не уходит за
 * цель, забирается только выполненное — и однажды.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
/** среда, 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));

describe.skipIf(DATABASE_URL === "")("задания на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let repository: PrismaTasksRepository;
  let catalog: TaskDef[];

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(960_000_000 + Math.floor(Math.random() * 30_000_000)), displayName: "Задания", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  function deltas(amounts: Partial<Record<string, number>>): TaskDelta[] {
    return Object.entries(amounts).map(([taskId, amount]) => {
      const task = catalog.find((candidate) => candidate.taskId === taskId);
      if (task === undefined) throw new Error(`нет задания ${taskId}`);
      const op = task.kind === "best_survival_sec" || task.kind === "run_level" ? "max" : "sum";
      return { taskId, period: task.period, target: task.target, op, amount: amount ?? 0 };
    });
  }

  let runNo = 0;
  const runId = () => `tasks-it-${String(Date.now())}-${String(runNo++)}`;

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 10, connectionTimeoutMillis: 30_000 }) });
    accounts = new PrismaAccountRepository(prisma);
    repository = new PrismaTasksRepository(prisma);
    catalog = await repository.catalog();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("каталог по умолчанию — из миграции, и честный игрок не упирается в суточные потолки", () => {
    expect(catalog.map((task) => task.taskId)).toEqual(expect.arrayContaining(["daily_runs", "weekly_runs", "ach_survive_5"]));
    for (const reason of ["task_reward", "achievement_reward"] as const) {
      const tasks = catalog.filter((task) => task.active && rewardReason(task.period) === reason);
      const cap = WALLET_DAILY_CAPS[reason];
      expect(tasks.reduce((sum, task) => sum + task.coins, 0), `${reason}: монеты`).toBeLessThanOrEqual(cap.coins ?? 0);
      expect(tasks.reduce((sum, task) => sum + task.gems, 0), `${reason}: самоцветы`).toBeLessThanOrEqual(cap.gems ?? 0);
      expect(tasks.reduce((sum, task) => sum + task.shards, 0), `${reason}: осколки`).toBeLessThanOrEqual(cap.shard_common ?? 0);
    }
    expect(catalog.filter((task) => task.period !== "achievement").every((task) => task.gems === 0)).toBe(true);
  });

  it("копит и помнит лучший, не уходит за цель, отмечает выполнение", async () => {
    const me = await account();
    await repository.applyRun({ runId: runId(), accountId: me, at: NOON, deltas: deltas({ daily_runs: 1, daily_kills: 700, ach_survive_5: 200 }) });
    await repository.applyRun({ runId: runId(), accountId: me, at: NOON, deltas: deltas({ daily_runs: 1, daily_kills: 700, ach_survive_5: 150 }) });

    const rows = new Map((await repository.progress(me, NOON)).map((row) => [row.taskId, row]));
    expect(rows.get("daily_runs")).toMatchObject({ value: 2, done: false, periodStart: "2026-09-30" });
    expect(rows.get("daily_kills")).toMatchObject({ value: 1000, done: true });
    expect(rows.get("ach_survive_5")).toMatchObject({ value: 200, done: false, periodStart: "2000-01-01" });
  });

  it("забег засчитывается однажды — и повтором, и шестью разом", async () => {
    const me = await account();
    const same = runId();
    expect(await repository.applyRun({ runId: same, accountId: me, at: NOON, deltas: deltas({ daily_runs: 1 }) })).toBe(true);
    expect(await repository.applyRun({ runId: same, accountId: me, at: NOON, deltas: deltas({ daily_runs: 1 }) })).toBe(false);

    const race = runId();
    const results = await Promise.all(Array.from({ length: 6 }, () => repository.applyRun({ runId: race, accountId: me, at: NOON, deltas: deltas({ daily_runs: 1 }) })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await repository.progress(me, NOON)).find((row) => row.taskId === "daily_runs")?.value).toBe(2);
  });

  it("сутки — московские, неделя — с понедельника: 23:59 воскресенья и 00:01 понедельника — разные сроки", async () => {
    const me = await account();
    const sundayLate = new Date(Date.UTC(2026, 9, 4, 20, 59));
    const mondayEarly = new Date(Date.UTC(2026, 9, 4, 21, 1));
    await repository.applyRun({ runId: runId(), accountId: me, at: sundayLate, deltas: deltas({ daily_runs: 1, weekly_runs: 1 }) });

    const sunday = new Map((await repository.progress(me, sundayLate)).map((row) => [row.taskId, row]));
    expect(sunday.get("daily_runs")?.periodStart).toBe("2026-10-04");
    expect(sunday.get("weekly_runs")?.periodStart).toBe("2026-09-28");
    expect(await repository.progress(me, mondayEarly)).toEqual([]);
  });

  it("забирается только выполненное — и однажды, в том числе под гонкой", async () => {
    const me = await account();
    await repository.applyRun({ runId: runId(), accountId: me, at: NOON, deltas: deltas({ daily_runs: 1 }) });
    expect(await repository.markClaimed(me, "daily_runs", "2026-09-30", NOON)).toBe(false);

    await repository.applyRun({ runId: runId(), accountId: me, at: NOON, deltas: deltas({ daily_runs: 2 }) });
    const results = await Promise.all(Array.from({ length: 6 }, () => repository.markClaimed(me, "daily_runs", "2026-09-30", NOON)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await repository.progress(me, NOON)).find((row) => row.taskId === "daily_runs")).toMatchObject({ done: true, claimed: true });
  });

  it("выключенное задание прогресса не показывает, а база не примет пустую награду и забор невыполненного", async () => {
    const me = await account();
    await prisma.$executeRaw`
      INSERT INTO task_def (task_id, period, kind, target, coins, created_at, updated_at, active)
      VALUES ('it_off', 'daily', 'runs', 1, 10, now(), now(), false) ON CONFLICT (task_id) DO NOTHING`;
    await repository.applyRun({ runId: runId(), accountId: me, at: NOON, deltas: [{ taskId: "it_off", period: "daily", target: 1, op: "sum", amount: 1 }] });
    expect((await repository.progress(me, NOON)).map((row) => row.taskId)).not.toContain("it_off");

    await expect(prisma.$executeRaw`
      INSERT INTO task_def (task_id, period, kind, target, created_at, updated_at) VALUES ('it_empty', 'daily', 'runs', 1, now(), now())`).rejects.toThrow();
    await expect(prisma.$executeRaw`
      INSERT INTO task_progress (account_id, task_id, period_start, value, target, claimed_at, updated_at)
      VALUES (${me}::uuid, 'daily_level', '2026-09-30', 1, 20, now(), now())`).rejects.toThrow();
  });

  it("каталог из панели: новое заводится однажды, правка не трогает срок и вид и помнит автора", async () => {
    const actor = await account();
    const taskId = `it_panel_${String(Date.now())}`;
    const task: TaskDef = {
      taskId,
      period: "weekly",
      kind: "kills",
      params: null,
      target: 500,
      title: "Проверка",
      coins: 50,
      gems: 0,
      shards: 0,
      passPoints: 5,
      sort: 99,
      active: true,
    };
    expect(await repository.insert(task, actor, NOON)).toBe(true);
    expect(await repository.insert({ ...task, coins: 999 }, actor, NOON)).toBe(false);

    expect(await repository.update({ ...task, period: "daily", kind: "runs", coins: 75, active: false }, actor, NOON)).toBe(true);
    expect((await repository.catalog()).find((candidate) => candidate.taskId === taskId)).toEqual({ ...task, coins: 75, active: false });
    const [row] = await prisma.$queryRaw<{ updated_by: string }[]>`SELECT updated_by::text FROM task_def WHERE task_id = ${taskId}`;
    expect(row?.updated_by).toBe(actor);

    expect(await repository.update({ ...task, taskId: "it_missing_task" }, actor, NOON)).toBe(false);
  });

  it("цель «канал»: параметры хранятся и читаются, выполнение пишется однажды и сразу целью", async () => {
    const actor = await account();
    const me = await account();
    const taskId = `it_channel_${String(Date.now())}`;
    const params: TaskParams = { platform: "telegram", chat: "@rubezh_game", url: "https://t.me/rubezh_game" };
    const task: TaskDef = {
      taskId,
      period: "achievement",
      kind: "channel",
      params,
      target: 1,
      title: null,
      coins: 0,
      gems: 15,
      shards: 0,
      passPoints: 0,
      sort: 99,
      active: true,
    };
    expect(await repository.insert(task, actor, NOON)).toBe(true);
    expect((await repository.catalog()).find((candidate) => candidate.taskId === taskId)).toEqual(task);
    expect(await repository.update({ ...task, params: { ...params, url: "https://t.me/rubezh_news" } }, actor, NOON)).toBe(true);
    expect((await repository.catalog()).find((candidate) => candidate.taskId === taskId)?.params).toMatchObject({ url: "https://t.me/rubezh_news" });

    const first = await repository.complete(me, task, NOON);
    expect(first).toMatchObject({ taskId, periodStart: ACHIEVEMENT_PERIOD_START, value: 1, done: true, claimed: false });
    const [stamp] = await prisma.$queryRaw<{ completed_at: Date }[]>`
      SELECT completed_at FROM task_progress WHERE account_id = ${me}::uuid AND task_id = ${taskId}`;
    expect(await repository.markClaimed(me, taskId, first.periodStart, NOON)).toBe(true);
    // повтор — то же выполнение: время первое, забранное остаётся забранным
    expect(await repository.complete(me, task, new Date(NOON.getTime() + 60_000))).toMatchObject({ value: 1, done: true, claimed: true });
    const [again] = await prisma.$queryRaw<{ completed_at: Date }[]>`
      SELECT completed_at FROM task_progress WHERE account_id = ${me}::uuid AND task_id = ${taskId}`;
    expect(again?.completed_at).toEqual(stamp?.completed_at);
    expect((await repository.progress(me, NOON)).find((row) => row.taskId === taskId)).toMatchObject({ done: true, claimed: true });
    // выключается, чтобы следующий прогон не видел чужую награду в каталоге
    expect(await repository.update({ ...task, active: false }, actor, NOON)).toBe(true);

    // параметры — ровно у цели «канал»: база это держит и без кода
    await expect(prisma.$executeRaw`
      INSERT INTO task_def (task_id, period, kind, target, gems, created_at, updated_at) VALUES ('it_channel_bare', 'achievement', 'channel', 1, 5, now(), now())`).rejects.toThrow();
    await expect(prisma.$executeRaw`
      INSERT INTO task_def (task_id, period, kind, target, gems, params, created_at, updated_at)
      VALUES ('it_runs_params', 'daily', 'runs', 1, 5, '{"chat":"@x"}'::jsonb, now(), now())`).rejects.toThrow();
    // переход по ссылке и запуск бота — тоже партнёрские: без ссылки база их не примет
    await expect(prisma.$executeRaw`
      INSERT INTO task_def (task_id, period, kind, target, gems, created_at, updated_at) VALUES ('it_link_bare', 'achievement', 'link', 1, 5, now(), now())`).rejects.toThrow();
    const linkId = `it_link_${String(Date.now())}`;
    expect(
      await repository.insert({ ...task, taskId: linkId, kind: "link", params: { url: "https://example.com/partner" }, active: false }, actor, NOON),
    ).toBe(true);
    expect((await repository.catalog()).find((candidate) => candidate.taskId === linkId)?.params).toEqual({ url: "https://example.com/partner" });
  });

  it("строка с битыми параметрами пропускается, а не роняет каталог", async () => {
    const taskId = `it_broken_${String(Date.now())}`;
    await prisma.$executeRaw`
      INSERT INTO task_def (task_id, period, kind, target, gems, params, active, created_at, updated_at)
      VALUES (${taskId}, 'achievement', 'channel', 1, 5, '{"platform":"telegram","chat":"@x","url":"http://insecure"}'::jsonb, false, now(), now())`;
    const after = await repository.catalog();
    expect(after.some((candidate) => candidate.taskId === taskId)).toBe(false);
    expect(after.some((candidate) => candidate.taskId === "daily_runs")).toBe(true);
  });

  it("удалённый аккаунт уносит прогресс и засчитанные забеги", async () => {
    const me = await account();
    await repository.applyRun({ runId: runId(), accountId: me, at: NOON, deltas: deltas({ daily_runs: 1 }) });
    await prisma.$executeRaw`DELETE FROM account WHERE account_id = ${me}::uuid`;
    const [left] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT (SELECT count(*) FROM task_progress WHERE account_id = ${me}::uuid) + (SELECT count(*) FROM task_run WHERE account_id = ${me}::uuid) AS n`;
    expect(Number(left?.n)).toBe(0);
  });
});
