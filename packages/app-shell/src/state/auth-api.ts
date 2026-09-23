import { z } from "zod/mini";

/**
 * Клиент авторизации: обмен подписанных данных запуска на сессию
 * (docs/34-stage3-plan.md, WP1).
 *
 * Ответ сервера — граница системы и разбирается схемой, а не `as`: сервер
 * мог обновиться раньше клиента.
 */

export interface AuthApiConfig {
  /** адрес API без косой в конце; пусто — тот же домен, что у приложения */
  baseUrl: string;
}

export interface AuthAccount {
  accountId: string;
  displayName: string;
  photoUrl: string | null;
  createdAt: string;
  /** аккаунт заведён этим входом — по нему шлётся `user_registered` */
  created: boolean;
}

export interface Session {
  accessToken: string;
  /** сколько секунд жив токен доступа: клиент обновляет сессию заранее */
  expiresInSec: number;
  refreshToken: string;
  account: AuthAccount;
}

/**
 * Почему не удалось — ровно столько, сколько нужно решить, что делать:
 *
 * - `no_identity` — нечем подписать вход: игра открыта мимо площадки;
 * - `offline` — сеть или таймаут, повторить позже;
 * - `unauthorized` — подпись не принята или сессия сброшена: нужен вход заново;
 * - `banned` — аккаунт заблокирован, и у отказа есть текст для игрока;
 * - `disabled` — авторизация на сервере выключена;
 * - `rejected` — сервер отверг сами данные, повтор не поможет;
 * - `unavailable` — сервер недоступен либо ответ не разобрался.
 */
export const AUTH_FAILURES = [
  "no_identity",
  "offline",
  "unauthorized",
  "banned",
  "disabled",
  "rejected",
  "unavailable",
] as const;

export type AuthFailure = (typeof AUTH_FAILURES)[number];

export type AuthResult<T> =
  | { ok: true; data: T }
  | { ok: false; failure: AuthFailure; message?: string };

export interface AuthApi {
  login(signedLaunchData: string): Promise<AuthResult<Session>>;
  refresh(refreshToken: string): Promise<AuthResult<Session>>;
  logout(refreshToken: string): Promise<void>;
}

/**
 * Сколько ждать ответа. Вход стоит между заставкой и главной, и висеть на нём
 * дольше нельзя: не дождались — играем без сессии, она подхватится позже.
 */
export const AUTH_TIMEOUT_MS = 8_000;

const API_PREFIX = "/api/v1/auth";

const sessionSchema = z.object({
  accessToken: z.string(),
  expiresInSec: z.number(),
  refreshToken: z.string(),
  account: z.object({
    accountId: z.string(),
    displayName: z.string(),
    photoUrl: z.nullable(z.string()),
    createdAt: z.string(),
    created: z.boolean(),
  }),
});

/** Тело ошибки бэкенда: код для ветвления, текст — человеку. */
const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export function createAuthApi(
  config: AuthApiConfig,
  fetchImpl: Fetch = (input, init) => globalThis.fetch(input, init),
): AuthApi {
  const base = `${config.baseUrl.replace(/\/+$/, "")}${API_PREFIX}`;

  async function post<T>(path: string, body: unknown, schema: z.ZodMiniType<T>): Promise<AuthResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      // Обрыв сети и таймаут игроку одинаковы: сессия подхватится позже.
      return { ok: false, failure: "offline" };
    } finally {
      clearTimeout(timer);
    }

    const payload: unknown = await readJson(response);
    if (!response.ok) return failureOf(response.status, payload);

    const parsed = z.object({ data: schema }).safeParse(payload);
    return parsed.success ? { ok: true, data: parsed.data.data } : { ok: false, failure: "unavailable" };
  }

  return {
    login: (signedLaunchData) => post("/telegram", { initData: signedLaunchData }, sessionSchema),
    refresh: (refreshToken) => post("/refresh", { refreshToken }, sessionSchema),
    async logout(refreshToken) {
      // Выход — лучшее усилие: не дошёл до сервера, и ладно, токен всё равно
      // забыт на клиенте, а сам он протухнет по сроку.
      await post("/logout", { refreshToken }, z.object({ loggedOut: z.boolean() }));
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // Тело не JSON — например, страница ошибки прокси вместо ответа API.
    return null;
  }
}

function failureOf(status: number, payload: unknown): AuthResult<never> {
  const parsed = errorSchema.safeParse(payload);
  const message = parsed.success ? parsed.data.error.message : undefined;

  // Блокировка приходит с текстом причины, и этот текст игрок увидит: «вход
  // не удался» ничего не объясняет тому, кого заблокировали за читы.
  if (status === 403) return { ok: false, failure: "banned", ...(message === undefined ? {} : { message }) };
  if (status === 401) return { ok: false, failure: "unauthorized" };
  if (status === 404) return { ok: false, failure: "disabled" };
  // 429 — не отказ по существу: лимит частоты отпустит через минуту.
  if (status === 429) return { ok: false, failure: "offline" };
  if (status === 400 || status === 413 || status === 422) return { ok: false, failure: "rejected" };
  return { ok: false, failure: "unavailable" };
}
