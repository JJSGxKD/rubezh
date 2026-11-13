import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CONTENT_HASH } from "@bh/core-game/src/content/hash";
import { CONTENT_SNAPSHOT, hashSnapshot, type ContentSnapshot } from "@bh/core-game/src/content/snapshot";
import type { BalanceRunResult } from "@bh/core-game/src/game/balance";
import { replaySteps, type ReplayOutcome } from "@bh/core-game/src/game/diagnostics/replay";
import { CHECKPOINT_TICKS } from "@bh/core-game/src/game/diagnostics/run-recorder";
import type { RunProof } from "@bh/core-game/src/run-api";
import { build } from "esbuild";
import { Queue, QueueEvents, type Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { circling } from "../../../packages/core-game/test/helpers/recorded-run";
import { runWithProof, type ProofRun } from "../../../packages/core-game/test/helpers/proof-run";
import type { CheckResult } from "../src/check";
import { Metrics } from "../src/metrics";
import { createCheckWorker } from "../src/queue";
import { createReplayWorker, replayJobSchema, REPLAY_LIMIT_MS, REPLAY_MAX_TICKS, REPLAY_QUEUE, runReplay, RunGate, type ReplayDeps, type ReplayResult } from "../src/replay-job";

// Повтор забега в воркере (docs/35-stage4-plan.md Р15, WP5, tasks/T-0318): задание
// `{ runId, proof, contentSnapshot, claimed }`, исход `{ verdict, divergedTick, replayed }`.
// Забег записан тем же способом, что в сцене (`runWithProof`), и проходит провод JSON, как по сети.

const SEED = 2;
const SLOW = { timeout: 120_000 };
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

let run: ProofRun;
let honest: RunProof;

beforeAll(() => {
  // Минута мира и ещё десять секунд: в записи одна контрольная сумма и несколько выборов улучшений.
  run = runWithProof({ seed: SEED, maxTicks: CHECKPOINT_TICKS + 600, steer: circling(300) });
  if (run.proof === null) throw new Error("записи для проверки нет: тест ошибся в сценарии");
  honest = run.proof;
}, 120_000);

/** Итог, который клиент заявил серверу: у честного забега он равен итогу записи. */
const claimedOf = (proof: RunProof) => ({
  survivalSec: proof.result.survivalSec,
  level: proof.result.level,
  enemiesKilled: proof.result.enemiesKilled,
  checksum: proof.result.checksum,
});

const jobOf = (proof: RunProof, extra: Record<string, unknown> = {}) => ({
  runId: proof.runId,
  proof: json(proof),
  contentSnapshot: null,
  claimed: claimedOf(proof),
  ...extra,
});

describe("повтор: честная запись", () => {
  it("повторяется до свёртки мира: match, итог повтора равен итогу записи", SLOW, async () => {
    const result = await runReplay(jobOf(honest));

    expect(result).toMatchObject({ runId: honest.runId, verdict: "match", reason: null, divergedTick: null });
    expect(result.replayed).toEqual({
      ticks: honest.result.ticks,
      survivalSec: honest.result.survivalSec,
      level: honest.result.level,
      enemiesKilled: honest.result.enemiesKilled,
      checksum: honest.result.checksum,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("повтор делится на части: управление отдаётся циклу событий, а исход тот же, что у цельного повтора", SLOW, async () => {
    let yields = 0;
    const result = await runReplay(jobOf(honest), {
      yieldToLoop: async () => {
        yields += 1;
      },
    });

    // 3 600 шагов минуты и 600 после: частей несколько, иначе очередь сочла бы долгий повтор зависшим.
    expect(yields).toBeGreaterThanOrEqual(2);
    expect(result.verdict).toBe("match");
  });

  it("тот же повтор дважды даёт тот же исход: воркер ничего не помнит между заданиями", SLOW, async () => {
    const first = await runReplay(jobOf(honest));
    const second = await runReplay(jobOf(honest));

    expect({ ...first, durationMs: 0 }).toEqual({ ...second, durationMs: 0 });
  });

  it("снимок контента, чей хэш равен хэшу записи, подаётся в мир: бой тот же — match", SLOW, async () => {
    // Другая версия контента, в которой забег без бустов идёт так же: сменился только хэш.
    const changed = json({ ...CONTENT_SNAPSHOT, maxBoostsPerRun: CONTENT_SNAPSHOT.maxBoostsPerRun + 1 }) as ContentSnapshot;
    const changedHash = hashSnapshot(changed);
    expect(changedHash).not.toBe(CONTENT_HASH);

    const result = await runReplay(jobOf({ ...honest, contentHash: changedHash }, { contentSnapshot: changed }));

    expect(result.verdict).toBe("match");
  });

  it("снимок и вправду берётся: другие числа контента — другой бой, расхождение на свёртке минуты", SLOW, async () => {
    const harder = json({ ...CONTENT_SNAPSHOT, enemies: CONTENT_SNAPSHOT.enemies.map((enemy) => ({ ...enemy, hp: enemy.hp * 4 })) }) as ContentSnapshot;
    const harderHash = hashSnapshot(harder);

    const result = await runReplay(jobOf({ ...honest, contentHash: harderHash }, { contentSnapshot: harder }));

    expect(result.verdict).toBe("mismatch");
    expect(result.divergedTick).toBe(CHECKPOINT_TICKS);
  });
});

describe("повтор: подмена", () => {
  it("выбор, которого не было в предложении, — mismatch с тиком выбора", SLOW, async () => {
    const [tick] = honest.choices[0];
    const tampered = { ...honest, choices: [[tick, "not_an_option"], ...honest.choices.slice(1)] };

    const result = await runReplay(jobOf(tampered as RunProof));

    expect(result.verdict).toBe("mismatch");
    expect(result.divergedTick).toBe(tick);
    expect(result.reason).toContain("not_an_option");
  });

  it("другой настоящий вариант вместо выбора — расхождение не раньше подменённого выбора", SLOW, async () => {
    const [tick, chosen] = honest.choices[0];
    const alternative = run.offers.find((offer) => offer.tick === tick)?.ids.find((id) => id !== chosen);
    expect(alternative).toBeDefined();

    const result = await runReplay(jobOf({ ...honest, choices: [[tick, alternative ?? ""], ...honest.choices.slice(1)] }));

    expect(result.verdict).toBe("mismatch");
    expect(result.divergedTick === null || result.divergedTick >= tick).toBe(true);
  });

  it("подменённая свёртка минуты — mismatch, а тик расхождения — тик этой свёртки", SLOW, async () => {
    const [tick, checksum] = honest.checkpoints[0];

    const result = await runReplay(jobOf({ ...honest, checkpoints: [[tick, checksum ^ 0x5a5a], ...honest.checkpoints.slice(1)] }));

    expect(result.verdict).toBe("mismatch");
    expect(result.divergedTick).toBe(tick);
  });
});

describe("повтор: заявленный итог", () => {
  it("завышенное время при совпавшем повторе — mismatch: итог разошёлся с заявленным, тика расхождения нет", SLOW, async () => {
    const result = await runReplay(jobOf(honest, { claimed: { ...claimedOf(honest), survivalSec: honest.result.survivalSec + 120 } }));

    expect(result.verdict).toBe("mismatch");
    expect(result.divergedTick).toBeNull();
    expect(result.reason).toContain("время");
    // Повтор честный: то, что он насчитал, сервер видит рядом с заявленным.
    expect(result.replayed?.survivalSec).toBe(honest.result.survivalSec);
  });

  const wrongClaims: [name: string, patch: (proof: RunProof) => Record<string, number>][] = [
    ["уровень", (proof) => ({ level: proof.result.level + 1 })],
    ["убийства", (proof) => ({ enemiesKilled: proof.result.enemiesKilled + 1 })],
    ["контрольная сумма", (proof) => ({ checksum: proof.result.checksum ^ 1 })],
  ];
  for (const [name, patch] of wrongClaims) {
    it(`заявлено другое: ${name} — mismatch, и причина называет, что именно`, SLOW, async () => {
      const result = await runReplay(jobOf(honest, { claimed: { ...claimedOf(honest), ...patch(honest) } }));

      expect(result.verdict).toBe("mismatch");
      expect(result.divergedTick).toBeNull();
      expect(result.reason?.toLowerCase()).toContain(name.split(" ")[0]);
    });
  }

  it("контрольной суммы в заявке нет — сверяются время, уровень и убийства", SLOW, async () => {
    const claimed = { survivalSec: honest.result.survivalSec, level: honest.result.level, enemiesKilled: honest.result.enemiesKilled };

    await expect(runReplay(jobOf(honest, { claimed }))).resolves.toMatchObject({ verdict: "match" });
    await expect(runReplay(jobOf(honest, { claimed: { ...claimed, enemiesKilled: claimed.enemiesKilled + 3 } }))).resolves.toMatchObject({ verdict: "mismatch" });
  });

  it("повтор разошёлся сам — тик расхождения остаётся тиком повтора, заявка его не затирает", SLOW, async () => {
    const [tick, checksum] = honest.checkpoints[0];
    const tampered = { ...honest, checkpoints: [[tick, checksum ^ 0x77]] } as RunProof;

    const result = await runReplay(jobOf(tampered, { claimed: { ...claimedOf(honest), level: 99 } }));

    expect(result.verdict).toBe("mismatch");
    expect(result.divergedTick).toBe(tick);
  });
});

describe("повтор: чего повторить нельзя", () => {
  const noReplay = (): { deps: ReplayDeps; calls: () => number } => {
    let calls = 0;
    return {
      calls: () => calls,
      deps: {
        replay: function* () {
          calls += 1;
          return yield* replaySteps(honest);
        },
      },
    };
  };

  it("хэш записи чужой, а снимка нет — content_mismatch, повтор даже не стартует", async () => {
    const watched = noReplay();

    const result = await runReplay(jobOf({ ...honest, contentHash: "deadbeef" }), watched.deps);

    expect(result).toMatchObject({ verdict: "content_mismatch", divergedTick: null, replayed: null });
    expect(result.reason).toContain("deadbeef");
    expect(watched.calls()).toBe(0);
  });

  it("снимок подан, но его хэш — не хэш записи: content_mismatch, а не расхождение игрока", async () => {
    const other = json({ ...CONTENT_SNAPSHOT, maxBoostsPerRun: CONTENT_SNAPSHOT.maxBoostsPerRun + 5 });
    const watched = noReplay();

    const result = await runReplay(jobOf(honest, { contentSnapshot: other }), watched.deps);

    expect(result).toMatchObject({ verdict: "content_mismatch", replayed: null });
    expect(watched.calls()).toBe(0);
  });

  it("снимок не по схеме или больше 2 МБ — content_mismatch: это наша сторона, а не игрок", async () => {
    const watched = noReplay();
    const broken = { ...(json(CONTENT_SNAPSHOT) as Record<string, unknown>), enemies: "не массив" };
    const huge = { padding: "я".repeat(2 * 1024 * 1024) };

    await expect(runReplay(jobOf(honest, { contentSnapshot: broken }), watched.deps)).resolves.toMatchObject({ verdict: "content_mismatch" });
    await expect(runReplay(jobOf(honest, { contentSnapshot: huge }), watched.deps)).resolves.toMatchObject({ verdict: "content_mismatch" });
    expect(watched.calls()).toBe(0);
  });

  it("запись помечена неповторимой: лог обрезан — not_replayable", async () => {
    const result = await runReplay(jobOf({ ...honest, input: { ...honest.input, truncated: true } }));

    expect(result).toMatchObject({ verdict: "not_replayable", replayed: null, divergedTick: null });
  });

  it("лог ввода не читается — broken, а не падение задания", async () => {
    const result = await runReplay(jobOf({ ...honest, input: { ...honest.input, data: "" } }));

    expect(result).toMatchObject({ verdict: "broken", replayed: null });
    expect(result.reason).not.toBeNull();
  });

  it("запись не по схеме: сложности нет в игре, шагов миллиарды, мусор вместо base64 — broken до всякого повтора", async () => {
    const watched = noReplay();
    const records = [
      { ...honest, difficultyId: "nightmare" },
      { ...honest, input: { ...honest.input, ticks: REPLAY_MAX_TICKS + 1 } },
      { ...honest, input: { ...honest.input, data: "????" } },
      { ...honest, choices: "нет" },
      { schema: "run-proof-v9" },
    ];

    for (const record of records) {
      await expect(runReplay(jobOf(honest, { proof: record }), watched.deps)).resolves.toMatchObject({ verdict: "broken", replayed: null });
    }
    expect(watched.calls()).toBe(0);
  });

  it("повтор бросил исключение — broken с причиной, а не провал задания: воркер жив, игрок не виноват", async () => {
    const result = await runReplay(jobOf(honest), {
      replay: () => {
        throw new Error("движок упал");
      },
    });

    expect(result).toMatchObject({ verdict: "broken", replayed: null });
    expect(result.reason).toContain("движок упал");
  });

  it("форма самого задания — граница с сервером: без идентификатора или заявки задание падает", async () => {
    await expect(runReplay({ proof: json(honest), contentSnapshot: null, claimed: claimedOf(honest) })).rejects.toThrow();
    await expect(runReplay({ runId: honest.runId, proof: json(honest), contentSnapshot: null })).rejects.toThrow();
    await expect(runReplay({ ...jobOf(honest), лишнее: 1 })).rejects.toThrow();
    expect(replayJobSchema.safeParse(jobOf(honest)).success).toBe(true);
  });
});

describe("повтор: предел времени", () => {
  it("зацикленный повтор прерывается на 60 с: timeout, а повтор закрывается, не оставляя мир в памяти", async () => {
    expect(REPLAY_LIMIT_MS).toBe(60_000);
    let closed = false;
    let steps = 0;
    const endless: ReplayDeps["replay"] = function* () {
      try {
        for (;;) yield (steps += 600);
      } finally {
        closed = true;
      }
    };
    // Часы, у которых каждый опрос — десять секунд: шестой опрос выходит за минуту.
    let clock = 0;

    const result = await runReplay(jobOf(honest), {
      replay: endless,
      now: () => (clock += 10_000),
      yieldToLoop: async () => undefined,
    });

    expect(result).toMatchObject({ verdict: "timeout", divergedTick: null, replayed: null });
    expect(result.reason).toContain("60");
    expect(result.durationMs).toBeGreaterThanOrEqual(REPLAY_LIMIT_MS);
    expect(closed).toBe(true);
    expect(steps).toBeLessThan(600 * 20);
  });

  it("настоящий повтор тоже останавливается на пределе: после первой же части — timeout, без исхода", SLOW, async () => {
    let yields = 0;

    const result = await runReplay(jobOf(honest), {
      limitMs: 0,
      yieldToLoop: async () => {
        yields += 1;
      },
    });

    expect(result).toMatchObject({ verdict: "timeout", replayed: null });
    expect(yields).toBeLessThanOrEqual(1);
  });

  it("предел считается от начала повтора, а не от постановки в очередь", async () => {
    // Исход подменён: повтор сразу готов, часы не двигаются — время ожидания затвора в предел не входит.
    const expected = honest.result;
    const done: ReplayOutcome = { verdict: "match", reason: null, divergedAtTick: null, expected, actual: expected };
    const instant: ReplayDeps["replay"] = function* () {
      yield 1;
      return done;
    };

    const result = await runReplay(jobOf(honest), { replay: instant, now: () => 0 });

    expect(result.verdict).toBe("match");
    expect(result.durationMs).toBe(0);
  });
});

describe("затвор процесса", () => {
  const deferred = () => {
    let release = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };

  it("задания идут по одному: второе ждёт, пока первое не закончит", async () => {
    const gate = new RunGate();
    const log: string[] = [];
    const hold = deferred();

    const first = gate.run("replay", async () => {
      log.push("первый начал");
      await hold.promise;
      log.push("первый закончил");
    });
    const second = gate.run("check", async () => {
      log.push("второй начал");
    });
    await Promise.resolve();
    expect(log).toEqual(["первый начал"]);

    hold.release();
    await Promise.all([first, second]);
    expect(log).toEqual(["первый начал", "первый закончил", "второй начал"]);
  });

  it("при очереди первой идёт проверка контента, а не повтор, пришедший раньше; свои — по порядку прихода", async () => {
    const gate = new RunGate();
    const order: string[] = [];
    const hold = deferred();
    const task = (name: string) => async (): Promise<void> => {
      order.push(name);
    };

    const busy = gate.run("replay", async () => {
      await hold.promise;
    });
    const waiting = [gate.run("replay", task("повтор 1")), gate.run("replay", task("повтор 2")), gate.run("check", task("проверка 1")), gate.run("check", task("проверка 2"))];
    hold.release();
    await Promise.all([busy, ...waiting]);

    expect(order).toEqual(["проверка 1", "проверка 2", "повтор 1", "повтор 2"]);
  });

  it("упавшее задание затвор отпускает, а ошибка уходит тому, кто его ставил", async () => {
    const gate = new RunGate();
    const failed = gate.run("check", async () => {
      throw new Error("упало");
    });
    const next = gate.run("replay", async () => "дошло");

    await expect(failed).rejects.toThrow("упало");
    await expect(next).resolves.toBe("дошло");
  });

  it("свободный затвор отдаёт результат сразу, а возвращаемое значение не теряется", async () => {
    await expect(new RunGate().run("replay", async () => 42)).resolves.toBe(42);
  });
});

describe("метрики повтора", () => {
  it("исход задания — вердикт повтора: sim_jobs_total{queue=\"replay\",outcome} и время в sim_job_seconds", () => {
    const metrics = new Metrics();
    for (const verdict of ["match", "match", "mismatch", "content_mismatch", "not_replayable", "broken", "timeout", "error"] as const) {
      metrics.observe(REPLAY_QUEUE, verdict, 2);
    }

    const text = metrics.render();

    expect(REPLAY_QUEUE).toBe("replay");
    expect(text).toContain('sim_jobs_total{queue="replay",outcome="match"} 2');
    for (const verdict of ["mismatch", "content_mismatch", "not_replayable", "broken", "timeout", "error"]) {
      expect(text).toContain(`sim_jobs_total{queue="replay",outcome="${verdict}"} 1`);
    }
    expect(text).toContain('sim_job_seconds_count{queue="replay"} 8');
    // Низкая кардинальность: ни забегов, ни игроков в метках.
    expect(text).not.toMatch(/runId|run_id/);
  });
});

describe("сборка воркера", () => {
  it("повтор ложится в сборку без Phaser: в нём симуляция и контент, а не сцена", async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL("../src/main.ts", import.meta.url))],
      bundle: true,
      write: false,
      metafile: true,
      platform: "node",
      format: "esm",
      // Как в `build.mjs`: Phaser внешний, и если импорт просочился, он виден в списке внешних.
      external: ["phaser", "msgpackr-extract"],
      logLevel: "silent",
    });

    const inputs = Object.keys(result.metafile.inputs).map((path) => path.replaceAll("\\", "/"));
    const external = Object.values(result.metafile.outputs).flatMap((output) => output.imports.filter((entry) => entry.external).map((entry) => entry.path));
    expect(inputs.some((path) => path.endsWith("game/diagnostics/replay.ts"))).toBe(true);
    expect(inputs.filter((path) => /game\/(?:MainScene|BenchScene|render\/|overlays\/)|\/engine\/|phaser/i.test(path))).toEqual([]);
    expect(external).not.toContain("phaser");
  }, 60_000);
});

