import type { BenchIngestConfig, BenchSubmission } from "./types";

export interface SendResult {
  ok: boolean;
  /** текст для показа на экране устройства — консоли под рукой нет */
  message: string;
}

/** Прогон длинный и дорогой, поэтому отправке даётся заметный запас времени. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Отправка отчёта на приёмник результатов.
 *
 * Таймаут обязателен: без него зависший запрос в мобильной сети оставляет
 * стенд в состоянии «отправляю» навсегда, и человек с телефоном в руках не
 * понимает, ждать ему или нет (CLAUDE.md, «Стиль кода»: каждый await внешнего
 * вызова — с таймаутом).
 */
export async function sendBenchReport(
  ingest: BenchIngestConfig,
  submission: BenchSubmission,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<SendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(ingest.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bench-token": ingest.token,
      },
      body: JSON.stringify(submission),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, message: `Сервер ответил ${response.status}` };
    }
    return { ok: true, message: "Отчёт отправлен" };
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, message: `Таймаут отправки (${timeoutMs / 1000} с)` };
    }
    return { ok: false, message: `Не удалось отправить: ${describeError(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
