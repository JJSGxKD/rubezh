import { z } from "zod";

/**
 * Схема записи забега (`rubezh.run.v1`, docs/28-diagnostics.md §3.3–§3.4).
 *
 * Отчёт приходит с телефона тестера — граница системы, поэтому каждый массив
 * ограничен: большой отчёт не должен пройти частями. Потолки — с запасом над
 * тем, что пишет движок (`core-game/src/game/diagnostics/*`): таймлайн — час,
 * события — 4000, лог ввода — 64 КБ строкой base64.
 *
 * Схема живёт в бэкенде, а не в `core-game`: собранный бэкенд не импортирует
 * исходники пакетов монорепо. Что настоящая запись движка ей соответствует,
 * проверяет `scripts/test/run-report-schema.test.ts`.
 */

const count = z.number().int().nonnegative();
const amount = z.number().nonnegative();
const ratio = z.number().min(0).max(1);
const id = z.string().max(64);

export const RUN_REPORT_SCHEMA = "rubezh.run.v1";

const perfSchema = z.object({
  frames: count,
  durationSec: amount,
  avgFps: amount,
  p95FrameMs: amount,
  over33Ratio: ratio,
  peakObjects: count,
  displayHz: count,
  renderCapFps: count.nullable(),
  renderer: z.enum(["webgl", "canvas"]),
  dpr: z.number().positive().max(10),
  canvasWidth: count,
  canvasHeight: count,
  interruptions: count,
});

const bucketSchema = z.object({
  startSec: amount,
  tick: count,
  wave: count,
  frames: count,
  avgFps: amount,
  p50FrameMs: amount,
  p95FrameMs: amount,
  p99FrameMs: amount,
  over33Ratio: ratio,
  simMsAvg: amount,
  simMsMax: amount,
  maxSteps: count,
  catchUpFrames: count,
  renderMsAvg: amount,
  enemies: count,
  projectiles: count,
  maxObjects: count,
  heapMb: amount.nullable(),
});

/** Виды событий записи — копия `RUN_RECORDING_EVENT_KINDS` движка; сверяет тест. */
export const RECORDING_EVENT_KINDS = ["wave", "level", "offer", "choice", "pause", "resume", "resize", "downed", "continue", "death", "abandon"] as const;

/** Потолок продолжений за забег — `MAX_CONTINUES_PER_RUN` движка. */
const MAX_CONTINUES = 5;

const resultSchema = z.object({
  ticks: count,
  survivalSec: amount,
  level: count,
  enemiesKilled: count,
  deathCause: id.nullable(),
  checksum: z.number().int(),
});

export const runRecordingSchema = z.object({
  schema: z.literal(RUN_REPORT_SCHEMA),
  reportId: z.uuid(),
  runId: z.string().min(1).max(64),
  startedAt: z.iso.datetime({ offset: true }),
  seed: z.number().int(),
  mapId: id,
  difficultyId: id,
  startingWeaponId: id,
  contentHash: id,
  unitScale: z.number().positive().max(10),
  outcome: z.enum(["died", "abandoned"]),
  replayBlocker: z.enum(["resumed", "dev", "input_overflow"]).nullable(),
  result: resultSchema,
  gpu: z.string().max(128).nullable(),
  perf: perfSchema,
  timeline: z.array(bucketSchema).max(720),
  timelineTruncated: z.boolean(),
  events: z.array(z.tuple([count, z.enum(RECORDING_EVENT_KINDS), z.union([z.string().max(512), z.number(), z.null()])])).max(4000),
  eventsTruncated: z.boolean(),
  input: z.object({
    encoding: z.literal("rle-v1"),
    ticks: count,
    data: z
      .string()
      .max(64_004)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    truncated: z.boolean(),
  }),
  choices: z.array(z.tuple([count, id])).max(2000),
  // Тики второго шанса (docs/07-monetization-and-ads.md §8). Запись прошлой
  // сборки поля не несёт — это забег без продолжений.
  continues: z.array(count).max(MAX_CONTINUES).default([]),
  checkpoints: z.array(z.tuple([count, z.number().int()])).max(240),
});

export const submitRunReportSchema = z.object({
  recording: runRecordingSchema,
  client: z.object({
    screenMode: z.string().max(32),
    insets: z.object({ top: amount, right: amount, bottom: amount, left: amount }),
    clientErrors: count,
    evictedReports: count,
  }),
});

export type RunSubmission = z.infer<typeof submitRunReportSchema>;
