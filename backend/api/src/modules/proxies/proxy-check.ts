import { z } from "zod";
import { withTimeout } from "../../common/with-timeout.js";
import type { OutboundProxy, ProxyFetch } from "../../infra/outbound/outbound-route.js";

/**
 * Проверка прокси из панели (docs/35-stage4-plan.md Р91): запрос на ipify
 * через этот прокси — виден внешний адрес и время ответа. Адрес запроса
 * зашит: проверка не превращает панель в способ ходить на произвольные
 * адреса через прокси.
 */
export const CHECK_URL = "https://api.ipify.org?format=json";
export const CHECK_TIMEOUT_MS = 5_000;
/** колонка `last_check_note` — 200 знаков */
const NOTE_MAX = 200;

const answerSchema = z.object({ ip: z.string().min(3).max(64) });

export interface CheckOutcome {
  ok: boolean;
  /** итог словами: внешний адрес и время или причина сбоя; без текста исключения — в нём бывают адрес и логин */
  note: string;
}

export async function runProxyCheck(proxyFetch: ProxyFetch, proxy: OutboundProxy): Promise<CheckOutcome> {
  const started = performance.now();
  try {
    const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
    const response = await proxyFetch(proxy, CHECK_URL, { signal });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      return fail(response.status === 407 ? "Прокси ответил 407: нужен логин и пароль или они неверны" : `Прокси ответил ${String(response.status)}`);
    }
    const answer = answerSchema.safeParse(await readJson(response));
    if (!answer.success) return fail(NOT_AN_ADDRESS);
    return { ok: true, note: clip(`Внешний адрес ${answer.data.ip} · ${String(Math.round(performance.now() - started))} мс`) };
  } catch (error: unknown) {
    return fail(reasonOf(error));
  }
}

const NOT_AN_ADDRESS = "Ответ не похож на внешний адрес — это не прокси или он перехватывает запросы";

/** Тело, не ставшее JSON, — тот же итог, что и ответ не по форме: сбоем соединения это не назвать. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await withTimeout(response.json(), CHECK_TIMEOUT_MS, "ответ ipify");
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function fail(note: string): CheckOutcome {
  return { ok: false, note: clip(note) };
}

const clip = (text: string): string => (text.length > NOTE_MAX ? `${text.slice(0, NOTE_MAX - 1)}…` : text);

/** Причина сбоя: тип и код системной ошибки, но не её текст. */
function reasonOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (name === "TimeoutError" || name === "AbortError") return `Нет ответа за ${String(CHECK_TIMEOUT_MS / 1000)} с`;
    const cause = (error as { cause?: unknown }).cause;
    const code = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{3,40}$/.test(code)) return `Сбой соединения (${code})`;
  }
  return "Сбой соединения с прокси";
}
