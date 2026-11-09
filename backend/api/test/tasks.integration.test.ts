import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { imageIdOf } from "../src/modules/media/image-rules.js";
import { PrismaMediaRepository } from "../src/modules/media/media.repository.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import { POOL_QUOTA, gameDayOf, gameWeekStartOf, pickPool } from "../src/modules/tasks/task-pool.js";
import { NO_ACHIEVEMENT_FIELDS, POOL_TIERS, type TaskParams, type TaskDef } from "../src/modules/tasks/task-rules.js";
import { TaskNotFoundError } from "../src/modules/tasks/tasks-errors.js";
import { ACHIEVEMENT_PERIOD_START, PrismaTasksRepository, periodStartSql, type TaskDelta } from "../src/modules/tasks/tasks.repository.js";
import { TasksService } from "../src/modules/tasks/tasks.service.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";
import type { WalletService } from "../src/modules/wallet/wallet.service.js";
import { Prisma } from "../src/generated/prisma/client.js";
import { WALLET_DAILY_CAPS } from "../src/modules/wallet/wallet-limits.js";
import { webp } from "./helpers/webp-samples.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Задания на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск): начало суток и недели считает база
 * по Москве, забег засчитывается однажды и под гонкой, прогресс не уходит за
 * цель, забирается только выполненное — и однажды. Лимит выполнений
 * партнёрской цели выдерживает одновременный забор, мягкий час пускает
 * начавших сверх лимита, а повтор срока места не занимает.
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
    prisma = testPrisma(DATABASE_URL, 10);
    accounts = new PrismaAccountRepository(prisma);
    repository = new PrismaTasksRepository(prisma);
    catalog = await repository.catalog();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /**
   * Самый щедрый набор, который игрок может забрать за сутки: у строк пула
   * — лучшие по ступени в пределах квоты, остальные строки — все.
   */
  function richestSet(period: "daily" | "weekly"): TaskDef[] {
    const rows = catalog.filter((task) => task.active && task.period === period);
    const pooled = POOL_TIERS.flatMap((tier) =>
      rows
        .filter((task) => task.tier === tier)
        .sort((a, b) => b.coins + b.shards * 10 - (a.coins + a.shards * 10))
        .slice(0, POOL_QUOTA[period][tier]),
    );
    return [...rows.filter((task) => task.tier === null), ...pooled];
  }

  it("каталог по умолчанию — из миграции, и честный игрок не упирается в суточные потолки", () => {
    expect(catalog.map((task) => task.taskId)).toEqual(expect.arrayContaining(["daily_runs", "weekly_runs", "ach_survive_5"]));
    const sets = {
      task_reward: [...richestSet("daily"), ...richestSet("weekly")],
      achievement_reward: catalog.filter((task) => task.active && task.period === "achievement"),
    };
    for (const reason of ["task_reward", "achievement_reward"] as const) {
      const tasks = sets[reason];
      const cap = WALLET_DAILY_CAPS[reason];
      expect(tasks.reduce((sum, task) => sum + task.coins, 0), `${reason}: монеты`).toBeLessThanOrEqual(cap.coins ?? 0);
      expect(tasks.reduce((sum, task) => sum + task.gems, 0), `${reason}: самоцветы`).toBeLessThanOrEqual(cap.gems ?? 0);
      expect(tasks.reduce((sum, task) => sum + task.shards, 0), `${reason}: осколки`).toBeLessThanOrEqual(cap.shard_common ?? 0);
    }
    expect(catalog.filter((task) => task.period !== "achievement").every((task) => task.gems === 0)).toBe(true);
  });

  it("миграция пула: 28 дневных (11/11/6) и 19 недельных (6/8/5), у старых строк ступень, награды прежние", () => {
    const count = (period: "daily" | "weekly") =>
      Object.fromEntries(POOL_TIERS.map((tier) => [tier, catalog.filter((task) => task.period === period && task.tier === tier).length]));
    expect(count("daily")).toEqual({ easy: 11, medium: 11, hard: 6 });
    expect(count("weekly")).toEqual({ easy: 6, medium: 8, hard: 5 });

    const old: [string, string | null, number, number][] = [
      ["daily_runs", "easy", 120, 0],
      ["daily_kills", "medium", 150, 0],
      ["daily_survive", "medium", 150, 3],
      ["daily_level", "hard", 100, 0],
      ["weekly_runs", "easy", 800, 10],
      ["weekly_kills", "medium", 1000, 0],
      ["weekly_survive", "medium", 1000, 10],
    ];
    for (const [taskId, tier, coins, shards] of old) expect(catalog.find((task) => task.taskId === taskId), taskId).toMatchObject({ tier, coins, shards });
    // достижения в ротацию не входят
    expect(catalog.filter((task) => task.period === "achievement").every((task) => task.tier === null)).toBe(true);
    // новые виды цели сеются с фильтром
    expect(catalog.find((task) => task.taskId === "daily_weapon_spark")).toMatchObject({ kind: "weapon_runs", filter: { weapon: "spark" }, target: 2, tier: "easy", coins: 70 });
    expect(catalog.find((task) => task.taskId === "weekly_hard_240")).toMatchObject({ kind: "difficulty_survive_sec", filter: { difficulty: "hard" }, tier: "hard", coins: 900, shards: 5 });
  });

  it("пятнадцать заданий про боссов, элит, сундуки, кристаллы и эволюции (T-0126): ступень, награда и очки как у ступени", () => {
    const added: [string, "daily" | "weekly", "easy" | "medium" | "hard", string, number][] = [
      ["daily_elite_1", "daily", "easy", "elite_kills", 1],
      ["daily_chest_1", "daily", "easy", "chests_opened", 1],
      ["daily_crystals_300", "daily", "easy", "crystals_collected", 300],
      ["daily_elite_3", "daily", "medium", "elite_kills", 3],
      ["daily_chest_3", "daily", "medium", "chests_opened", 3],
      ["daily_crystals_1000", "daily", "medium", "crystals_collected", 1000],
      ["daily_boss_1", "daily", "hard", "boss_kills", 1],
      ["daily_evolution", "daily", "hard", "evolution_runs", 1],
      ["weekly_elite_5", "weekly", "easy", "elite_kills", 5],
      ["weekly_chest_5", "weekly", "easy", "chests_opened", 5],
      ["weekly_elite_15", "weekly", "medium", "elite_kills", 15],
      ["weekly_chest_12", "weekly", "medium", "chests_opened", 12],
      ["weekly_crystals_5000", "weekly", "medium", "crystals_collected", 5000],
      ["weekly_boss_3", "weekly", "hard", "boss_kills", 3],
      ["weekly_evolution_2", "weekly", "hard", "evolution_runs", 2],
    ];
    const reward = {
      daily: { easy: { coins: 70, shards: 0 }, medium: { coins: 110, shards: 0 }, hard: { coins: 160, shards: 0 } },
      weekly: { easy: { coins: 300, shards: 0 }, medium: { coins: 550, shards: 0 }, hard: { coins: 900, shards: 5 } },
    } as const;
    // очки — у опорной строки той же ступени и срока (T-0105)
    const anchor = { daily: { easy: "daily_runs", medium: "daily_kills", hard: "daily_level" }, weekly: { easy: "weekly_runs", medium: "weekly_kills", hard: "weekly_best_540" } } as const;
    expect(added.length).toBe(15);
    for (const [taskId, period, tier, kind, target] of added) {
      const task = catalog.find((candidate) => candidate.taskId === taskId);
      expect(task, taskId).toMatchObject({ period, tier, kind, target, title: null, filter: null, active: true, gems: 0, ...reward[period][tier] });
      expect(task?.passPoints, `${taskId}: очки`).toBe(catalog.find((candidate) => candidate.taskId === anchor[period][tier])?.passPoints);
      expect(task?.passPoints ?? 0, `${taskId}: очки больше нуля`).toBeGreaterThan(0);
    }
    // внутри ступени строки идут по алфавиту id, ступени — блоками 150+ / 250+ / 350+
    for (const period of ["daily", "weekly"] as const) {
      for (const [tier, base] of [["easy", 150], ["medium", 250], ["hard", 350]] as const) {
        const rows = added.filter((row) => row[1] === period && row[2] === tier).map((row) => catalog.find((task) => task.taskId === row[0]));
        const sorted = [...rows].sort((a, b) => (a?.taskId ?? "").localeCompare(b?.taskId ?? ""));
        expect(
          sorted.map((task) => task?.sort),
          `${period}/${tier}`,
        ).toEqual(sorted.map((_task, index) => base + index));
      }
    }
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
      filter: null,
      tier: null,
      target: 500,
      title: "Проверка",
      coins: 50,
      gems: 0,
      shards: 0,
      passPoints: 5,
      sort: 99,
      active: true,
      limit: null,
      image: null,
      ...NO_ACHIEVEMENT_FIELDS,
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
      filter: null,
      tier: null,
      target: 1,
      title: null,
      coins: 0,
      gems: 15,
      shards: 0,
      passPoints: 0,
      sort: 99,
      active: true,
      limit: null,
      image: null,
      ...NO_ACHIEVEMENT_FIELDS,
    };
    expect(await repository.insert(task, actor, NOON)).toBe(true);
    expect((await repository.catalog()).find((candidate) => candidate.taskId === taskId)).toEqual(task);
    expect(await repository.update({ ...task, params: { ...params, url: "https://t.me/rubezh_news" } }, actor, NOON)).toBe(true);
    expect((await repository.catalog()).find((candidate) => candidate.taskId === taskId)?.params).toMatchObject({ url: "https://t.me/rubezh_news" });

    const first = await repository.complete(me, task, NOON, NOON);
    expect(first).toMatchObject({ taskId, periodStart: ACHIEVEMENT_PERIOD_START, value: 1, done: true, claimed: false });
    if (first === null) throw new Error("место без лимита есть всегда");
    const [stamp] = await prisma.$queryRaw<{ completed_at: Date }[]>`
      SELECT completed_at FROM task_progress WHERE account_id = ${me}::uuid AND task_id = ${taskId}`;
    expect(await repository.markClaimed(me, taskId, first.periodStart, NOON)).toBe(true);
    // повтор — то же выполнение: время первое, забранное остаётся забранным
    expect(await repository.complete(me, task, new Date(NOON.getTime() + 60_000), NOON)).toMatchObject({ value: 1, done: true, claimed: true });
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

  /** Партнёрская цель с лимитом — своя на каждый прогон, выключенная: каталог других тестов её не видит. */
  async function limitedTask(limit: number | null, period: TaskDef["period"] = "achievement"): Promise<TaskDef> {
    const task: TaskDef = {
      taskId: `it_limit_${String(Date.now())}_${String(runNo++)}`,
      period,
      kind: "channel",
      params: { platform: "telegram", chat: "@rubezh_game", url: "https://t.me/rubezh_game" },
      filter: null,
      tier: null,
      target: 1,
      title: null,
      coins: 10,
      gems: 0,
      shards: 0,
      passPoints: 0,
      sort: 99,
      active: false,
      limit,
      image: null,
      ...NO_ACHIEVEMENT_FIELDS,
    };
    expect(await repository.insert(task, await account(), NOON)).toBe(true);
    return task;
  }

  const minutes = (value: number) => new Date(NOON.getTime() + value * 60_000);

  it("лимит выполнений: двадцать заборов разом при пяти местах — ровно пять выполнений", async () => {
    const task = await limitedTask(5);
    const players = await Promise.all(Array.from({ length: 20 }, async () => await account()));
    const results = await Promise.all(players.map(async (me) => await repository.complete(me, task, NOON, minutes(-60))));
    expect(results.filter((row) => row !== null)).toHaveLength(5);
    const [row] = await prisma.$queryRaw<{ completions: number; participants: bigint }[]>`
      SELECT completions, (SELECT count(*) FROM task_participant WHERE task_id = ${task.taskId} AND completed_at IS NOT NULL) AS participants
      FROM task_def WHERE task_id = ${task.taskId}`;
    expect([row?.completions, Number(row?.participants)]).toEqual([5, 5]);
    expect((await repository.completions()).get(task.taskId)).toBe(5);
  });

  it("один игрок двумя заборами разом занимает одно место", async () => {
    const task = await limitedTask(3);
    const me = await account();
    const results = await Promise.all([repository.complete(me, task, NOON, minutes(-60)), repository.complete(me, task, NOON, minutes(-60))]);
    expect(results.every((row) => row !== null)).toBe(true);
    expect((await repository.completions()).get(task.taskId)).toBe(1);
  });

  it("мягкий час: перешедший до исчерпания выполняет сверх лимита, перешедший раньше часа — нет", async () => {
    const task = await limitedTask(1);
    const [filler, early, stale] = await Promise.all([account(), account(), account()]);
    await repository.markOpened(early, task.taskId, minutes(0));
    await repository.markOpened(stale, task.taskId, minutes(-120));
    expect(await repository.complete(filler, task, minutes(5), minutes(-55))).not.toBeNull();
    expect(await repository.complete(stale, task, minutes(10), minutes(-50))).toBeNull();
    expect(await repository.complete(early, task, minutes(30), minutes(-30))).toMatchObject({ done: true });
    expect((await repository.completions()).get(task.taskId)).toBe(2);
  });

  it("повтор срока места не занимает; участие игрока читается с числом выполнивших", async () => {
    const task = await limitedTask(1, "daily");
    const me = await account();
    expect(await repository.complete(me, task, NOON, minutes(-60))).toMatchObject({ periodStart: "2026-09-30" });
    expect(await repository.complete(me, task, minutes(24 * 60), minutes(24 * 60 - 60))).toMatchObject({ periodStart: "2026-10-01" });
    expect((await repository.completions()).get(task.taskId)).toBe(1);
    await repository.update({ ...task, active: true }, me, NOON);
    const mine = (await repository.participation(me)).get(task.taskId);
    expect(mine).toEqual({ completions: 1, openedAt: null, completedAt: NOON });
    await repository.update({ ...task, active: false }, me, NOON);
  });

  it("база держит лимит: только у партнёрской цели и в пределах; удалённый аккаунт уносит участие, но не счёт", async () => {
    await expect(prisma.$executeRaw`
      INSERT INTO task_def (task_id, period, kind, target, coins, completion_limit, created_at, updated_at)
      VALUES ('it_runs_limit', 'daily', 'runs', 1, 5, 10, now(), now())`).rejects.toThrow();
    await expect(prisma.$executeRaw`
      INSERT INTO task_def (task_id, period, kind, target, coins, params, completion_limit, created_at, updated_at)
      VALUES ('it_zero_limit', 'achievement', 'link', 1, 5, '{"url":"https://example.com"}'::jsonb, 0, now(), now())`).rejects.toThrow();
    const task = await limitedTask(2);
    const me = await account();
    await repository.complete(me, task, NOON, minutes(-60));
    await prisma.$executeRaw`DELETE FROM account WHERE account_id = ${me}::uuid`;
    const [left] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM task_participant WHERE account_id = ${me}::uuid`;
    expect(Number(left?.n)).toBe(0);
    expect((await repository.completions()).get(task.taskId)).toBe(1);
  });
  it("картинка задания: читается каталогом и меняется правкой; пока на неё ссылаются, не удаляется; у цели забега её нет", async () => {
    const bytes = Buffer.concat([webp("square96"), Buffer.from(String(Date.now()))]);
    const imageId = imageIdOf(bytes);
    await new PrismaMediaRepository(prisma).insert({ imageId, contentType: "image/webp", width: 96, height: 96, sizeBytes: bytes.length, data: bytes, createdBy: await account() });
    const task = await limitedTask(null);
    expect(await repository.update({ ...task, image: imageId }, await account(), NOON)).toBe(true);
    expect((await repository.catalog()).find((candidate) => candidate.taskId === task.taskId)?.image).toBe(imageId);

    await expect(prisma.$executeRaw`DELETE FROM media_image WHERE image_id = ${imageId}`).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE task_def SET image_id = ${"0".repeat(64)} WHERE task_id = ${task.taskId}`).rejects.toThrow();
    const runTask = catalog.find((candidate) => candidate.params === null);
    await expect(prisma.$executeRaw`UPDATE task_def SET image_id = ${imageId} WHERE task_id = ${runTask?.taskId ?? ""}`).rejects.toThrow();

    expect(await repository.update({ ...task, image: null }, await account(), NOON)).toBe(true);
    expect((await repository.catalog()).find((candidate) => candidate.taskId === task.taskId)?.image).toBeNull();
  });

  describe("порядок списка одним запросом (T-0167)", () => {
    const STAMP = new Date("2026-01-01T00:00:00Z");

    // Свои строки уходят после проверок: соседние проверки читают каталог и не ждут чужих партнёрских целей.
    const cleanup = async (): Promise<void> => {
      await prisma.$executeRaw`DELETE FROM task_def WHERE task_id LIKE 'it\_ord\_%'`;
    };
    beforeAll(cleanup);
    afterAll(cleanup);

    function partner(taskId: string): TaskDef {
      return {
        taskId,
        period: "achievement",
        kind: "link",
        params: { url: "https://example.org/order" },
        filter: null,
        tier: null,
        target: 1,
        title: null,
        coins: 10,
        gems: 0,
        shards: 0,
        passPoints: 0,
        sort: 0,
        active: true,
        limit: null,
        image: null,
        ...NO_ACHIEVEMENT_FIELDS,
      };
    }

    /** Партнёрская группа как её видит панель: состав и порядок, `sort` по возрастанию, затем id. */
    async function partnerIds(): Promise<string[]> {
      const rows = await prisma.$queryRaw<{ task_id: string }[]>`
        SELECT task_id FROM task_def WHERE kind IN ('channel', 'link', 'bot') ORDER BY sort, task_id`;
      return rows.map((row) => row.task_id);
    }

    /** Группа с четырьмя своими строками, `sort` = 0, 1, 2… и штампом `updated_at`, который не должен сдвигаться у нетронутых. */
    async function preparedGroup(): Promise<{ ids: string[]; own: string[] }> {
      const actor = await account();
      const suffix = `${String(Date.now())}_${String(runNo++)}`;
      const own = ["a", "b", "c", "d"].map((letter) => `it_ord_${letter}_${suffix}`);
      for (const taskId of own) expect(await repository.insert(partner(taskId), actor, STAMP)).toBe(true);
      const ids = await partnerIds();
      await prisma.$executeRaw`
        UPDATE task_def SET sort = (o.n - 1)::int, updated_at = ${STAMP}
        FROM unnest(${ids}::text[]) WITH ORDINALITY AS o(task_id, n) WHERE task_def.task_id = o.task_id`;
      return { ids: await partnerIds(), own };
    }

    async function stamps(): Promise<Map<string, { sort: number; updatedAt: Date }>> {
      const rows = await prisma.$queryRaw<{ task_id: string; sort: number; updated_at: Date }[]>`
        SELECT task_id, sort, updated_at FROM task_def WHERE kind IN ('channel', 'link', 'bot')`;
      return new Map(rows.map((row) => [row.task_id, { sort: row.sort, updatedAt: row.updated_at }]));
    }

    it("переписывает sort только у сдвинувшихся строк: у остальных updated_at прежний", async () => {
      const actor = await account();
      const { ids, own } = await preparedGroup();
      const [, b, c] = own;
      const order = ids.map((id) => (id === b ? (c ?? id) : id === c ? (b ?? id) : id));
      const at = new Date("2026-10-30T12:00:00Z");

      const result = await repository.reorder("partner", order, actor, at);

      expect(result).toMatchObject({ status: "ok", changed: true, before: ids, after: order });
      const after = await stamps();
      for (const id of ids) {
        const moved = id === b || id === c;
        expect(after.get(id)?.sort, id).toBe(order.indexOf(id));
        expect(after.get(id)?.updatedAt.getTime(), id).toBe(moved ? at.getTime() : STAMP.getTime());
      }
    });

    it("тот же порядок — changed: false и ни одной записи", async () => {
      const actor = await account();
      const { ids } = await preparedGroup();
      const before = await stamps();

      const result = await repository.reorder("partner", ids, actor, new Date("2026-10-30T13:00:00Z"));

      expect(result).toMatchObject({ status: "ok", changed: false, before: ids, after: ids });
      expect(await stamps()).toEqual(before);
    });

    it("два одновременных запроса с разными порядками: оба проходят, итог — один из двух без смешения", async () => {
      const actor = await account();
      const { ids } = await preparedGroup();
      const forward = ids;
      const backward = [...ids].reverse();

      const [first, second] = await Promise.all([
        repository.reorder("partner", forward, actor, new Date("2026-10-30T14:00:00Z")),
        repository.reorder("partner", backward, actor, new Date("2026-10-30T14:00:01Z")),
      ]);

      expect(first.status).toBe("ok");
      expect(second.status).toBe("ok");
      const final = await partnerIds();
      expect([forward, backward]).toContainEqual(final);
      const sorts = [...(await stamps()).values()].map((row) => row.sort).sort((a, b) => a - b);
      expect(sorts).toEqual(ids.map((_, index) => index));
    });

    it("чужой список, несуществующий и пропавший id — несоответствие, sort в базе прежние", async () => {
      const actor = await account();
      const { ids } = await preparedGroup();
      const before = await stamps();
      const dailySeed = catalog.find((task) => task.period === "daily" && task.kind === "runs");
      if (dailySeed === undefined) throw new Error("в каталоге нет ежедневной цели забега");

      for (const attempt of [[...ids, "it_no_such_task"], [...ids.slice(1)], [...ids.slice(1), dailySeed.taskId], [...ids, ids[0] ?? ""]]) {
        expect(await repository.reorder("partner", attempt, actor, new Date("2026-10-30T15:00:00Z"))).toEqual({ status: "mismatch" });
      }
      expect(await stamps()).toEqual(before);
    });

    it("строка с неизвестным серверу видом не входит в состав и не переписывается", async () => {
      const actor = await account();
      const unknownId = `it_ord_unknown_${String(Date.now())}_${String(runNo++)}`;
      await prisma.$executeRaw`
        INSERT INTO task_def (task_id, period, kind, target, coins, gems, shards, sort, created_at, updated_at)
        VALUES (${unknownId}, 'achievement'::"TaskPeriod", 'zzz_future', 1, 5, 0, 0, 5, ${STAMP}, ${STAMP})`;
      const known = (await repository.catalog()).filter((task) => task.period === "achievement" && task.kind !== "link" && task.kind !== "bot" && task.kind !== "channel").sort((a, b) => a.sort - b.sort || a.taskId.localeCompare(b.taskId));
      const ids = known.map((task) => task.taskId);
      const swapped = [...ids];
      const last = swapped.length - 1;
      [swapped[last - 1], swapped[last]] = [swapped[last] ?? "", swapped[last - 1] ?? ""];

      expect(await repository.reorder("achievement", [...ids, unknownId], actor, new Date("2026-10-30T16:00:00Z"))).toEqual({ status: "mismatch" });
      expect(await repository.reorder("achievement", swapped, actor, new Date("2026-10-30T16:00:01Z"))).toMatchObject({ status: "ok", changed: true });

      const [row] = await prisma.$queryRaw<{ sort: number; updated_at: Date }[]>`SELECT sort, updated_at FROM task_def WHERE task_id = ${unknownId}`;
      expect(row?.sort).toBe(5);
      expect(row?.updated_at.getTime()).toBe(STAMP.getTime());
    });
  });

  describe("ротация пула", () => {
    function tasksService(): TasksService {
      const wallet = { grant: async (input: { amount: number }) => ({ credited: input.amount, balance: 0, duplicate: false }) } as unknown as WalletService;
      const unused = {} as never;
      return new TasksService(repository, wallet, new RunsHooks(), unused, unused, unused, unused);
    }

    async function player(): Promise<AccountRef> {
      const accountId = await account();
      return { accountId, platform: "telegram", platformUserId: "1" };
    }

    function finished(accountId: string): RecordedRun {
      return {
        runId: runId(),
        accountId,
        difficulty: "easy",
        outcome: "died",
        survivalSec: 400,
        level: 22,
        enemiesKilled: 400,
        startingWeaponId: "spark",
        weapons: [{ id: "spark", level: 3 }],
        boosts: ["fury"],
        xpCollected: 600,
        counters: null,
        deathCause: null,
        cheats: false,
        continues: 0,
        ranked: true,
        verdict: "ok",
        reasons: [],
        finishedAt: NOON,
      };
    }

    const chosenDaily = (at: Date) => pickPool(catalog, "daily", gameDayOf(at));
    const chosenWeekly = (at: Date) => pickPool(catalog, "weekly", gameWeekStartOf(at));
    const pooled = (id: string) => catalog.some((task) => task.taskId === id && task.tier !== null);

    it("забег игрока двигает только выбранные на этот день задания пула", async () => {
      const service = tasksService();
      const me = await player();
      await service.onRun(finished(me.accountId));

      const moved = (await repository.progress(me.accountId, NOON)).map((row) => row.taskId).filter(pooled);
      expect(moved.length).toBeGreaterThan(0);
      const allowed = new Set([...chosenDaily(NOON), ...chosenWeekly(NOON)]);
      for (const id of moved) expect(allowed.has(id), `${id} не в ротации`).toBe(true);
      // невыбранные дневные остаются без строки прогресса
      const idle = catalog.filter((task) => task.period === "daily" && task.tier !== null && !chosenDaily(NOON).has(task.taskId));
      expect(idle.length).toBe(23);
      for (const task of idle) expect(moved).not.toContain(task.taskId);
    });

    it("невыбранное нельзя забрать запросом; новые виды двигаются забегом", async () => {
      const service = tasksService();
      const me = await player();
      await service.onRun(finished(me.accountId));
      const chosen = chosenDaily(NOON);
      const unchosen = catalog.find((task) => task.period === "daily" && task.tier !== null && !chosen.has(task.taskId));
      await expect(service.claim(me, unchosen?.taskId ?? "", NOON)).rejects.toBeInstanceOf(TaskNotFoundError);

      // опыт, оружие и буст из итога — своими видами (каждое из шести, что выбрано сегодня или на неделе)
      const view = await service.view(me, NOON);
      const kinds = new Set(view.map((task) => task.kind));
      expect(kinds.size).toBeGreaterThan(1);
      for (const task of view.filter((candidate) => ["xp_collected", "boost_runs"].includes(candidate.kind))) expect(task.value, task.id).toBeGreaterThan(0);
      for (const task of view) expect(task.category, task.id).not.toBe("partner");
    });

    it("квоты ротации прежние: 5 в день (2/2/1) и 6 в неделю (2/3/1), хотя пул вырос", () => {
      const tiersOf = (ids: Set<string>, period: "daily" | "weekly") =>
        POOL_TIERS.map((tier) => catalog.filter((task) => task.period === period && task.tier === tier && ids.has(task.taskId)).length);
      for (let day = 0; day < 20; day++) {
        const at = new Date(NOON.getTime() + day * 86_400_000);
        const daily = chosenDaily(at);
        const weekly = chosenWeekly(at);
        expect(daily.size).toBe(5);
        expect(tiersOf(daily, "daily")).toEqual([2, 2, 1]);
        expect(weekly.size).toBe(6);
        expect(tiersOf(weekly, "weekly")).toEqual([2, 3, 1]);
      }
    });

    /** Первые сутки, в которые выбран нужный дневной набор строк: сид — день, так что ищем день, а не подставляем строку. */
    function dayChoosing(taskId: string): Date {
      for (let day = 0; day < 400; day++) {
        const at = new Date(NOON.getTime() + day * 86_400_000);
        if (chosenDaily(at).has(taskId)) return at;
      }
      throw new Error(`${taskId} не выбирается ни в один из 400 дней`);
    }

    it("счётчики T-0125 двигают выбранное: элиты — daily_elite_3 до цели; забег без счётчиков и с читами — ничего; повтор забега не удваивает", async () => {
      const service = tasksService();
      const at = dayChoosing("daily_elite_3");
      const newIds = ["daily_elite_3", "daily_boss_1", "daily_chest_3", "daily_crystals_1000", "daily_evolution", "daily_elite_1", "daily_chest_1", "daily_crystals_300"];
      const valueOf = async (who: AccountRef, id: string) => (await service.view(who, at)).find((task) => task.id === id)?.value ?? 0;
      const counters = { bossKills: 0, eliteKills: 3, chestsOpened: 0, rareChests: 0, crystals: 0, noHitSec: 0, noKillSec: 0, killsByElement: {} };

      const me = await player();
      const good = { ...finished(me.accountId), finishedAt: at, counters };
      await service.onRun(good);
      expect(await valueOf(me, "daily_elite_3")).toBe(3);
      // повтор того же runId прогресс не удваивает
      await service.onRun(good);
      expect(await valueOf(me, "daily_elite_3")).toBe(3);

      // без счётчиков новые виды стоят
      const old = await player();
      await service.onRun({ ...finished(old.accountId), finishedAt: at, counters: null });
      for (const id of newIds) expect(await valueOf(old, id), `${id}: без счётчиков`).toBe(0);

      // с читами забег не двигает вообще
      const cheater = await player();
      await service.onRun({ ...finished(cheater.accountId), finishedAt: at, counters, cheats: true });
      for (const id of newIds) expect(await valueOf(cheater, id), `${id}: чит`).toBe(0);
    });

    it("два игрока видят один набор, а на следующих сутках набор другой", async () => {
      const service = tasksService();
      const [first, second] = [await player(), await player()];
      const ids = async (who: AccountRef, at: Date) =>
        (await service.view(who, at))
          .filter((task) => pooled(task.id))
          .map((task) => task.id)
          .sort();
      expect(await ids(first, NOON)).toEqual(await ids(second, NOON));
      expect(await ids(first, NOON)).toEqual([...chosenDaily(NOON), ...chosenWeekly(NOON)].sort());

      const sets = new Set<string>();
      for (let day = 0; day < 10; day++) sets.add((await ids(first, new Date(NOON.getTime() + day * 86_400_000))).join(","));
      expect(sets.size).toBeGreaterThan(1);
    });

    it("знак меню не считает выполненное невыбранное", async () => {
      const service = tasksService();
      const me = await player();
      const chosen = chosenDaily(NOON);
      const unchosen = catalog.find((task) => task.period === "daily" && task.tier !== null && !chosen.has(task.taskId));
      if (unchosen === undefined) throw new Error("в пуле нет невыбранной строки");
      await repository.applyRun({
        runId: runId(),
        accountId: me.accountId,
        at: NOON,
        deltas: [{ taskId: unchosen.taskId, period: "daily", target: unchosen.target, op: "sum", amount: unchosen.target }],
      });
      expect((await repository.progress(me.accountId, NOON)).some((row) => row.taskId === unchosen.taskId && row.done)).toBe(true);
      expect(await service.badge(me.accountId, NOON)).toBe(0);
    });

    it("границы суток и недели в коде совпадают с базой", async () => {
      const edges = ["2026-10-13T20:59:59Z", "2026-10-13T21:00:00Z", "2026-10-18T20:59:59Z", "2026-10-18T21:00:00Z", "2026-10-04T20:59:59Z", "2026-10-04T21:00:00Z"].map((iso) => new Date(iso));
      for (const at of edges) {
        const [row] = await prisma.$queryRaw<{ day: string; week: string }[]>`
          SELECT ${periodStartSql(Prisma.sql`'daily'::text`, at)}::text AS day, ${periodStartSql(Prisma.sql`'weekly'::text`, at)}::text AS week`;
        expect(gameDayOf(at), at.toISOString()).toBe(row?.day);
        expect(gameWeekStartOf(at), at.toISOString()).toBe(row?.week);
      }
    });
  });
});
