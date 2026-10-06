import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type {
  EventExportRow,
  ExportJournalEntry,
  ExportJournalResult,
  ExportPeriod,
  ExportRepository,
  PageCursor,
  ReportExportRow,
} from "../src/modules/export/export.repository.js";
import { csvCell, ExportService, pseudonymize } from "../src/modules/export/export.service.js";
import { benchSubmission, DEVICE, REPORT_ID } from "./helpers/bench-report.js";
import { unzip } from "./helpers/unzip.js";

// Выгрузка закрытого теста (docs/28-diagnostics.md §6).

const KEY = "a".repeat(64);
const TELEGRAM_ID = "777000111";
const NOW = new Date("2026-09-15T12:00:00Z");

function event(index: number, patch: Partial<EventExportRow> = {}): EventExportRow {
  return {
    eventId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    eventType: "screen_viewed",
    schemaVersion: 1,
    installId: "install-0001",
    platformUserId: index % 2 === 0 ? TELEGRAM_ID : null,
    sessionId: "session-0001",
    platform: "telegram",
    appVersion: index < 10 ? "0.4.0" : "0.4.1",
    payload: { screen: "lobby", stub: false },
    occurredAt: new Date("2026-09-15T10:00:00Z"),
    // Одинаковое время у соседних строк: курсор обязан добирать их по ключу.
    receivedAt: new Date(Date.parse("2026-09-15T10:00:00Z") + Math.floor(index / 3) * 1000),
    ...patch,
  };
}

class MemoryExportRepository implements ExportRepository {
  events: EventExportRow[] = [];
  reports: ReportExportRow[] = [];
  readonly journal = new Map<string, ExportJournalEntry & Partial<ExportJournalResult>>();
  lastTo: Date | null = null;
  eventPages = 0;

  async eventsPage(period: ExportPeriod, after: PageCursor | null, limit: number): Promise<EventExportRow[]> {
    this.eventPages++;
    return page(this.events, period, after, limit, (row) => row.eventId);
  }
  async reportsPage(period: ExportPeriod, after: PageCursor | null, limit: number): Promise<ReportExportRow[]> {
    return page(this.reports, period, after, limit, (row) => row.reportId);
  }
  async recent(): Promise<[]> {
    return [];
  }
  async lastExportTo(): Promise<Date | null> {
    return this.lastTo;
  }
  async start(entry: ExportJournalEntry): Promise<void> {
    this.journal.set(entry.exportId, { ...entry });
  }
  async finish(exportId: string, result: ExportJournalResult): Promise<void> {
    this.journal.set(exportId, { ...this.journal.get(exportId)!, ...result });
  }
}

function page<T extends { receivedAt: Date }>(rows: T[], period: ExportPeriod, after: PageCursor | null, limit: number, id: (row: T) => string): T[] {
  return rows
    .filter((row) => (period.from === null || row.receivedAt >= period.from) && row.receivedAt < period.to)
    .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || id(a).localeCompare(id(b)))
    .filter((row) => after === null || row.receivedAt > after.receivedAt || (row.receivedAt.getTime() === after.receivedAt.getTime() && id(row) > after.id))
    .slice(0, limit);
}

function service(repository: ExportRepository, key = KEY): ExportService {
  return new ExportService(loadAppConfig({ NODE_ENV: "test", EXPORT_PSEUDONYM_KEY: key }), repository);
}

function report(): ReportExportRow {
  return {
    reportId: REPORT_ID,
    kind: "bench",
    schemaVersion: "rubezh.bench.v4",
    appVersion: "0.4.0",
    contentHash: "abc",
    installId: "install-0001",
    platformUserId: TELEGRAM_ID,
    platform: "telegram",
    device: DEVICE,
    summary: { peakObjects: 1211 },
    // Старый отчёт с Telegram ID в теле — выгрузка его всё равно не выпускает.
    payload: benchSubmission(),
    sizeBytes: 1000,
    occurredAt: NOW,
    receivedAt: new Date("2026-09-15T11:00:00Z"),
  };
}

