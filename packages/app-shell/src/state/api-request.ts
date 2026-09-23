import { z } from "zod/mini";
import type { AuthFailure } from "./auth-api";

/**
 * Запрос к API от имени игрока (docs/34-stage3-plan.md, WP4): забеги, отчёты
 * о запуске, доступ к инструментам. Токен подставляет сессия, протухший она
 * обновляет сама (`session.ts`, `authorizedFetch`).
 *
 * Сессия приходит отдельным чанком: она нужна рейтингу и деньгам, а не
 * первому кадру, и статический импорт утащил бы её в первую загрузку
 * (`pnpm budget`). Сюда она подгружается при первом запросе.
 *
 * Ответ сервера — граница системы и разбирается схемой, а не `as`: сервер
 * мог обновиться раньше клиента.
 */

/**
 * Почему запрос не удался — ровно столько, сколько нужно решить, что делать:
 * повторить позже, выбросить или сказать игроку.
 *
 * - `no_identity` — войти нечем: игра открыта мимо площадки;
 * - `offline` — сеть или таймаут;
 * - `unauthorized` — вход не принят или сессия сброшена;
 * - `disabled` — функция выключена на сервере или в этой сборке;
 * - `rejected` — сервер отверг сами данные: повтор не поможет;
 * - `unavailable` — сервер или хранилище недоступны, либо ответ не разобрался.
 */
export const API_FAILURES = ["no_identity", "offline", "unauthorized", "disabled", "rejected", "unavailable"] as const;

export type ApiFailure = (typeof API_FAILURES)[number];

export type ApiResult<T> = { ok: true; data: T } | { ok: false; failure: ApiFailure };

export type ApiRequest = <T>(
  path: string,
  schema: z.ZodMiniType<T>,
  init: { method: "GET" | "POST"; body?: unknown },
) => Promise<ApiResult<T>>;

export const apiRequest: ApiRequest = async (path, schema, init) => {
  const { authorizedFetch, useSession } = await import("./session");

  let response: Response | null;
  try {
    response = await authorizedFetch(path, {
      method: init.method,
      ...(init.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
    });
  } catch {
    // Обрыв сети и таймаут игроку одинаковы: забег подождёт в очереди.
    return { ok: false, failure: "offline" };
  }
  // Сессии нет — запрос и не уходил: причину знает сессия.
  if (response === null) return { ok: false, failure: sessionFailure(useSession.getState().failure) };
  if (!response.ok) return { ok: false, failure: failureOf(response.status) };

  try {
    const parsed = z.object({ data: schema }).safeParse(await response.json());
    return parsed.success ? { ok: true, data: parsed.data.data } : { ok: false, failure: "unavailable" };
  } catch {
    // Тело не JSON — например, страница ошибки прокси вместо ответа API.
    return { ok: false, failure: "unavailable" };
  }
};

/**
 * Причина из сессии — в причину запроса. Заблокированный и не принятый вход
 * для запроса одинаковы: повтор не поможет, нужен вход заново. `null` —
 * авторизации нет в сборке.
 */
export function sessionFailure(failure: AuthFailure | null): ApiFailure {
  switch (failure) {
    case "no_identity":
    case "offline":
    case "disabled":
    case "unavailable":
      return failure;
    case "unauthorized":
    case "banned":
    case "rejected":
      return "unauthorized";
    case null:
      return "disabled";
  }
}

export function failureOf(status: number): ApiFailure {
  if (status === 401) return "unauthorized";
  // 403 — функция закрыта для этого игрока: для него это то же, что выключена.
  if (status === 404 || status === 403) return "disabled";
  if (status === 400 || status === 413 || status === 422) return "rejected";
  return "unavailable";
}
