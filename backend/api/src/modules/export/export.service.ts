import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { splitFile, ZipWriter } from "../../common/zip/zip-writer.js";
import { submitBenchReportSchema } from "../diagnostics/dto/bench-report.dto.js";
import { submitRunReportSchema } from "../diagnostics/dto/run-report.dto.js";
import { EVENT_DICTIONARY } from "../events/event-dictionary.js";
import {
  EXPORT_REPOSITORY,
  type EventExportRow,
  type ExportPeriod,
  type ExportRepository,
  type PageCursor,
  type ReportExportRow,
} from "./export.repository.js";

/**
 * Выгрузка закрытого теста для разбора ИИ-агентом (docs/26-stage2-plan.md, Р11;
 * docs/28-diagnostics.md §6). Один сервис на два входа — кнопку в боте и
 * `pnpm closed-test:export`: одинаковый результат, одна реализация.
 *
 * Архив:
 * - `manifest.json` — период, счётчики, версии сборок и **снимок словаря
 *   событий и схем `payload`**: без него агент гадает, что значит поле;
 * - `events.ndjson`, `diagnostic_reports.ndjson` — строки как в базе;
 * - `runs.csv` — плоская таблица итогов забегов для быстрого взгляда.
 *
 * Telegram ID в выгрузке нет — только псевдоним HMAC-SHA256 с секретным
 * ключом окружения: архив лежит в облаке Telegram и уходит во внешний сервис
 * анализа (§8). IP не хранится вовсе, поэтому и выгружать его нечего.
 */

export const EXPORT_FORMAT = "rubezh.export.v1";
/** Bot API принимает документы до 50 МБ — части с запасом. */
export const EXPORT_PART_BYTES = 45 * 1024 * 1024;
const EVENTS_PAGE = 2_000;
/** Отчёты с таймлайнами тяжелее событий — страницы меньше. */
const REPORTS_PAGE = 100;
/** Пауза между страницами: выгрузка читает ту же базу, что принимает события. */
const PAGE_PAUSE_MS = 25;

const RUN_EVENTS = new Set(["run_finished", "run_abandoned"]);
const RUN_COLUMNS = ["received_at", "occurred_at", "event_type", "install_id", "user", "app_version", "seed", "survivalSec", "level", "wave", "enemiesKilled", "weapon", "map", "difficulty", "contentHash", "isNewRecord", "cheats", "perfAvgFps", "perfP95FrameMs", "perfOver33Ratio", "perfPeakObjects", "perfDisplayHz", "perfInterruptions"] as const;

export interface ExportRequest {
  period: ExportPeriod;
  source: "bot" | "cli" | "panel";
  /** Telegram ID администратора — из бота или панели — либо `cli`; в журнал выгрузок */
  requestedBy: string;
}

export interface ExportArtifact {
  exportId: string;
  period: ExportPeriod;
  fileName: string;
  /** архив целиком — для отдачи файлом из панели, где предела в 50 МБ нет */
  zipPath: string;
  /** файлы для отправки: один архив или его части по порядку */
  parts: string[];
  sizeBytes: number;
  counts: { events: number; reports: number; runs: number };
  appVersions: string[];
  /** удалить временные файлы — в любом исходе */
  cleanup(): Promise<void>;
}

/** Псевдоним Telegram ID: стабилен в пределах окружения, не обращается без ключа. */
export function pseudonymize(platformUserId: string | null, key: string): string | null {
  if (platformUserId === null) return null;
  return `u_${createHmac("sha256", Buffer.from(key, "hex")).update(platformUserId).digest("hex").slice(0, 32)}`;
}

