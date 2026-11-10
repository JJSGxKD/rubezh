import "reflect-metadata";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";
import { CLIENT_KINDS, SIGNAL_LIMIT, isClientKind } from "../src/modules/tasks/client-signal-rules.js";
import { TaskSignalsController } from "../src/modules/tasks/task-signals.controller.js";
import { TaskSignalsService } from "../src/modules/tasks/task-signals.service.js";
import { NO_ACHIEVEMENT_FIELDS, taskDefSchema } from "../src/modules/tasks/task-rules.js";
import { TaskNotFoundError } from "../src/modules/tasks/tasks-errors.js";
import type { TasksRepository } from "../src/modules/tasks/tasks.repository.js";
import type { TaskView, TasksService } from "../src/modules/tasks/tasks.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";

/**
 * Задания по сигналу клиента (docs/35-stage4-plan.md Р187, T-0375): схема
 * строки каталога, лимит и ошибки маршрута, поведение сервиса на заглушках.
 * Живая база — в `task-signals.integration.test.ts`.
 */

const ME = "00000000-0000-4000-8000-00000000f375";
const PLAYER: AccountRef = { accountId: ME, platform: "telegram", platformUserId: "555000375" };
const NOW = new Date(Date.UTC(2026, 10, 9, 9));

/** Строка каталога в том виде, в каком её шлёт панель. */
function row(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: "ach_home_screen",
    period: "achievement",
    kind: "home_screen",
    params: null,
    target: 1,
    title: null,
    coins: 50,
    gems: 0,
    shards: 0,
    passPoints: 0,
    active: true,
    tier: null,
    filter: null,
    limit: null,
    image: null,
    ...NO_ACHIEVEMENT_FIELDS,
    category: "collection",
    ...patch,
  };
}

function story(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return row({ taskId: "weekly_story", period: "weekly", kind: "story_share", category: null, ...patch });
}

function problems(input: Record<string, unknown>): { message: string; path: PropertyKey[] }[] {
  const result = taskDefSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => ({ message: issue.message, path: issue.path }));
}

function messages(input: Record<string, unknown>): string[] {
  return problems(input).map((issue) => issue.message);
}

describe("виды по сигналу клиента: схема каталога", () => {
  it("главный экран: достижение с категорией и целью 1 годится", () => {
    expect(taskDefSchema.safeParse(row()).success).toBe(true);
  });

  it("главный экран: недельный срок — отказ на поле срока", () => {
    expect(problems(row({ period: "weekly", category: null }))).toContainEqual({ message: "главный экран — только достижение", path: ["period"] });
  });

  it("главный экран: без категории витрина задание не покажет", () => {
    expect(problems(row({ category: null }))).toContainEqual({
      message: "у достижения «главный экран» нужна категория — без неё витрина его не покажет",
      path: ["category"],
    });
  });

  it("история: недельное с целью 1 годится", () => {
    expect(taskDefSchema.safeParse(story()).success).toBe(true);
  });

  it("история: дневной срок — отказ", () => {
    expect(problems(story({ period: "daily" }))).toContainEqual({ message: "история — только недельное", path: ["period"] });
  });

  it("история: достижением тоже нельзя", () => {
    expect(messages(story({ period: "achievement" }))).toContain("история — только недельное");
  });

  it("история: ступень, фильтр, лимит и картинка — не у этого задания", () => {
    const message = "ступень, фильтр, лимит и картинка — не у этого задания";
    expect(problems(story({ tier: "easy" }))).toContainEqual({ message, path: ["tier"] });
    expect(problems(story({ filter: { weapon: "spark" } }))).toContainEqual({ message, path: ["filter"] });
    expect(problems(story({ limit: 100 }))).toContainEqual({ message, path: ["limit"] });
    expect(problems(story({ image: "a".repeat(32) }))).toContainEqual({ message, path: ["image"] });
  });

  it("главный экран: ступень у достижения тоже отклоняется", () => {
    expect(messages(row({ tier: "easy" }))).toContain("ступень, фильтр, лимит и картинка — не у этого задания");
  });

  it("цель у обоих видов — только 1", () => {
    expect(problems(story({ target: 3 }))).toContainEqual({ message: "у этого задания цель — 1", path: ["target"] });
    expect(problems(row({ target: 2 }))).toContainEqual({ message: "у этого задания цель — 1", path: ["target"] });
  });

  it("ссылка партнёра у этих видов не нужна — прежняя ошибка про ссылку", () => {
    expect(problems(row({ params: { url: "https://example.com/p" } }))).toContainEqual({ message: "ссылка — у партнёрской цели, и только у неё", path: ["params"] });
  });

  it("очки пасса недельной истории — как у любого недельного", () => {
    expect(taskDefSchema.safeParse(story({ passPoints: 5 })).success).toBe(true);
  });
});

describe("правила сигнала", () => {
  it("вид клиента узнаётся, остальные — нет", () => {
    expect(isClientKind("story_share")).toBe(true);
    expect(isClientKind("home_screen")).toBe(true);
    expect(isClientKind("channel")).toBe(false);
    expect(isClientKind("runs")).toBe(false);
    expect(isClientKind("toString")).toBe(false);
    expect(isClientKind("__proto__")).toBe(false);
  });

  it("срок закреплён за видом, лимит — 20 в час", () => {
    expect(CLIENT_KINDS.home_screen.period).toBe("achievement");
    expect(CLIENT_KINDS.story_share.period).toBe("weekly");
    expect(SIGNAL_LIMIT).toEqual({ scope: "tasks_signal", limit: 20, windowSec: 3600 });
  });
});

