import type { BenchSubmission } from "./dto/report-envelope.dto.js";
import type { RunSubmission } from "./dto/run-report.dto.js";

/**
 * Поля отчёта для выборок без разбора `payload` (docs/28-diagnostics.md §5.4):
 * их читают сводка в чате администраторов, уведомления и выгрузка.
 */
export interface BenchSummary {
  mode: string;
  loadout: string;
  /** почему прогон остановился: `degradation` — предел найден, `duration` — нет */
  outcome: string;
  peakObjects: number;
  peakEnemies: number;
  peakProjectiles: number;
  avgFps: number;
  p95FrameMs: number;
  displayHz: number | null;
  durationSec: number;
  interruptions: number;
  /** нагрузка, на которой устройство перестало держать порог; `null` — не перестало */
  breakingLoad: number | null;
  /** сколько врагов устройство держало плавно */
  sustainedLoad: number;
  verdict: string;
}

export function benchSummaryOf(submission: BenchSubmission): BenchSummary {
  const { report, verdict } = submission;
  const totals = report.totals;
  return {
    mode: report.profile.mode,
    loadout: report.profile.loadout,
    outcome: report.stoppedBy,
    peakObjects: Math.round(totals.peakObjects),
    peakEnemies: Math.round(totals.peakLoad),
    peakProjectiles: Math.round(totals.peakProjectiles),
    avgFps: round1(totals.avgFps),
    p95FrameMs: round1(totals.p95FrameMs),
    displayHz: totals.displayHz > 0 ? totals.displayHz : null,
    durationSec: round1(totals.durationSec),
    interruptions: report.interruptions,
    breakingLoad: verdict.breakingPoint === null ? null : Math.round(verdict.breakingPoint.load),
    sustainedLoad: Math.round(verdict.sustainedLoad),
    verdict: verdict.level,
  };
}

/**
 * Почему забег проблемный (docs/28-diagnostics.md §6.2): в чат администраторов
 * уходят только такие записи, остальные — счётчиком в сводке.
 *
 * - `frame_drops` — заметные рывки: доля кадров дольше 33 мс или p95 кадра
 *   сверх порога;
 * - `catch_up` — устройство не успевало, и сцена догоняла время несколькими
 *   шагами за кадр: игрок видит замедление игры, а не падение FPS;
 * - `client_errors` — за забег случились ошибки клиента.
 */
export type RunProblem = "frame_drops" | "catch_up" | "client_errors";

/**
 * Пороги проблемного забега. Короткий забег не судим по кадрам: десять секунд
 * загрузки и первой волны ничего не говорят об устройстве.
 */
export const RUN_PROBLEM_THRESHOLDS = {
  /** меньше кадров в оценке — о рывках не судим */
  minFrames: 600,
  over33Ratio: 0.05,
  p95FrameMs: 33,
  /** доля кадров с догонянием */
  catchUpRatio: 0.02,
  /** потолок шагов за кадр в сцене: упёрлись — игра замедлилась */
  maxStepsPerFrame: 5,
} as const;

export interface RunSummary {
  outcome: string;
  difficulty: string;
  map: string;
  survivalSec: number;
  level: number;
  avgFps: number;
  p95FrameMs: number;
  over33Ratio: number;
  peakObjects: number;
  displayHz: number | null;
  /** доля кадров, в которых симуляция делала больше шага */
  catchUpRatio: number;
  maxSteps: number;
  interruptions: number;
  clientErrors: number;
  evictedReports: number;
  /** почему забег не повторить; `null` — повторяется */
  replayBlocker: string | null;
  problems: RunProblem[];
}

export function runSummaryOf(submission: RunSubmission): RunSummary {
  const { recording, client } = submission;
  const perf = recording.perf;
  let frames = 0;
  let catchUpFrames = 0;
  let maxSteps = 0;
  for (const bucket of recording.timeline) {
    frames += bucket.frames;
    catchUpFrames += bucket.catchUpFrames;
    if (bucket.maxSteps > maxSteps) maxSteps = bucket.maxSteps;
  }
  const catchUpRatio = frames > 0 ? catchUpFrames / frames : 0;

  const limits = RUN_PROBLEM_THRESHOLDS;
  const problems: RunProblem[] = [];
  if (perf.frames >= limits.minFrames && (perf.over33Ratio > limits.over33Ratio || perf.p95FrameMs > limits.p95FrameMs)) {
    problems.push("frame_drops");
  }
  if (frames >= limits.minFrames && (catchUpRatio > limits.catchUpRatio || maxSteps >= limits.maxStepsPerFrame)) {
    problems.push("catch_up");
  }
  if (client.clientErrors > 0) problems.push("client_errors");

  return {
    outcome: recording.outcome,
    difficulty: recording.difficultyId,
    map: recording.mapId,
    survivalSec: round1(recording.result.survivalSec),
    level: recording.result.level,
    avgFps: round1(perf.avgFps),
    p95FrameMs: round1(perf.p95FrameMs),
    over33Ratio: Math.round(perf.over33Ratio * 10_000) / 10_000,
    peakObjects: perf.peakObjects,
    displayHz: perf.displayHz > 0 ? perf.displayHz : null,
    catchUpRatio: Math.round(catchUpRatio * 10_000) / 10_000,
    maxSteps,
    interruptions: perf.interruptions,
    clientErrors: client.clientErrors,
    evictedReports: client.evictedReports,
    replayBlocker: recording.replayBlocker,
    problems,
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
