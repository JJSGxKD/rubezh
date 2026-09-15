import type { BenchSubmission, RunRecording } from "@bh/core-game";
import type { PlaytestDevice } from "@bh/shared-types";
import { z } from "zod/mini";
import { useShell } from "./shell";

/**
 * Отправка отчёта диагностики на `POST /api/v1/diagnostics/reports`
 * (docs/28-diagnostics.md §4–§5). Отчёт уходит и без подписи запуска: подпись
 * лишь добавляет к нему Telegram ID тестера.
 *
 * - `disabled` — приёмника нет в этой сборке или на сервере;
 * - `forbidden` — стресс-тест этому игроку сейчас закрыт;
 * - `rejected` — сервер отверг сам отчёт, повтор не поможет;
 * - `offline` — сеть или таймаут, повторить позже;
 * - `limited` — лимит частоты на устройство, повторить позже;
 * - `unavailable` — сервер или база недоступны, повторить позже.
 */
export type ReportFailure = "disabled" | "forbidden" | "rejected" | "offline" | "limited" | "unavailable";

interface EnvelopeBase {
  reportId: string;
  appVersion: string;
  contentHash: string | null;
  installId: string;
  platform: string;
  occurredAt: string;
  device: PlaytestDevice;
}

export interface BenchReportEnvelope extends EnvelopeBase {
  kind: "bench";
  payload: BenchSubmission;
}

/** Запись забега и то, что о забеге знает только оболочка (docs/28-diagnostics.md §3.3). */
export interface RunReportEnvelope extends EnvelopeBase {
  kind: "run";
  payload: {
    recording: RunRecording;
    client: RunReportClient;
  };
}

export interface RunReportClient {
  screenMode: string;
  /** отступы безопасной зоны в CSS-пикселях */
  insets: { top: number; right: number; bottom: number; left: number };
  /** ошибок клиента за забег */
  clientErrors: number;
  /** сколько отчётов вытеснено из очереди на устройстве до этого */
  evictedReports: number;
}

export type DiagnosticReportEnvelope = BenchReportEnvelope | RunReportEnvelope;

/** Отчёты большие, а мобильная сеть медленная: ждём дольше, чем события. */
const REPORT_TIMEOUT_MS = 20_000;

const responseSchema = z.object({ data: z.object({ duplicate: z.boolean() }) });

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** `envelope` — объект или уже собранный JSON: очередь хранит отчёт строкой. */
export async function sendDiagnosticReport(
  envelope: DiagnosticReportEnvelope | string,
  fetchImpl: Fetch = (input, init) => globalThis.fetch(input, init),
): Promise<ReportFailure | null> {
  const { capabilities, adapter } = useShell.getState();
  if (capabilities.telemetry === undefined) return "disabled";

  const url = `${capabilities.telemetry.baseUrl.replace(/\/+$/, "")}/api/v1/diagnostics/reports`;
  const launch = adapter.signedLaunchData();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(launch === null || launch === "" ? {} : { authorization: `tma ${launch}` }),
      },
      body: typeof envelope === "string" ? envelope : JSON.stringify(envelope),
      signal: controller.signal,
    });
  } catch {
    // Обрыв сети и таймаут одинаковы: отчёт можно отправить ещё раз.
    return "offline";
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404) return "disabled";
  if (response.status === 403) return "forbidden";
  if (response.status === 400 || response.status === 413) return "rejected";
  if (response.status === 429) return "limited";
  if (!response.ok) return "unavailable";
  try {
    // Дубликат — тоже успех: отчёт уже на сервере.
    return responseSchema.safeParse(await response.json()).success ? null : "unavailable";
  } catch {
    // Тело не JSON — страница ошибки прокси вместо ответа API.
    return "unavailable";
  }
}