@Injectable()
export class ExportService {
  private readonly logger = new Logger("export");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EXPORT_REPOSITORY) private readonly repository: ExportRepository,
  ) {}

  /** Период «с последней выгрузки»: от конца прошлой удачной, а если её не было — весь тест. */
  async sinceLastExport(requestedBy: string, now: Date): Promise<ExportPeriod> {
    return { from: await this.repository.lastExportTo(requestedBy), to: now };
  }

  async build(request: ExportRequest): Promise<ExportArtifact> {
    const key = this.config.export.pseudonymKey;
    if (key === "") throw new Error("Выгрузка без EXPORT_PSEUDONYM_KEY невозможна: Telegram ID нечем скрыть");

    const exportId = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), "rubezh-export-"));
    const cleanup = (): Promise<void> => rm(dir, { recursive: true, force: true });
    await this.repository.start({ exportId, source: request.source, requestedBy: request.requestedBy, period: request.period });

    try {
      const fileName = `rubezh-export-${dayOf(request.period.from)}-${dayOf(request.period.to)}-${exportId.slice(0, 8)}.zip`;
      const zipPath = join(dir, fileName);
      const runsPath = join(dir, "runs.csv");
      const counts = { events: 0, reports: 0, runs: 0 };
      const appVersions = new Set<string>();
      const eventTypes: Record<string, number> = {};

      const zip = new ZipWriter(zipPath);
      const runs = createWriteStream(runsPath);
      await writeLine(runs, `${RUN_COLUMNS.join(",")}\n`);

      await zip.addFile(
        "events.ndjson",
        this.eventLines(request.period, key, async (row, user) => {
          counts.events++;
          appVersions.add(row.appVersion);
          eventTypes[row.eventType] = (eventTypes[row.eventType] ?? 0) + 1;
          if (RUN_EVENTS.has(row.eventType)) {
            counts.runs++;
            await writeLine(runs, runLine(row, user));
          }
        }),
      );
      runs.end();
      await once(runs, "finish");

      await zip.addFile(
        "diagnostic_reports.ndjson",
        this.reportLines(request.period, key, (row) => {
          counts.reports++;
          appVersions.add(row.appVersion);
        }),
      );
      await zip.addFile("runs.csv", createReadStream(runsPath));
      await zip.addFile(
        "manifest.json",
        single(JSON.stringify(manifest({ exportId, request, counts, eventTypes, appVersions: [...appVersions].sort() }), null, 2)),
      );
      const sizeBytes = await zip.finish();
      const parts = await splitFile(zipPath, EXPORT_PART_BYTES, join(dir, "parts"));

      this.logger.log(
        JSON.stringify({
          module: "export",
          event: "export_built",
          exportId,
          source: request.source,
          requestedBy: request.requestedBy,
          from: request.period.from?.toISOString() ?? null,
          to: request.period.to.toISOString(),
          ...counts,
          sizeBytes,
          parts: parts.length,
        }),
      );
      return { exportId, period: request.period, fileName, zipPath, parts, sizeBytes, counts, appVersions: [...appVersions].sort(), cleanup };
    } catch (error: unknown) {
      await cleanup();
      await this.finish(exportId, { status: "failed", events: 0, reports: 0, sizeBytes: 0, parts: 0, error: error instanceof Error ? error.message : "unknown" });
      throw error;
    }
  }

  /** Отметить в журнале, чем кончилась выгрузка: отправлена или нет. */
  async finish(exportId: string, result: Parameters<ExportRepository["finish"]>[1]): Promise<void> {
    await this.repository.finish(exportId, result).catch((error: unknown) => {
      this.logger.error(JSON.stringify({ module: "export", event: "journal_failed", exportId, reason: error instanceof Error ? error.message : "unknown" }));
    });
  }

  private async *eventLines(period: ExportPeriod, key: string, onRow: (row: EventExportRow, user: string | null) => Promise<void>): AsyncIterable<string> {
    let cursor: PageCursor | null = null;
    for (;;) {
      const page = await this.repository.eventsPage(period, cursor, EVENTS_PAGE);
      if (page.length === 0) return;
      const lines: string[] = [];
      for (const row of page) {
        const user = pseudonymize(row.platformUserId, key);
        await onRow(row, user);
        lines.push(
          JSON.stringify({
            event_id: row.eventId,
            event_type: row.eventType,
            schema_version: row.schemaVersion,
            install_id: row.installId,
            user,
            session_id: row.sessionId,
            platform: row.platform,
            app_version: row.appVersion,
            payload: row.payload,
            occurred_at: row.occurredAt.toISOString(),
            received_at: row.receivedAt.toISOString(),
          }),
        );
      }
      yield `${lines.join("\n")}\n`;
      const last = page[page.length - 1];
      if (last === undefined || page.length < EVENTS_PAGE) return;
      cursor = { receivedAt: last.receivedAt, id: last.eventId };
      await sleep(PAGE_PAUSE_MS);
    }
  }

  private async *reportLines(period: ExportPeriod, key: string, onRow: (row: ReportExportRow) => void): AsyncIterable<string> {
    let cursor: PageCursor | null = null;
    for (;;) {
      const page = await this.repository.reportsPage(period, cursor, REPORTS_PAGE);
      if (page.length === 0) return;
      for (const row of page) {
        onRow(row);
        yield `${JSON.stringify({
          report_id: row.reportId,
          kind: row.kind,
          schema_version: row.schemaVersion,
          app_version: row.appVersion,
          content_hash: row.contentHash,
          install_id: row.installId,
          user: pseudonymize(row.platformUserId, key),
          platform: row.platform,
          device: row.device,
          summary: row.summary,
          payload: withoutTelegramId(row.payload),
          size_bytes: row.sizeBytes,
          occurred_at: row.occurredAt.toISOString(),
          received_at: row.receivedAt.toISOString(),
        })}\n`;
      }
      const last = page[page.length - 1];
      if (last === undefined || page.length < REPORTS_PAGE) return;
      cursor = { receivedAt: last.receivedAt, id: last.reportId };
      await sleep(PAGE_PAUSE_MS);
    }
  }
}