describe("выгрузка закрытого теста", () => {
  it("собирает архив с манифестом, событиями, отчётами и таблицей забегов", async () => {
    const repository = new MemoryExportRepository();
    repository.events = [
      ...Array.from({ length: 2_500 }, (_, index) => event(index)),
      event(9_000, {
        eventType: "run_finished",
        payload: { seed: 7, survivalSec: 412, level: 18, wave: 7, enemiesKilled: 900, weapon: "spark", map: "meadow", difficulty: "normal", contentHash: "abc", isNewRecord: true, cheats: false },
        receivedAt: new Date("2026-09-15T11:30:00Z"),
      }),
    ];
    repository.reports = [report()];

    const artifact = await service(repository).build({ period: { from: null, to: NOW }, source: "cli", requestedBy: "cli" });
    try {
      expect(artifact.parts).toHaveLength(1);
      expect(artifact.counts).toEqual({ events: 2_501, reports: 1, runs: 1 });
      expect(artifact.appVersions).toEqual(["0.4.0", "0.4.1"]);
      // Больше одной страницы: курсор не терял и не дублировал строки с одинаковым временем.
      expect(repository.eventPages).toBeGreaterThan(1);

      const files = unzip(readFileSync(artifact.parts[0]!));
      expect([...files.keys()].sort()).toEqual(["diagnostic_reports.ndjson", "events.ndjson", "manifest.json", "runs.csv"]);
      const events = files.get("events.ndjson")!.toString().trim().split("\n").map((line) => JSON.parse(line) as { event_id: string; user: string | null });
      expect(new Set(events.map((row) => row.event_id)).size).toBe(2_501);
      expect(events[0]?.user).toBe(pseudonymize(TELEGRAM_ID, KEY));

      const manifest = JSON.parse(files.get("manifest.json")!.toString()) as Record<string, unknown>;
      expect(manifest).toMatchObject({ format: "rubezh.export.v1", counts: { events: 2_501, reports: 1, runs: 1 }, eventTypes: { run_finished: 1 } });
      expect((manifest.dictionary as Record<string, { version: number; payload: { type: string } }>).run_finished).toMatchObject({ version: 1, payload: { type: "object" } });
      expect(manifest.reportSchemas).toHaveProperty("bench");

      const runs = files.get("runs.csv")!.toString().trim().split("\n");
      expect(runs[0]).toContain("survivalSec");
      expect(runs[1]).toContain(",412,18,7,900,spark,meadow,normal,abc,true,false");
    } finally {
      await artifact.cleanup();
    }
    expect(existsSync(dirname(artifact.parts[0]!))).toBe(false);
    expect([...repository.journal.values()][0]).toMatchObject({ source: "cli", requestedBy: "cli" });
  });

  it("не выпускает сырых Telegram ID ни из конверта, ни из тела отчёта", async () => {
    const repository = new MemoryExportRepository();
    repository.events = [event(0)];
    repository.reports = [report()];
    const artifact = await service(repository).build({ period: { from: null, to: NOW }, source: "bot", requestedBy: "111" });
    try {
      const archive = unzip(readFileSync(artifact.parts[0]!));
      for (const [name, content] of archive) expect(content.toString(), name).not.toContain(TELEGRAM_ID);
    } finally {
      await artifact.cleanup();
    }
  });

  it("псевдоним стабилен для ключа и меняется со сменой ключа", () => {
    expect(pseudonymize(TELEGRAM_ID, KEY)).toBe(pseudonymize(TELEGRAM_ID, KEY));
    expect(pseudonymize(TELEGRAM_ID, KEY)).not.toBe(pseudonymize(TELEGRAM_ID, "b".repeat(64)));
    expect(pseudonymize(TELEGRAM_ID, KEY)).toMatch(/^u_[0-9a-f]{32}$/);
    expect(pseudonymize(null, KEY)).toBeNull();
  });

  it("без ключа не выгружает, а упавшая выгрузка отмечается в журнале", async () => {
    const repository = new MemoryExportRepository();
    await expect(service(repository, "").build({ period: { from: null, to: NOW }, source: "cli", requestedBy: "cli" })).rejects.toThrow(/EXPORT_PSEUDONYM_KEY/);

    repository.eventsPage = async () => Promise.reject(new Error("statement timeout"));
    await expect(service(repository).build({ period: { from: null, to: NOW }, source: "bot", requestedBy: "111" })).rejects.toThrow(/statement timeout/);
    expect([...repository.journal.values()][0]).toMatchObject({ status: "failed", error: "statement timeout" });
  });

  it("«с последней выгрузки» начинается там, где кончилась прошлая", async () => {
    const repository = new MemoryExportRepository();
    expect(await service(repository).sinceLastExport("111", NOW)).toEqual({ from: null, to: NOW });
    repository.lastTo = new Date("2026-09-14T12:00:00Z");
    expect(await service(repository).sinceLastExport("111", NOW)).toEqual({ from: repository.lastTo, to: NOW });
  });

  it("экранирует ячейки CSV и не даёт табличному редактору принять их за формулы", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(null)).toBe("");
  });
});