/** Своя база Redis и своё имя очереди: чужие `flushdb` её не заденут, а мы чужого не тронем. */
const REDIS_URL = process.env.PLAYTEST_TEST_REDIS_URL ?? "";

function fakeCheckRun(seed: number): BalanceRunResult {
  return { seed, skill: "dodging", startingWeaponId: "w", survivalSec: 100 + seed, level: 3, wave: 2, enemiesKilled: 50, xpCollected: 10, peakEnemies: 9, firstLevelUpSec: 10, chestsFound: 1, chestsOpened: 1, evolutions: 0, buildCompleteSec: 0, buildPicks: 0, damageTakenByMinute: [], startPower: 0, startPressure: 1, endPressure: 1, buildScoreByMinute: [], killsByMinute: [], huntLogCountByMinute: [], buildPointsByMinute: [], huntLog: [], timedOut: false };
}

describe.skipIf(REDIS_URL === "")("очередь повтора на живом Redis", () => {
  const clients: Redis[] = [];
  const closers: (() => Promise<void>)[] = [];
  const queues: Queue[] = [];
  const eventsList: QueueEvents[] = [];

  const connection = (): Redis => {
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    clients.push(redis);
    return redis;
  };
  const open = (name: string): { queue: Queue; events: QueueEvents } => {
    const queue = new Queue(name, { connection: connection() });
    const events = new QueueEvents(name, { connection: connection() });
    queues.push(queue);
    eventsList.push(events);
    return { queue, events };
  };

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(queues.map((queue) => queue.obliterate({ force: true })));
  });

  afterAll(async () => {
    await Promise.all(eventsList.map((events) => events.close()));
    await Promise.all(queues.map((queue) => queue.close()));
    for (const redis of clients) redis.disconnect();
  });

  const startReplay = (name: string, options: { gate?: RunGate; deps?: ReplayDeps; metrics?: Metrics }): Worker => {
    const worker = createReplayWorker({ connection: connection(), queueName: name, metrics: options.metrics ?? new Metrics(), ...(options.gate === undefined ? {} : { gate: options.gate }), ...(options.deps === undefined ? {} : { deps: options.deps }) });
    closers.push(() => worker.close());
    return worker;
  };

  it("воркер берёт задание, повторяет забег, а исход уходит в ту же очередь; метрика — по вердикту", SLOW, async () => {
    const name = `replay-test-${randomUUID()}`;
    const { queue, events } = open(name);
    const metrics = new Metrics();
    startReplay(name, { metrics });

    const added = await queue.add("replay", jobOf(honest), { jobId: honest.runId.replaceAll(":", "-"), attempts: 1 });
    const result = (await added.waitUntilFinished(events, 100_000)) as ReplayResult;

    expect(result).toMatchObject({ runId: honest.runId, verdict: "match", divergedTick: null });
    expect(metrics.render()).toContain('sim_jobs_total{queue="replay",outcome="match"} 1');
  });

  it("задание с испорченной формой падает в очереди и считается ошибкой, воркер остаётся жив", SLOW, async () => {
    const name = `replay-test-${randomUUID()}`;
    const { queue, events } = open(name);
    const metrics = new Metrics();
    startReplay(name, { metrics });

    const broken = await queue.add("replay", { runId: honest.runId });
    await expect(broken.waitUntilFinished(events, 30_000)).rejects.toThrow();
    expect(metrics.render()).toContain('sim_jobs_total{queue="replay",outcome="error"} 1');

    const after = await queue.add("replay", jobOf(honest));
    await expect(after.waitUntilFinished(events, 100_000)).resolves.toMatchObject({ verdict: "match" });
  });

  it("затвор общий с проверкой контента: проверка не идёт, пока идёт повтор, и наоборот", SLOW, async () => {
    const replayName = `replay-test-${randomUUID()}`;
    const checkName = `content-check-test-${randomUUID()}`;
    const replays = open(replayName);
    const checks = open(checkName);
    const gate = new RunGate();
    const events: string[] = [];
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    const expected = honest.result;
    const slowReplay: ReplayDeps["replay"] = function* () {
      events.push("повтор начат");
      for (let part = 0; part < 4; part += 1) yield part;
      events.push("повтор закончен");
      return { verdict: "match", reason: null, divergedAtTick: null, expected, actual: expected } satisfies ReplayOutcome;
    };
    startReplay(replayName, { gate, deps: { replay: slowReplay, yieldToLoop: () => sleep(40) } });
    const checkWorker = createCheckWorker({
      connection: connection(),
      queueName: checkName,
      metrics: new Metrics(),
      gate,
      deps: {
        simulate: (options) => {
          if (!events.includes("проверка начата")) events.push("проверка начата");
          return fakeCheckRun(options.seed);
        },
      },
    });
    closers.push(() => checkWorker.close());

    const replayJob = await replays.queue.add("replay", jobOf(honest));
    // Повтор уже идёт — ставим проверку: она обязана дождаться его конца.
    while (!events.includes("повтор начат")) await sleep(10);
    const snapshot: unknown = json(CONTENT_SNAPSHOT);
    const checkJob = await checks.queue.add("check", { checkId: "c-gate", snapshot, baseSnapshot: snapshot, scenarios: [{ id: "a", skill: "dodging", seeds: 1 }] });

    await replayJob.waitUntilFinished(replays.events, 30_000);
    const checked = (await checkJob.waitUntilFinished(checks.events, 30_000)) as CheckResult;

    expect(checked.checkId).toBe("c-gate");
    expect(events).toEqual(["повтор начат", "повтор закончен", "проверка начата"]);
  });
});
