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
import { NetworkTasksService } from "../src/modules/tasks/network-tasks.service.js";
import { POINT_PERIODS, POINT_STEPS, pointsView, readyCount, stepOf, stepStates, type PointsView } from "../src/modules/tasks/task-points.js";
import { TaskPointsNotReachedError, TaskPointsStepNotFoundError } from "../src/modules/tasks/tasks-errors.js";
import { TasksController } from "../src/modules/tasks/tasks.controller.js";
import { TasksService } from "../src/modules/tasks/tasks.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";

// Очки заданий (docs/39-retention-mechanics.md П2, Р102, tasks/T-0105): таблица
// ступеней дня и недели — константа кода; состояние ступени считает чистая
// функция; ручки — тонкая оболочка над сервисом.

const NONE = new Set<number>();

describe("таблица ступеней", () => {
  it("день — 20, 50, 100 очков; неделя — 150, 400, 700: пороги и награды стартовые, ровно как в задаче", () => {
    expect(POINT_STEPS.daily.map((step) => step.points)).toEqual([20, 50, 100]);
    expect(POINT_STEPS.weekly.map((step) => step.points)).toEqual([150, 400, 700]);
    expect(POINT_STEPS.daily.map((step) => step.reward)).toEqual([
      { coins: 40, gems: 0, shards: 0 },
      { coins: 80, gems: 0, shards: 0 },
      { coins: 150, gems: 0, shards: 3 },
    ]);
    expect(POINT_STEPS.weekly.map((step) => step.reward)).toEqual([
      { coins: 150, gems: 0, shards: 0 },
      { coins: 300, gems: 0, shards: 5 },
      { coins: 600, gems: 0, shards: 10 },
    ]);
  });

  it("пороги растут строго, награды не убывают ни в одной валюте, самоцветов нет", () => {
    for (const period of POINT_PERIODS) {
      const steps = POINT_STEPS[period];
      for (let index = 1; index < steps.length; index += 1) {
        const before = steps[index - 1];
        const step = steps[index];
        expect(step?.points, `${period} #${String(index)}`).toBeGreaterThan(before?.points ?? Infinity);
        expect(step?.reward.coins, `${period} монеты`).toBeGreaterThanOrEqual(before?.reward.coins ?? Infinity);
        expect(step?.reward.shards, `${period} осколки`).toBeGreaterThanOrEqual(before?.reward.shards ?? Infinity);
      }
      for (const step of steps) expect(step.reward.gems, `${period} ${String(step.points)}`).toBe(0);
    }
  });

  it("набор из пяти дневных даёт 100 очков, набор из шести недельных — 240: верхняя ступень достижима одним набором", () => {
    const quotas = { daily: [[2, 10], [2, 20], [1, 40]], weekly: [[2, 20], [3, 40], [1, 80]] } as const;
    const total = (period: "daily" | "weekly") => quotas[period].reduce((sum, [count, points]) => sum + count * points, 0);
    expect(total("daily")).toBe(100);
    expect(total("weekly")).toBe(240);
    expect(total("daily")).toBeGreaterThanOrEqual(POINT_STEPS.daily.at(-1)?.points ?? Infinity);
  });

  it("stepOf: ступень по порогу; несуществующего порога нет", () => {
    expect(stepOf("daily", 50)?.reward.coins).toBe(80);
    expect(stepOf("weekly", 700)?.reward).toEqual({ coins: 600, gems: 0, shards: 10 });
    expect(stepOf("daily", 30)).toBeUndefined();
    expect(stepOf("daily", 150)).toBeUndefined();
  });
});

describe("состояние ступеней", () => {
  const states = (period: "daily" | "weekly", total: number, claimed: ReadonlySet<number> = NONE) => stepStates(period, total, claimed).map((step) => step.state);

  it("ноль очков — три закрытые ступени с их порогами и наградами", () => {
    const steps = stepStates("daily", 0, NONE);
    expect(steps.map((step) => [step.points, step.state])).toEqual([
      [20, "locked"],
      [50, "locked"],
      [100, "locked"],
    ]);
    expect(steps[2]?.reward).toEqual({ coins: 150, gems: 0, shards: 3 });
  });

  it("19 очков — закрыта, 20 — готова: порог включительно", () => {
    expect(states("daily", 19)[0]).toBe("locked");
    expect(states("daily", 20)[0]).toBe("ready");
    expect(states("daily", 49)).toEqual(["ready", "locked", "locked"]);
    expect(states("daily", 50)).toEqual(["ready", "ready", "locked"]);
    expect(states("daily", 100)).toEqual(["ready", "ready", "ready"]);
    expect(states("weekly", 149)[0]).toBe("locked");
    expect(states("weekly", 150)[0]).toBe("ready");
  });

  it("забранная остаётся забранной — при большем счёте и при меньшем (задание из каталога выключили)", () => {
    expect(states("daily", 100, new Set([20]))).toEqual(["claimed", "ready", "ready"]);
    expect(states("daily", 10, new Set([20]))).toEqual(["claimed", "locked", "locked"]);
  });

  it("забранный порог, которого в таблице нет, ничего не меняет", () => {
    expect(states("daily", 60, new Set([30, 999]))).toEqual(["ready", "ready", "locked"]);
  });

  it("очки не бывают отрицательными: меньше нуля читается как нуль", () => {
    expect(states("daily", -5)).toEqual(["locked", "locked", "locked"]);
  });
});

