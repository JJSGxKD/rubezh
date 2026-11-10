import { GrammyError, HttpError, type Api } from "grammy";

/**
 * Вызов метода Bot API через grammY с таймаутом и нашей ошибкой. Модули
 * ветвятся по `TelegramApiError` — коду и `retry_after`, — а не по классам
 * grammY: так они не зависят от библиотеки, и замена транспорта их не трогает.
 */

/**
 * Сигнал отмены в типах grammY. На Node они описывают его через полифил
 * `abort-controller`, и нативный `AbortSignal` с ним структурно не сходится,
 * хотя grammY лишь передаёт сигнал дальше — в наш нативный `fetch`.
 */
export type GrammySignal = NonNullable<Parameters<Api["getMe"]>[0]>;

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number,
    description: string,
    /** секунды до повтора при `429` */
    readonly retryAfterSec: number | null,
  ) {
    super(`Bot API ${method}: ${errorCode} ${description}`);
    this.name = "TelegramApiError";
  }
}

/** Срок вызова и сигнал вызывающего — отмена наступает по первому из них. */
export function callSignal(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
}

/** Сетевая ошибка без URL: в нём живёт токен бота. */
export function networkError(method: string, cause: unknown): TelegramApiError {
  const reason = cause instanceof Error ? cause.name : "unknown";
  return new TelegramApiError(method, 0, `сеть недоступна (${reason})`, null);
}

export async function callBotApi<T>(
  method: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  run: (abort: GrammySignal) => Promise<T>,
): Promise<T> {
  const abort = callSignal(timeoutMs, signal);
  try {
    // Расхождение только в типах полифила (см. GrammySignal): во время
    // работы это тот же нативный сигнал, который понимает наш `fetch`.
    return await run(abort as unknown as GrammySignal);
  } catch (error: unknown) {
    if (error instanceof GrammyError) {
      throw new TelegramApiError(method, error.error_code, error.description, error.parameters.retry_after ?? null);
    }
    // Сетевая ошибка может нести URL с токеном в `cause` — наружу уходит
    // только имя метода и тип исходной ошибки.
    throw networkError(method, error instanceof HttpError ? error.error : error);
  }
}
