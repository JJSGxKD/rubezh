import { DEVICE } from "./bench-report.js";

/** Запись забега в том виде, в каком её шлёт оболочка (docs/28-diagnostics.md §3.3). */

export const RUN_REPORT_ID = "33333333-4444-4555-8666-777777777777";

export interface RunPatch {
  frames?: number;
  over33Ratio?: number;
  p95FrameMs?: number;
  catchUpFrames?: number;
  maxSteps?: number;
  clientErrors?: number;
  timeline?: unknown[];
  inputData?: string;
}

export function runBucket(index: number, patch: Partial<Record<string, number | null>> = {}): Record<string, number | null> {
  return {
    startSec: index * 5,
    tick: (index + 1) * 300,
    wave: Math.floor(index / 12),
    frames: 300,
    avgFps: 59.6,
    p50FrameMs: 16.6,
    p95FrameMs: 18.2,
    p99FrameMs: 24,
    over33Ratio: 0,
    simMsAvg: 0.8,
    simMsMax: 4.1,
    maxSteps: 1,
    catchUpFrames: 0,
    renderMsAvg: 2.3,
    enemies: 120 + index * 10,
    projectiles: 40,
    maxObjects: 180 + index * 10,
    heapMb: 96.4,
    ...patch,
  };
}

export function runSubmission(reportId = RUN_REPORT_ID, patch: RunPatch = {}): Record<string, unknown> {
  const buckets = patch.timeline ?? [
    runBucket(0),
    runBucket(1, { catchUpFrames: patch.catchUpFrames ?? 0, maxSteps: patch.maxSteps ?? 1 }),
    runBucket(2),
  ];
  return {
    recording: {
      schema: "rubezh.run.v1",
      reportId,
      runId: "b7e0c2d4-1111-4222-8333-444455556666",
      startedAt: "2026-09-16T09:30:00.000Z",
      seed: 918273,
      mapId: "frontier",
      difficultyId: "normal",
      startingWeaponId: "spark",
      contentHash: "abc123",
      unitScale: 2.625,
      outcome: "died",
      replayBlocker: null,
      result: { ticks: 27_000, survivalSec: 450, level: 21, enemiesKilled: 3120, deathCause: "swarm_rat", checksum: -1_283_774_112 },
      gpu: "Adreno (TM) 610",
      perf: {
        frames: patch.frames ?? 26_800,
        durationSec: 447,
        avgFps: 59.1,
        p95FrameMs: patch.p95FrameMs ?? 18.25,
        over33Ratio: patch.over33Ratio ?? 0.004,
        peakObjects: 1210,
        displayHz: 60,
        renderCapFps: null,
        renderer: "webgl",
        dpr: 2.625,
        canvasWidth: 1080,
        canvasHeight: 2340,
        interruptions: 0,
      },
      timeline: buckets,
      timelineTruncated: false,
      events: [
        [0, "wave", 0],
        [540, "level", 2],
        [540, "offer", "knife,might,armor"],
        [540, "choice", "might"],
        [27_000, "death", "swarm_rat"],
      ],
      eventsTruncated: false,
      input: { encoding: "rle-v1", ticks: 27_000, data: patch.inputData ?? "AIEBgQKD", truncated: false },
      choices: [[540, "might"]],
      checkpoints: [
        [3600, 1_928_374],
        [7200, -58_112],
      ],
    },
    client: {
      screenMode: "fullscreen",
      insets: { top: 47, right: 0, bottom: 34, left: 0 },
      clientErrors: patch.clientErrors ?? 0,
      evictedReports: 0,
    },
  };
}

export function runEnvelope(reportId = RUN_REPORT_ID, patch: RunPatch = {}): Record<string, unknown> {
  return {
    reportId,
    kind: "run",
    appVersion: "0.4.0",
    contentHash: "abc123",
    installId: "0f6f1f5e-1111-4222-8333-444455556666",
    platform: "telegram",
    occurredAt: "2026-09-16T09:30:00.000Z",
    device: DEVICE,
    payload: runSubmission(reportId, patch),
  };
}
