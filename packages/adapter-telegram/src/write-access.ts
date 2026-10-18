import { on, postEvent } from "@tma.js/sdk";

/**
 * Разрешение боту писать — отдельным чанком: адаптер берёт этот модуль по
 * нажатию кнопки, первому кадру он не нужен (tasks/T-0010).
 *
 * Запрос — событие моста `web_app_request_write_access`, ответ — событие
 * `write_access_requested` со статусом `allowed` или `cancelled`.
 */

export type WriteAccessResult = "allowed" | "declined" | "unavailable";

/** Что нужно от моста Telegram — подменяется в тестах. */
export interface WriteAccessBridge {
  /** Подписка на ответ; возвращает отписку. */
  onRequested(handler: (status: string) => void): () => void;
  /** Отправить запрос; бросает, если мост его не принял. */
  postRequest(): void;
}

/** Сколько ждать ответа: игрок читает системное окно, но вечно подписку не держим. */
export const WRITE_ACCESS_TIMEOUT_MS = 60_000;

export async function requestWriteAccessWith(bridge: WriteAccessBridge, timeoutMs: number): Promise<WriteAccessResult> {
  return await new Promise<WriteAccessResult>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let off: (() => void) | undefined;
    const finish = (result: WriteAccessResult): void => {
      if (timer !== undefined) clearTimeout(timer);
      off?.();
      resolve(result);
    };
    // Иной статус разрешением не считаем: просить повторно проще, чем писать без согласия.
    off = bridge.onRequested((status) => finish(status === "allowed" ? "allowed" : "declined"));
    timer = setTimeout(() => finish("declined"), timeoutMs);
    try {
      bridge.postRequest();
    } catch {
      // Клиент не принял событие (старый Telegram или сбой моста) — сообщаем, что запроса не было.
      finish("unavailable");
    }
  });
}

const bridge: WriteAccessBridge = {
  onRequested: (handler) => on("write_access_requested", (payload) => handler(payload.status)),
  postRequest: () => postEvent("web_app_request_write_access"),
};

/** Поддержку уже проверил адаптер (`requestBotMessages`) — здесь только запрос. */
export async function requestWriteAccess(): Promise<WriteAccessResult> {
  return await requestWriteAccessWith(bridge, WRITE_ACCESS_TIMEOUT_MS);
}
