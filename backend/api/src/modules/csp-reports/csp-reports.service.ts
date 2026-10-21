import { Inject, Injectable, Logger } from "@nestjs/common";
import { parseCspReports } from "./csp-report-parse.js";
import { CSP_REPORTS_REPOSITORY, MAX_ENTRIES, type CspReportsRepository } from "./csp-reports.repository.js";

export interface CspSummaryEntry {
  directive: string;
  host: string;
  count: number;
  /** ISO-строка момента последнего отчёта */
  lastAt: string;
}

export interface CspSummary {
  /** свежие сверху */
  entries: CspSummaryEntry[];
  /** сколько отчётов не поместилось в сводку — потолок уже занят */
  overflow: number;
  maxEntries: number;
}

/** Как часто напоминать в лог, что запись отчётов не удаётся. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

@Injectable()
export class CspReportsService {
  private readonly logger = new Logger("csp-reports");
  private lastFailureLogAt = Number.NEGATIVE_INFINITY;

  constructor(@Inject(CSP_REPORTS_REPOSITORY) private readonly repository: CspReportsRepository) {}

  /**
   * Записать попадания из тела отчёта. Ошибку хранилища наружу не отдаём:
   * браузер отчёт не повторяет, а игрок его не ждёт.
   */
  async record(body: unknown, nowMs = Date.now()): Promise<void> {
    for (const hit of parseCspReports(body)) {
      try {
        await this.repository.record(hit, nowMs);
      } catch {
        this.warnFailure(nowMs);
        // Хранилище лежит — остальные попадания этого тела пойдут туда же.
        return;
      }
    }
  }

  async summary(): Promise<CspSummary> {
    const { entries, overflow } = await this.repository.read();
    const sorted = [...entries].sort((a, b) => b.lastAtMs - a.lastAtMs || b.count - a.count || `${a.directive}|${a.host}`.localeCompare(`${b.directive}|${b.host}`));
    return {
      entries: sorted.map((entry) => ({ directive: entry.directive, host: entry.host, count: entry.count, lastAt: new Date(entry.lastAtMs).toISOString() })),
      overflow,
      maxEntries: MAX_ENTRIES,
    };
  }

  /** В лог — только факт сбоя: ни причины, ни содержимого отчёта, которое могло бы попасть в текст ошибки. */
  private warnFailure(nowMs: number): void {
    if (nowMs - this.lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) return;
    this.lastFailureLogAt = nowMs;
    this.logger.warn(JSON.stringify({ module: "csp-reports", event: "record_failed" }));
  }
}