describe("полоса дня и недели", () => {
  it("pointsView собирает обе полосы: сумма и ступени каждой", () => {
    const view = pointsView({ daily: 55, weekly: 160 }, { daily: new Set([20]), weekly: NONE });
    expect(view.daily.total).toBe(55);
    expect(view.daily.steps.map((step) => step.state)).toEqual(["claimed", "ready", "locked"]);
    expect(view.weekly.total).toBe(160);
    expect(view.weekly.steps.map((step) => step.state)).toEqual(["ready", "locked", "locked"]);
  });

  it("readyCount — готовые к забору ступени обеих полос; забранные и закрытые не считаются", () => {
    expect(readyCount(pointsView({ daily: 0, weekly: 0 }, { daily: NONE, weekly: NONE }))).toBe(0);
    expect(readyCount(pointsView({ daily: 55, weekly: 160 }, { daily: new Set([20]), weekly: NONE }))).toBe(2);
    expect(readyCount(pointsView({ daily: 100, weekly: 700 }, { daily: NONE, weekly: NONE }))).toBe(6);
    expect(readyCount(pointsView({ daily: 100, weekly: 700 }, { daily: new Set([20, 50, 100]), weekly: new Set([150, 400, 700]) }))).toBe(0);
  });
});

describe("очки заданий по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;
  const ME = "00000000-0000-4000-8000-0000000000aa";
  const VIEW: PointsView = pointsView({ daily: 30, weekly: 30 }, { daily: NONE, weekly: NONE });

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(tasks: Record<string, unknown>): Promise<Record<string, string>> {
    @Module({
      controllers: [TasksController],
      providers: [
        { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv) },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: TasksService, useValue: tasks },
        { provide: NetworkTasksService, useValue: { view: async () => [] } },
        RateLimiter,
        AuthGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const token = await signAccessToken({ accountId: ME, platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    return { authorization: `Bearer ${token}` };
  }

  it("GET /tasks несёт points рядом с заданиями; у сервиса без очков поля нет", async () => {
    const headers = await start({ view: async () => [], pointsView: async () => VIEW });
    const response = await app?.inject({ method: "GET", url: "/api/v1/tasks", headers });
    const data = response?.json<{ data: { tasks: unknown[]; networks: unknown[]; points: PointsView } }>().data;
    expect(response?.statusCode).toBe(200);
    expect(data?.points.daily.total).toBe(30);
    expect(data?.points.daily.steps.map((step) => step.state)).toEqual(["ready", "locked", "locked"]);
    expect(data?.points.weekly.steps[0]).toEqual({ points: 150, reward: { coins: 150, gems: 0, shards: 0 }, state: "locked" });

    await app?.close();
    const bare = await start({ view: async () => [], pointsView: async () => null });
    const without = await app?.inject({ method: "GET", url: "/api/v1/tasks", headers: bare });
    expect(without?.json<{ data: Record<string, unknown> }>().data).not.toHaveProperty("points");
  });

  it("забор ступени: период и порог — из адреса; без токена 401; кривой период и порог — 400, сервис не зовётся", async () => {
    const calls: [string, number][] = [];
    const headers = await start({
      view: async () => [],
      pointsView: async () => VIEW,
      claimPoints: async (_account: unknown, period: string, points: number) => {
        calls.push([period, points]);
        return { claimed: true, credited: { coins: 40, gems: 0, shards: 0 }, points };
      },
    });

    expect((await app?.inject({ method: "POST", url: "/api/v1/tasks/points/daily/20/claim" }))?.statusCode).toBe(401);
    const claimed = await app?.inject({ method: "POST", url: "/api/v1/tasks/points/daily/20/claim", headers });
    expect(claimed?.statusCode).toBe(200);
    expect(claimed?.json()).toEqual({ data: { claimed: true, credited: { coins: 40, gems: 0, shards: 0 }, points: 20 } });
    expect(calls).toEqual([["daily", 20]]);

    for (const url of [
      "/api/v1/tasks/points/achievement/20/claim",
      "/api/v1/tasks/points/monthly/20/claim",
      "/api/v1/tasks/points/daily/abc/claim",
      "/api/v1/tasks/points/daily/-5/claim",
      "/api/v1/tasks/points/daily/0/claim",
      "/api/v1/tasks/points/daily/20.5/claim",
      "/api/v1/tasks/points/daily/99999999999/claim",
    ]) {
      expect((await app?.inject({ method: "POST", url, headers }))?.statusCode, url).toBe(400);
    }
    expect(calls).toHaveLength(1);
  });

  it("отказы сервиса доходят с кодом: не хватает очков — 409 task_points_not_reached, нет ступени — 404 task_points_step_not_found", async () => {
    const headers = await start({
      view: async () => [],
      pointsView: async () => VIEW,
      claimPoints: async (_account: unknown, _period: string, points: number) => {
        if (points === 30) throw new TaskPointsStepNotFoundError();
        throw new TaskPointsNotReachedError();
      },
    });

    const notReached = await app?.inject({ method: "POST", url: "/api/v1/tasks/points/daily/50/claim", headers });
    expect(notReached?.statusCode).toBe(409);
    expect(notReached?.json<{ error: { code: string } }>().error.code).toBe("task_points_not_reached");
    const missing = await app?.inject({ method: "POST", url: "/api/v1/tasks/points/daily/30/claim", headers });
    expect(missing?.statusCode).toBe(404);
    expect(missing?.json<{ error: { code: string } }>().error.code).toBe("task_points_step_not_found");
  });
});
