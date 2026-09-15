import type { RunRecording } from "@bh/core-game";
import { describeDevice } from "./device";
import { sendDiagnosticReport, type RunReportEnvelope } from "./diagnostic-reports";
import { useInstall } from "./install";
import { usePlatform } from "./platform";
import { createReportQueue, type ReportQueue } from "./report-queue";
import { reportError, useShell } from "./shell";

/**
 * Запись забега → очередь отчётов (docs/28-diagnostics.md §3.3, §4).
 *
 * Модуль грузится отдельным чанком: запись нужна тестерам, а первая загрузка
 * у всех игроков на пределе бюджета. Забег приходит сюда, когда уже кончился.
 */

let queue: ReportQueue | null = null;
let started = false;

/** Одна очередь на приложение: экран «Последних отчётов» и забег видят одно и то же. */
export function reportQueue(): ReportQueue {
  if (queue !== null) return queue;
  queue = createReportQueue({
    storage: useShell.getState().storage,
    send: (body) => sendDiagnosticReport(body),
    onDropped: (report, failure) => reportError("reports", `отчёт ${report.kind} отвергнут сервером: ${failure}`),
  });
  return queue;
}

/** Запуск приложения: дослать то, что не ушло, и досылать при появлении сети. */
export function startReportQueue(): void {
  if (started) return;
  started = true;
  const reports = reportQueue();
  globalThis.addEventListener("online", () => void reports.flush("online"));
  void reports.flush("launch");
}

export function queueRunReport(recording: RunRecording, clientErrors: number): void {
  startReportQueue();
  const { adapter, build } = useShell.getState();
  const { insets } = usePlatform.getState();
  reportQueue().enqueue({ reportId: recording.reportId, kind: "run" }, (evictedReports) => {
    const envelope: RunReportEnvelope = {
      reportId: recording.reportId,
      kind: "run",
      appVersion: build.version,
      contentHash: build.contentHash === "" ? null : build.contentHash,
      installId: useInstall.getState().installId,
      platform: build.platform,
      occurredAt: recording.startedAt,
      device: describeDevice(adapter.clientInfo()),
      payload: {
        recording,
        client: {
          screenMode: adapter.ui.screenMode,
          insets: { top: insets.top, right: insets.right, bottom: insets.bottom, left: insets.left },
          clientErrors,
          evictedReports,
        },
      },
    };
    return JSON.stringify(envelope);
  });
}