function view(id: string, patch: Partial<TaskView> = {}): TaskView {
  return {
    id,
    period: "achievement",
    category: "achievement",
    kind: "home_screen",
    title: null,
    target: 1,
    value: 0,
    done: false,
    claimed: false,
    reward: { coins: 50, gems: 0, shards: 0 },
    passPoints: 0,
    link: null,
    slots: null,
    image: null,
    tier: null,
    filter: null,
    achievementCategory: "collection",
    ladder: null,
    rung: null,
    prestige: 0,
    hidden: false,
    ...patch,
  };
}

/** Заглушки: что видит игрок и что записал репозиторий. */
function stubs(tasks: TaskView[]) {
  const completed: { accountId: string; taskId: string; period: string; target: number; at: Date; graceSince: Date }[] = [];
  const state = { tasks };
  const service = {
    view: async () => state.tasks.map((task) => ({ ...task })),
  } as unknown as TasksService;
  const repository = {
    complete: async (accountId: string, task: { taskId: string; period: string; target: number }, at: Date, graceSince: Date) => {
      completed.push({ accountId, taskId: task.taskId, period: task.period, target: task.target, at, graceSince });
      state.tasks = state.tasks.map((candidate) => (candidate.id === task.taskId ? { ...candidate, done: true, value: candidate.target } : candidate));
      return { taskId: task.taskId, periodStart: "2026-11-09", value: task.target, done: true, claimed: false };
    },
  } as unknown as TasksRepository;
  return { signals: new TaskSignalsService(service, repository), completed, state };
}

describe("сервис сигнала", () => {
  it("выполняет невыполненное задание вида и возвращает свежий список", async () => {
    const { signals, completed } = stubs([view("ach_home_screen"), view("daily_runs", { kind: "runs", period: "daily", target: 3 })]);
    const result = await signals.signal(PLAYER, "home_screen", NOW);
    expect(completed).toEqual([{ accountId: ME, taskId: "ach_home_screen", period: "achievement", target: 1, at: NOW, graceSince: NOW }]);
    expect(result.tasks.find((task) => task.id === "ach_home_screen")?.done).toBe(true);
    expect(result.tasks.find((task) => task.id === "daily_runs")?.done).toBe(false);
  });

  it("повторный сигнал в том же сроке ничего не пишет", async () => {
    const { signals, completed } = stubs([view("weekly_story", { kind: "story_share", period: "weekly", done: true, value: 1 })]);
    const result = await signals.signal(PLAYER, "story_share", NOW);
    expect(completed).toEqual([]);
    expect(result.tasks).toHaveLength(1);
  });

  it("задания вида среди видимых нет — 404", async () => {
    const { signals, completed } = stubs([view("daily_runs", { kind: "runs", period: "daily", target: 3 })]);
    await expect(signals.signal(PLAYER, "story_share", NOW)).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(completed).toEqual([]);
  });

  it("сигнал одного вида не трогает задание другого вида", async () => {
    const { signals, completed } = stubs([view("ach_home_screen"), view("weekly_story", { kind: "story_share", period: "weekly" })]);
    await signals.signal(PLAYER, "story_share", NOW);
    expect(completed.map((item) => item.taskId)).toEqual(["weekly_story"]);
  });
});

describe("маршрут сигнала по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(calls: { kind: string; accountId: string }[]): Promise<{ http: NestFastifyApplication; headers: Record<string, string> }> {
    const signals = {
      signal: async (account: AccountRef, kind: string) => {
        calls.push({ kind, accountId: account.accountId });
        return { tasks: [] };
      },
    };
    @Module({
      controllers: [TaskSignalsController],
      providers: [
        { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv) },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: TaskSignalsService, useValue: signals },
        RateLimiter,
        AuthGuard,
      ],
    })
    class TestModule {}
    const http = await createHttpApp(TestModule, { logger: false });
    app = http;
    await http.init();
    await http.getHttpAdapter().getInstance().ready();
    const token = await signAccessToken({ accountId: ME, platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    return { http, headers: { authorization: `Bearer ${token}` } };
  }

  it("без токена — 401; неизвестное действие — 400 с текстом; известное — 200 со списком", async () => {
    const calls: { kind: string; accountId: string }[] = [];
    const { http, headers } = await start(calls);
    expect((await http.inject({ method: "POST", url: "/api/v1/tasks/signals/home_screen" })).statusCode).toBe(401);

    const unknown = await http.inject({ method: "POST", url: "/api/v1/tasks/signals/teleport", headers });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json<{ error: { message: string } }>().error.message).toBe("Неизвестное действие");

    const ok = await http.inject({ method: "POST", url: "/api/v1/tasks/signals/home_screen", headers, payload: { reward: 9999 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ data: { tasks: [] } });
    expect(calls).toEqual([{ kind: "home_screen", accountId: ME }]);
  });

  it("двадцать сигналов в час проходят, двадцать первый — 429", async () => {
    const calls: { kind: string; accountId: string }[] = [];
    const { http, headers } = await start(calls);
    for (let index = 0; index < SIGNAL_LIMIT.limit; index++) {
      expect((await http.inject({ method: "POST", url: "/api/v1/tasks/signals/story_share", headers })).statusCode).toBe(200);
    }
    const limited = await http.inject({ method: "POST", url: "/api/v1/tasks/signals/story_share", headers });
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ error: { message: string } }>().error.message).toBe("Слишком часто — попробуй позже");
    expect(calls).toHaveLength(SIGNAL_LIMIT.limit);
  });
});
