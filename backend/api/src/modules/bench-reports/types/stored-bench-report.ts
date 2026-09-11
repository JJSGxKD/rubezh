import type { SubmitBenchReportDto } from "../dto/bench-report.dto";

/** Отчёт в том виде, в котором он лежит в хранилище. */
export interface StoredBenchReport {
  reportId: string;
  /** UTC — сервер и логи живут в UTC (CLAUDE.md, «Окружение команды») */
  receivedAt: string;
  report: SubmitBenchReportDto["report"];
  verdict: SubmitBenchReportDto["verdict"];
}

/** Короткая сводка для списка: полный отчёт для обзора не нужен. */
export interface BenchReportSummary {
  reportId: string;
  receivedAt: string;
  startedAt: string;
  verdict: string;
  /** почему прогон закончился: для агрессивного режима это главная строка */
  stoppedBy: string;
  /** больше нуля — прогон прерывался сворачиванием, цифрам верить нельзя */
  interruptions: number;
  sustainedLoad: number;
  peakObjects: number;
  displayHz: number | null;
  avgFps: number;
  p95FrameMs: number;
  mode: string;
  buildVersion: string;
  device: string;
  telegramPlatform: string | null;
  telegramVersion: string | null;
  devicePixelRatio: number;
}
