import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";
import { TaskSignalsService } from "../src/modules/tasks/task-signals.service.js";
import { NO_ACHIEVEMENT_FIELDS, type TaskDef } from "../src/modules/tasks/task-rules.js";
import { TaskNotFoundError } from "../src/modules/tasks/tasks-errors.js";
import { PrismaTasksRepository } from "../src/modules/tasks/tasks.repository.js";
import { TasksService } from "../src/modules/tasks/tasks.service.js";
import type { GrantInput, WalletService } from "../src/modules/wallet/wallet.service.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Задания по сигналу клиента на живом Postgres (T-0375; адрес —
 * TEST_DATABASE_URL, без него пропуск): сигнал выполняет текущий срок
 * задания, повтор и гонка дают одну строку прогресса, неделя считается по
 * Москве, награда — обычным забором.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
/** понедельник, 09.11.2026, 12:00 по Москве */
const MONDAY = new Date(Date.UTC(2026, 10, 9, 9));
const WEDNESDAY = new Date(Date.UTC(2026, 10, 11, 9));
const NEXT_MONDAY = new Date(Date.UTC(2026, 10, 16, 9));
const STAMP = new Date("2026-11-01T00:00:00Z");

describe.skipIf(DATABASE_URL === "")("сигнал клиента на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let repository: PrismaTasksRepository;
  let actor: string;
  let seq = 0;

  const grants: GrantInput[] = [];
  const seen = new Set<string>();
  const wallet = {
    grant: async (input: GrantInput) => {
      const duplicate = seen.has(input.idempotencyKey);
      if (!duplicate) {
        seen.add(input.idempotencyKey);
        grants.push(input);
      }
      return { credited: duplicate ? 0 : input.amount, balance: 0, duplicate };
    },
  } as unknown as WalletService;

  async function account(): Promise<AccountRef> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(930_000_000 + Math.floor(Math.random() * 30_000_000)), displayName: "Сигнал", username: null },
      Date.now(),
    );
    return { accountId: created.accountId, platform: "telegram", platformUserId: created.platformUserId };
  }

  function def(patch: Partial<TaskDef>): TaskDef {
    seq += 1;
    return {
      taskId: `it_sig_${String(Date.now())}_${String(seq)}`,
      period: "achievement",
      kind: "home_screen",
      params: null,
      filter: null,
      tier: null,
      target: 1,
      title: null,
      coins: 40,
      gems: 0,
      shards: 0,
      passPoints: 0,
      sort: 0,
      active: true,
      limit: null,
      image: null,
      ...NO_ACHIEVEMENT_FIELDS,
      category: "collection",
      ...patch,
    };
  }

  /** Свежие сервисы на каждый тест: каталог в памяти сервиса живёт полминуты. */
  function services(): { tasks: TasksService; signals: TaskSignalsService } {
    const unused = {} as never;
    const tasks = new TasksService(repository, wallet, new RunsHooks(), unused, unused, unused, unused);
    return { tasks, signals: new TaskSignalsService(tasks, repository) };
  }

  async function weekly(patch: Partial<TaskDef> = {}): Promise<TaskDef> {
    const task = def({ period: "weekly", kind: "story_share", category: null, coins: 30, ...patch });
    expect(await repository.insert(task, actor, STAMP)).toBe(true);
    return task;
  }

  async function achievement(patch: Partial<TaskDef> = {}): Promise<TaskDef> {
    const task = def(patch);
    expect(await repository.insert(task, actor, STAMP)).toBe(true);
    return task;
  }

  async function rows(accountId: string, taskId: string): Promise<{ period_start: string; done: boolean }[]> {
    return await prisma.$queryRaw<{ period_start: string; done: boolean }[]>`
      SELECT period_start::text, completed_at IS NOT NULL AS done FROM task_progress
      WHERE account_id = ${accountId}::uuid AND task_id = ${taskId} ORDER BY period_start`;
  }

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 10);
    accounts = new PrismaAccountRepository(prisma);
    repository = new PrismaTasksRepository(prisma);
    actor = (await account()).accountId;
  });

  // Строки этих тестов выключаются перед каждым: в каталоге живой базы должны быть только свои.
  beforeEach(async () => {
    await prisma.$executeRaw`UPDATE task_def SET active = false WHERE task_id LIKE 'it\_sig\_%'`;
  });

  afterAll(async () => {
    await prisma.$executeRaw`UPDATE task_def SET active = false WHERE task_id LIKE 'it\_sig\_%'`;
    await prisma.$disconnect();
  });

  it("home_screen: сигнал выполняет достижение, забор платит один раз", async () => {
    const task = await achievement();
    const me = await account();
    const { tasks, signals } = services();

    const result = await signals.signal(me, "home_screen", MONDAY);
    expect(result.tasks.find((item) => item.id === task.taskId)).toMatchObject({ done: true, claimed: false, value: 1 });
    expect(await rows(me.accountId, task.taskId)).toEqual([{ period_start: "2000-01-01", done: true }]);

    const claimed = await tasks.claim(me, task.taskId, MONDAY);
    expect(claimed).toMatchObject({ claimed: true, credited: { coins: 40, gems: 0, shards: 0 } });

    await signals.signal(me, "home_screen", WEDNESDAY);
    const again = await tasks.claim(me, task.taskId, WEDNESDAY);
    expect(again).toMatchObject({ claimed: false, credited: { coins: 0, gems: 0, shards: 0 } });
    expect(grants.filter((grant) => grant.source === `task:${task.taskId}`)).toHaveLength(1);
    expect(await rows(me.accountId, task.taskId)).toHaveLength(1);
  });

  it("story_share: неделя — одна строка, следующая неделя — новая и платит снова", async () => {
    const task = await weekly();
    const me = await account();
    const { tasks, signals } = services();

    await signals.signal(me, "story_share", MONDAY);
    await signals.signal(me, "story_share", WEDNESDAY);
    expect(await rows(me.accountId, task.taskId)).toEqual([{ period_start: "2026-11-09", done: true }]);
    expect((await tasks.claim(me, task.taskId, WEDNESDAY)).credited.coins).toBe(30);

    const next = await signals.signal(me, "story_share", NEXT_MONDAY);
    expect(next.tasks.find((item) => item.id === task.taskId)).toMatchObject({ done: true, claimed: false });
    expect(await rows(me.accountId, task.taskId)).toEqual([
      { period_start: "2026-11-09", done: true },
      { period_start: "2026-11-16", done: true },
    ]);
    expect((await tasks.claim(me, task.taskId, NEXT_MONDAY)).credited.coins).toBe(30);
    expect(grants.filter((grant) => grant.source === `task:${task.taskId}`)).toHaveLength(2);
  });

  it("два сигнала разом — одна строка прогресса", async () => {
    const task = await achievement();
    const me = await account();
    const { signals } = services();
    await Promise.all([signals.signal(me, "home_screen", MONDAY), signals.signal(me, "home_screen", MONDAY), signals.signal(me, "home_screen", MONDAY)]);
    expect(await rows(me.accountId, task.taskId)).toEqual([{ period_start: "2000-01-01", done: true }]);
  });

  it("задания вида нет или оно выключено — 404, строка прогресса не появляется", async () => {
    const task = await weekly({ active: false });
    const me = await account();
    const { signals } = services();
    await expect(signals.signal(me, "story_share", MONDAY)).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(signals.signal(me, "home_screen", MONDAY)).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(await rows(me.accountId, task.taskId)).toEqual([]);
  });

  it("сигнал не трогает задания других видов", async () => {
    const home = await achievement();
    const story = await weekly();
    const me = await account();
    const { signals } = services();
    await signals.signal(me, "story_share", MONDAY);
    expect(await rows(me.accountId, story.taskId)).toHaveLength(1);
    expect(await rows(me.accountId, home.taskId)).toEqual([]);
    const [total] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM task_progress WHERE account_id = ${me.accountId}::uuid`;
    expect(total?.n).toBe(1);
  });
});
