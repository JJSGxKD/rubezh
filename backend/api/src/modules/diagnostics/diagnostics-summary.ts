import type { BenchSubmission } from "./dto/report-envelope.dto.js";

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

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
