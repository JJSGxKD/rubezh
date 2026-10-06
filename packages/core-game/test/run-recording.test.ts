import { describe, expect, it } from "vitest";
import {
  decodeBase64,
  decodeInputLog,
  encodeBase64,
  INPUT_LOG_MAX_BYTES,
  InputLogError,
  InputLogWriter,
} from "../src/game/diagnostics/input-log";
import { replayRecording } from "../src/game/diagnostics/replay";
import { CHECKPOINT_TICKS, RunRecorder } from "../src/game/diagnostics/run-recorder";
import { RunTimeline, TIMELINE_MAX_BUCKETS } from "../src/game/diagnostics/run-timeline";
import { RunPerfTracker } from "../src/game/diagnostics/run-perf";
import { createRunWorld } from "../src/game/run-world";
import { DIRECTION_CODES, IDLE_CODE } from "../src/game/sim/input-code";
import type { RunRecording } from "../src/run-api";
import { circling, recordHeadlessRun } from "./helpers/recorded-run";

// Запись забега и повтор по ней (docs/28-diagnostics.md §3.3–§3.5).

function encode(codes: readonly number[], maxBytes?: number) {
  const writer = new InputLogWriter(maxBytes);
  for (const code of codes) writer.push(code);
  return writer.finish();
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("лог ввода", () => {
  // Гоняет мир минутами: в полном прогоне монорепо пяти секунд Vitest не хватает.
  it("кодирует и декодирует без потерь: покой, кругование, прыжки и длинные серии", { timeout: 30_000 }, () => {
    const random = lcg(7);
    const codes: number[] = [];
    let code = 40;
    for (let i = 0; i < 20_000; i++) {
      const roll = random();
      if (roll < 0.05) code = IDLE_CODE;
      else if (roll < 0.1) code = Math.floor(random() * DIRECTION_CODES);
      else if (roll < 0.6 && code !== IDLE_CODE) code = (code + (random() < 0.5 ? 1 : 255)) % DIRECTION_CODES;
      const repeat = random() < 0.02 ? 5000 : 1 + Math.floor(random() * 12);
      for (let r = 0; r < repeat; r++) codes.push(code);
    }
    const log = encode(codes);
    expect(log.truncated).toBe(false);
    expect(Array.from(decodeInputLog(log))).toEqual(codes);
  });

  it("поворот через ноль оборота — один байт, а не смена направления", () => {
    const log = encode([255, 0, 1, 255]);
    expect(decodeBase64(log.data)).toHaveLength(2 + 3);
    expect(Array.from(decodeInputLog(log))).toEqual([255, 0, 1, 255]);
  });

  it("пустой забег и забег без движения читаются", () => {
    expect(Array.from(decodeInputLog(encode([])))).toEqual([]);
    const idle = encode(new Array(36_000).fill(IDLE_CODE));
    expect(decodeBase64(idle.data).length).toBeLessThanOrEqual(4);
    expect(decodeInputLog(idle).every((value) => value === IDLE_CODE)).toBe(true);
  });

  it("лог сверх потолка помечается обрезанным, а не дописывается криво", () => {
    const codes = Array.from({ length: 1000 }, (_, i) => (i * 37) % DIRECTION_CODES);
    const log = encode(codes, 64);
    expect(log.truncated).toBe(true);
    expect(log.data).toBe("");
    expect(log.ticks).toBe(1000);
  });

  it("битый лог — ошибка, а не молча другой забег", () => {
    const log = encode([10, 10, 11, IDLE_CODE]);
    expect(() => decodeInputLog({ ...log, ticks: 5 })).toThrow(InputLogError);
    expect(() => decodeInputLog({ ...log, ticks: 3 })).toThrow(InputLogError);
    expect(() => decodeInputLog({ ...log, data: "@@@@" })).toThrow(InputLogError);
    expect(() => decodeInputLog({ ...log, encoding: "rle-v0" as "rle-v1" })).toThrow(InputLogError);
    // Поворот без направления до него.
    expect(() => decodeInputLog({ encoding: "rle-v1", ticks: 1, data: encodeBase64(new Uint8Array([0x80])) })).toThrow(InputLogError);
  });

  it("свой base64 совпадает с эталонным", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 300]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 97 + 13) & 255);
      expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
      expect(Array.from(decodeBase64(encodeBase64(bytes)))).toEqual(Array.from(bytes));
    }
  });
});

