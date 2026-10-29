import { randomUUID } from "node:crypto";
import { CONTENT_SNAPSHOT } from "@bh/core-game";
import type { BalanceRunResult } from "@bh/core-game/src/game/balance";
import { Queue, QueueEvents, type Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CheckResult } from "../src/check";
import { Metrics } from "../src/metrics";
import { CheckQueueBusyError, createCheckWorker, submitCheck } from "../src/queue";

/**
 * Очередь `content-check` на живом Redis (tasks/T-0302): настоящий BullMQ —
 * лимит пяти ждущих, обработка воркером с конкурентностью 1 и результат,
 * который читает сервер событием завершения. Без Redis — пропуск.
 */

/** Своя база Redis и своё имя очереди: чужие `flushdb` её не заденут, а мы чужого не тронем. */
function redisUrl(): string {
  const source = process.env.PLAYTEST_TEST_REDIS_URL ?? "";
  if (source === "") return "";
  const parsed = new URL(source);
  parsed.pathname = "/0";
  return parsed.toString();
}

const REDIS_URL = redisUrl();
const SNAPSHOT: unknown = JSON.parse(JSON.stringify(CONTENT_SNAPSHOT));

function fakeRun(seed: number): BalanceRunResult {
  return { seed, skill: "dodging", startingWeaponId: "w", survivalSec: 100 + seed, level: 3, wave: 2, enemiesKilled: 50, xpCollected: 10, peakEnemies: 9, firstLevelUpSec: 10, chestsFound: 1, chestsOpened: 1, evolutions: 0, timedOut: false };
}

describe.skipIf(REDIS_URL === "")("очередь проверок на живом Redis", () => {
  const clients: Redis[] = [];
  const closers: (() => Promise<void>)[] = [];
  let queueName = "";
  let queue: Queue;
  let events: QueueEvents;

  const connection = (): Redis => {
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    clients.push(redis);
    return redis;
  };

  beforeAll(() => {
    queueName = `content-check-test-${randomUUID()}`;
    queue = new Queue(queueName, { connection: connection() });
    events = new QueueEvents(queueName, { connection: connection() });
  });

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await events.close();
    await queue.close();
    for (const redis of clients) redis.disconnect();
  });

  const startWorker = (deps: Parameters<typeof createCheckWorker>[0]["deps"], metrics = new Metrics()): Worker => {
    const worker = createCheckWorker({ connection: connection(), queueName, metrics, deps });
    closers.push(() => worker.close());
    return worker;
  };

  const job = (checkId: string, extra: Record<string, unknown> = {}) => ({ checkId, snapshot: SNAPSHOT, baseSnapshot: SNAPSHOT, scenarios: [{ id: "a", skill: "dodging" as const, seeds: 2 }], ...extra });

  it("пять ждущих заданий принимаются, шестое отклоняется «Проверка уже идёт, дождитесь»", async () => {
    for (let index = 1; index <= 5; index += 1) await submitCheck(queue, job(`c-${String(index)}`));
    await expect(queue.getWaitingCount()).resolves.toBe(5);

    await expect(submitCheck(queue, job("c-6"))).rejects.toBeInstanceOf(CheckQueueBusyError);
    await expect(queue.getWaitingCount()).resolves.toBe(5);
  });

  it("воркер берёт задание, а результат уходит в ту же очередь: сервер читает его событием завершения", async () => {
    const metrics = new Metrics();
    startWorker({ simulate: (options) => fakeRun(options.seed) }, metrics);

    const id = await submitCheck(queue, job("c-ok"));
    const stored = await queue.getJob(id);
    const result = (await (stored as NonNullable<typeof stored>).waitUntilFinished(events, 30_000)) as CheckResult;

    expect(result.checkId).toBe("c-ok");
    expect(result.schemaProblems).toEqual([]);
    expect(result.report?.scenarios[0]?.draft?.survivalSec).toBe(102);
    expect(metrics.render()).toContain('sim_jobs_total{queue="content-check",outcome="ok"} 1');
  });

  it("испорченный снимок — не сбой задания, а результат со схемными проблемами; метрика — «invalid»", async () => {
    const metrics = new Metrics();
    startWorker({ simulate: (options) => fakeRun(options.seed) }, metrics);

    const id = await submitCheck(queue, job("c-bad", { snapshot: { schemaVersion: 1 } }));
    const stored = await queue.getJob(id);
    const result = (await (stored as NonNullable<typeof stored>).waitUntilFinished(events, 30_000)) as CheckResult;

    expect(result.report).toBeNull();
    expect(result.schemaProblems.length).toBeGreaterThan(0);
    expect(metrics.render()).toContain('sim_jobs_total{queue="content-check",outcome="invalid"} 1');
  });

  it("конкурентность — 1: два задания идут по очереди, а не вместе", async () => {
    let active = 0;
    let peak = 0;
    startWorker({
      simulate: (options) => fakeRun(options.seed),
      yieldToLoop: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      },
    });

    const ids = [await submitCheck(queue, job("c-1")), await submitCheck(queue, job("c-2"))];
    for (const id of ids) {
      const stored = await queue.getJob(id);
      await (stored as NonNullable<typeof stored>).waitUntilFinished(events, 30_000);
    }
    expect(peak).toBe(1);
  });

  it("задание с испорченной формой падает в очереди и считается ошибкой, воркер остаётся жив", async () => {
    const metrics = new Metrics();
    startWorker({ simulate: (options) => fakeRun(options.seed) }, metrics);

    // Мимо submitCheck, прямо в очередь: так выглядит задание от старого или чужого производителя.
    const broken = await queue.add("check", { checkId: "bad:id", snapshot: SNAPSHOT });
    await expect(broken.waitUntilFinished(events, 30_000)).rejects.toThrow();
    expect(metrics.render()).toContain('sim_jobs_total{queue="content-check",outcome="error"} 1');

    const id = await submitCheck(queue, job("c-after"));
    const stored = await queue.getJob(id);
    const result = (await (stored as NonNullable<typeof stored>).waitUntilFinished(events, 30_000)) as CheckResult;
    expect(result.checkId).toBe("c-after");
  });
});