/**
 * Приёмник уже не записывает Telegram ID из тела отчёта, но выгрузка — последний
 * рубеж перед внешним сервисом: поле обнуляется и здесь.
 */
function withoutTelegramId(payload: unknown): unknown {
  const parsed = z.object({ report: z.object({ device: z.object({}).loose() }).loose() }).loose().safeParse(payload);
  if (!parsed.success) return payload;
  return { ...parsed.data, report: { ...parsed.data.report, device: { ...parsed.data.report.device, telegramUserId: null } } };
}

function runLine(row: EventExportRow, user: string | null): string {
  const payload = z.record(z.string(), z.unknown()).safeParse(row.payload);
  const values: Record<string, unknown> = payload.success ? payload.data : {};
  const cells = RUN_COLUMNS.map((column) => {
    switch (column) {
      case "received_at":
        return row.receivedAt.toISOString();
      case "occurred_at":
        return row.occurredAt.toISOString();
      case "event_type":
        return row.eventType;
      case "install_id":
        return row.installId;
      case "user":
        return user ?? "";
      case "app_version":
        return row.appVersion;
      default:
        return values[column] ?? "";
    }
  });
  return `${cells.map(csvCell).join(",")}\n`;
}

/** Ячейка CSV: кавычки вокруг всего, что содержит разделитель, кавычку или перевод строки. */
export function csvCell(value: unknown): string {
  const raw = typeof value === "string" ? value : value === null || value === undefined ? "" : JSON.stringify(value);
  // Ячейка, начинающаяся с «=», «+», «-», «@», в табличном редакторе станет формулой.
  const safe = /^[=+\-@]/.test(raw) && Number.isNaN(Number(raw)) ? `'${raw}` : raw;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function manifest(input: {
  exportId: string;
  request: ExportRequest;
  counts: ExportArtifact["counts"];
  eventTypes: Record<string, number>;
  appVersions: string[];
}): Record<string, unknown> {
  return {
    format: EXPORT_FORMAT,
    exportId: input.exportId,
    generatedAt: new Date().toISOString(),
    source: input.request.source,
    period: { from: input.request.period.from?.toISOString() ?? null, to: input.request.period.to.toISOString(), field: "received_at, UTC" },
    counts: input.counts,
    eventTypes: input.eventTypes,
    appVersions: input.appVersions,
    files: {
      "events.ndjson": "события закрытого теста, по строке на событие: конверт docs/22-analytics-and-metrics.md §3.1, payload — по схеме из dictionary",
      "diagnostic_reports.ndjson": "отчёты диагностики целиком: стресс-тест (kind=bench) с таймлайном кадров по 5 секунд и записи забегов (kind=run) — таймлайн, события, лог ввода; повтор забега — pnpm replay <reportId> --from diagnostic_reports.ndjson",
      "runs.csv": "итоги забегов из событий run_finished и run_abandoned плоской таблицей",
    },
    pseudonymization:
      "user — HMAC-SHA256 от Telegram ID с секретным ключом окружения, первые 32 знака. Один игрок — один псевдоним в любой выгрузке этого окружения; сырых Telegram ID и IP в архиве нет",
    dictionary: Object.fromEntries(
      Object.entries(EVENT_DICTIONARY).map(([name, definition]) => [
        name,
        { version: definition.version, payload: z.toJSONSchema(definition.payload, { unrepresentable: "any" }) },
      ]),
    ),
    reportSchemas: {
      bench: z.toJSONSchema(submitBenchReportSchema, { unrepresentable: "any" }),
      run: z.toJSONSchema(submitRunReportSchema, { unrepresentable: "any" }),
    },
  };
}

async function writeLine(stream: NodeJS.WritableStream, line: string): Promise<void> {
  if (!stream.write(line)) await once(stream, "drain");
}

async function* single(value: string): AsyncIterable<string> {
  yield value;
}

function dayOf(date: Date | null): string {
  return date === null ? "start" : date.toISOString().slice(0, 10);
}