describe("таймлайн записи", () => {
  const frame = (frameMs: number, patch: Partial<Parameters<RunTimeline["frame"]>[0]> = {}) => ({
    frameMs,
    simMs: 0.5,
    steps: 1,
    renderMs: 2,
    enemies: 100,
    projectiles: 20,
    tick: 0,
    wave: 0,
    ...patch,
  });

  it("режет кадры на корзины по пять секунд и считает перцентили и догоняние", () => {
    const timeline = new RunTimeline(() => 42.34);
    for (let i = 0; i < 300; i++) timeline.frame(frame(1000 / 60, { tick: i + 1 }));
    for (let i = 0; i < 90; i++) timeline.frame(frame(50, { steps: 3, simMs: 6, tick: 301 + i, wave: 1, enemies: 400 }));
    const buckets = timeline.finish();

    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({ startSec: 0, frames: 300, avgFps: 60, maxSteps: 1, catchUpFrames: 0, heapMb: 42.3 });
    expect(buckets[1]).toMatchObject({ frames: 90, p95FrameMs: 50, over33Ratio: 1, maxSteps: 3, catchUpFrames: 90, wave: 1, enemies: 400 });
    expect(buckets[1].simMsAvg).toBeCloseTo(2, 3);
    expect(buckets[1].startSec).toBeCloseTo(5, 1);
  });

  it("часовой потолок: дальше таймлайн не растёт и честно помечен", () => {
    const timeline = new RunTimeline();
    for (let i = 0; i < (TIMELINE_MAX_BUCKETS + 3) * 5; i++) timeline.frame(frame(1000));
    expect(timeline.finish()).toHaveLength(TIMELINE_MAX_BUCKETS);
    expect(timeline.truncated).toBe(true);
  });
});

/**
 * Seed забега, который при круговании доживает до двух свёрток. Выбран по
 * контенту: правка врагов или оружия может уронить игрока раньше — тогда
 * тест скажет `died`, и seed подбирается заново, а не ослабляется проверка.
 */
const CIRCLING_SEED = 1235;

describe("повтор забега по записи", () => {
  it("кругование вокруг толпы повторяется до свёртки мира", () => {
    const recording = recordHeadlessRun({ seed: CIRCLING_SEED, maxTicks: 2 * CHECKPOINT_TICKS + 30, steer: circling(150) });
    expect(recording.outcome).toBe("abandoned");
    expect(recording.checkpoints).toHaveLength(2);
    expect(recording.choices.length).toBeGreaterThan(0);

    const outcome = replayRecording(recording);
    expect(outcome.reason).toBeNull();
    expect(outcome.verdict).toBe("match");
    expect(outcome.actual).toEqual(recording.result);
  });

  it("стоящий на месте игрок погибает — и повтор погибает там же и от того же", () => {
    const recording = recordHeadlessRun({ seed: 99, maxTicks: 30 * CHECKPOINT_TICKS, difficultyId: "hard", steer: () => null });
    expect(recording.outcome).toBe("died");
    expect(recording.result.deathCause).not.toBeNull();
    expect(replayRecording(recording).verdict).toBe("match");
  });

  it("чужой ввод посреди забега — расхождение не раньше подмены и не позже минуты", () => {
    const recording = recordHeadlessRun({ seed: CIRCLING_SEED, maxTicks: 2 * CHECKPOINT_TICKS + 30, steer: circling(150) });
    const codes = Array.from(decodeInputLog(recording.input));
    for (let tick = 1000; tick < 1300; tick++) codes[tick] = codes[tick] === IDLE_CODE ? 0 : (codes[tick] + 128) % DIRECTION_CODES;
    const tampered: RunRecording = { ...recording, input: encode(codes) };

    const outcome = replayRecording(tampered);
    expect(outcome.verdict).toBe("mismatch");
    // Ловит свёртка первой минуты или раньше — выбор улучшения, который в
    // другом забеге пришёлся не на тот тик.
    expect(outcome.divergedAtTick).toBeGreaterThanOrEqual(1000);
    expect(outcome.divergedAtTick).toBeLessThanOrEqual(CHECKPOINT_TICKS);
  });

  it("выбор, которого не было в предложении, — расхождение, а не молчаливый пропуск", () => {
    const recording = recordHeadlessRun({ seed: CIRCLING_SEED, maxTicks: CHECKPOINT_TICKS, steer: circling(150) });
    const [tick] = recording.choices[0];
    const outcome = replayRecording({ ...recording, choices: [[tick, "not_an_option"], ...recording.choices.slice(1)] });
    expect(outcome.verdict).toBe("mismatch");
    expect(outcome.reason).toContain("not_an_option");
    expect(outcome.divergedAtTick).toBe(tick);
  });

  it("неповторимую, чужую по контенту и битую запись не повторяет", () => {
    const recording = recordHeadlessRun({ seed: 5, maxTicks: 200, steer: circling(150) });
    expect(replayRecording({ ...recording, replayBlocker: "resumed" }).verdict).toBe("not_replayable");
    expect(replayRecording(recording, "другой-хэш").verdict).toBe("content_mismatch");
    expect(replayRecording({ ...recording, input: { ...recording.input, data: "????" } }).verdict).toBe("broken");
  });
});

