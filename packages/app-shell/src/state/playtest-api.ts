import {
  DIFFICULTY_IDS,
  type DifficultyId,
  type PlaytestLeaderboard,
  type PlaytestProfile,
  type PlaytestRunSubmission,
  type PlaytestSubmitResult,
} from "@bh/shared-types";
import { z } from "zod/mini";

/**
 * Клиент бэкенда плейтеста: сохранения итогов и лидерборд
 * (docs/26-stage2-plan.md, WP13).
 *
 * Игрок узнаётся по подписанным данным запуска площадки — в Telegram это
 * `initData` в заголовке `Authorization: tma …`. Сессий и токенов нет: сервер
 * проверяет подпись на каждом запросе.
 *
 * Ответ сервера — граница системы и разбирается схемой, а не `as`: сервер
 * мог обновиться раньше клиента.
 */
export interface PlaytestApiConfig {
  /** адрес API без косой в конце; пусто — тот же домен, что у приложения */
  baseUrl: string;
  /**
   * Вход без площадки на машине разработчика — «id:Имя». Пусто — выключен.
   * Приложение передаёт его только из dev-сервера.
   */
  devUser: string;
}

/**
 * Почему запрос не удался — ровно столько, сколько нужно решить, что делать:
 * повторить позже, выбросить или сказать игроку.
 *
 * - `no_identity` — нечем подписать запрос: игра открыта мимо площадки;
 * - `offline` — сеть или таймаут;
 * - `unauthorized` — подпись не принята, например данные запуска устарели;
 * - `disabled` — плейтест на сервере выключен;
 * - `rejected` — сервер отверг сами данные: повтор не поможет;
 * - `unavailable` — сервер или хранилище недоступны, либо ответ не разобрался.
 */
export const PLAYTEST_FAILURES = [
  "no_identity",
  "offline",
  "unauthorized",
  "disabled",
  "rejected",
  "unavailable",
] as const;

export type PlaytestFailure = (typeof PLAYTEST_FAILURES)[number];

export type PlaytestResult<T> = { ok: true; data: T } | { ok: false; failure: PlaytestFailure };

export interface PlaytestApi {
  submitRun(submission: PlaytestRunSubmission): Promise<PlaytestResult<PlaytestSubmitResult>>;
  leaderboard(difficultyId: DifficultyId): Promise<PlaytestResult<PlaytestLeaderboard>>;
  profile(): Promise<PlaytestResult<PlaytestProfile>>;
}

/**
 * Сколько ждать ответа. Итог забега не должен висеть дольше, чем игрок
 * смотрит на экран смерти: не дождались — забег ляжет в очередь.
 */
export const PLAYTEST_TIMEOUT_MS = 8_000;

const API_PREFIX = "/api/v1/playtest";

const difficultySchema = z.enum(DIFFICULTY_IDS);

const submitSchema = z.object({
  bestSurvivalSec: z.number(),
  isNewBest: z.boolean(),
  rank: z.nullable(z.number()),
});

const leaderboardSchema = z.object({
  difficultyId: difficultySchema,
  entries: z.array(
    z.object({
      rank: z.number(),
      name: z.string(),
      photoUrl: z.nullable(z.string()),
      survivalSec: z.number(),
      level: z.number(),
      startingWeaponId: z.string(),
      enemiesKilled: z.number(),
      isMe: z.boolean(),
    }),
  ),
  me: z.nullable(z.object({ rank: z.number(), survivalSec: z.number() })),
  totalPlayers: z.number(),
});

const bestSchema = z.nullable(z.object({ survivalSec: z.number(), rank: z.number() }));

const profileSchema = z.object({
  runs: z.number(),
  totalKills: z.number(),
  totalSurvivalSec: z.number(),
  best: z.object({ easy: bestSchema, normal: bestSchema, hard: bestSchema }),
  recent: z.array(
    z.object({
      difficultyId: difficultySchema,
      survivalSec: z.number(),
      level: z.number(),
      startingWeaponId: z.string(),
      at: z.number(),
    }),
  ),
});

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export function createPlaytestApi(
  config: PlaytestApiConfig,
  signedLaunchData: () => string | null,
  fetchImpl: Fetch = (input, init) => globalThis.fetch(input, init),
): PlaytestApi {
  const base = `${config.baseUrl.replace(/\/+$/, "")}${API_PREFIX}`;

  async function request<T>(
    path: string,
    schema: z.ZodMiniType<T>,
    init: { method: "GET" | "POST"; body?: unknown },
  ): Promise<PlaytestResult<T>> {
    const identity = identityHeader(config, signedLaunchData());
    if (identity === null) return { ok: false, failure: "no_identity" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PLAYTEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: init.method,
        headers: {
          ...identity,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      });
    } catch {
      // Обрыв сети и таймаут игроку одинаковы: забег подождёт в очереди.
      return { ok: false, failure: "offline" };
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) return { ok: false, failure: failureOf(response.status) };

    try {
      const parsed = z.object({ data: schema }).safeParse(await response.json());
      return parsed.success ? { ok: true, data: parsed.data.data } : { ok: false, failure: "unavailable" };
    } catch {
      // Тело не JSON — например, страница ошибки прокси вместо ответа API.
      return { ok: false, failure: "unavailable" };
    }
  }

  return {
    submitRun: (submission) => request("/runs", submitSchema, { method: "POST", body: submission }),
    leaderboard: (difficultyId) =>
      request(`/leaderboard?difficulty=${encodeURIComponent(difficultyId)}`, leaderboardSchema, {
        method: "GET",
      }),
    profile: () => request("/me", profileSchema, { method: "GET" }),
  };
}

function identityHeader(config: PlaytestApiConfig, launchData: string | null): Record<string, string> | null {
  if (launchData !== null && launchData !== "") return { authorization: `tma ${launchData}` };
  // Заголовок разработчика сервер принимает только в development: в любом
  // другом окружении такой запрос получит 401. Кодировка — потому что
  // заголовок не умеет кириллицу, а имя обычно по-русски.
  if (config.devUser !== "") return { "x-playtest-dev-user": encodeURIComponent(config.devUser) };
  return null;
}

function failureOf(status: number): PlaytestFailure {
  if (status === 401) return "unauthorized";
  if (status === 404) return "disabled";
  if (status === 400 || status === 413 || status === 422) return "rejected";
  return "unavailable";
}