describe("бюджет записи (docs/28-diagnostics.md §3.5)", () => {
  it("десять минут кругования — лог ввода до 64 КБ, отчёт до 150 КБ", () => {
    const ticks = 10 * CHECKPOINT_TICKS;
    const { world } = createRunWorld({ seed: 1, mapId: "", difficultyId: "normal", unitScale: 2 });
    const recorder = new RunRecorder({
      reportId: "00000000-0000-4000-8000-000000000002",
      runId: "budget",
      startedAt: "2026-09-16T10:00:00.000Z",
      seed: 1,
      mapId: world.mapId,
      difficultyId: "normal",
      startingWeaponId: "spark",
      contentHash: "hash",
      unitScale: 2,
      replayBlocker: null,
    }, { heapMb: () => 187.5 });
    const random = lcg(3);
    let code = 0;
    for (let tick = 1; tick <= ticks; tick++) {
      // Худший честный случай: палец не отпускает джойстик и ведёт круги, код
      // меняется почти каждый тик; изредка — резкий разворот.
      code = random() < 0.01 ? Math.floor(random() * DIRECTION_CODES) : (code + 1) % DIRECTION_CODES;
      world.stats.tick = tick;
      recorder.stepped(code, world);
      recorder.frame({ frameMs: 16.7 + random() * 20, simMs: 2.5, steps: random() < 0.1 ? 2 : 1, renderMs: 3.1, enemies: 640, projectiles: 180, tick, wave: 9 });
      if (tick % 900 === 0) {
        recorder.event(tick, "level", tick / 900);
        recorder.event(tick, "offer", "spark_bolt,might,armor");
        recorder.choice(tick, "might");
      }
      if (tick % 3600 === 0) recorder.event(tick, "wave", tick / 3600);
    }
    const perf = new RunPerfTracker().summary({ renderer: "webgl", renderCapFps: null, dpr: 2, canvasWidth: 1080, canvasHeight: 2340, interruptions: 0 });
    const recording = recorder.finish(world, "died", "swarm_rat", perf, "Adreno (TM) 610");

    expect(recording.input.truncated).toBe(false);
    expect(recording.input.data.length).toBeLessThanOrEqual((INPUT_LOG_MAX_BYTES * 4) / 3);
    expect(recording.input.data.length).toBeLessThanOrEqual(64_000);
    expect(JSON.stringify(recording).length).toBeLessThanOrEqual(150_000);
    expect(recording.timeline.length).toBeGreaterThanOrEqual(100);
  });
});
