import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { useShell } from "./shell";

/**
 * Кодекс врагов с сервера (docs/39-retention-mechanics.md К2, tasks/T-0127):
 * какие записи открыты, сколько это в процентах и что за полный кодекс. Запись
 * открывает встреча с врагом в забеге, считает и хранит сервер; награда —
 * достижение каталога заданий, забирается прежним `POST /tasks/:id/claim`.
 *
 * Справочник не должен ломаться оттого, что кодекс не загрузился: гость, ошибка
 * сети и старый сервер без ручки дают гайдбук как раньше — все враги открыты.
 */

const rewardSchema = z.object({
  taskId: z.string(),
  value: z.number(),
  target: z.number(),
  done: z.boolean(),
  claimed: z.boolean(),
  coins: z.number(),
  prestige: z.number(),
});

const codexSchema = z.object({
  /** сколько врагов в кодексе — по таблице сервера */
  total: z.number(),
  opened: z.array(z.object({ enemy: z.string(), firstSeenAt: z.string() })),
  percent: z.number(),
  /** награда за полный кодекс; `null` — строка выключена в панели */
  reward: z.nullable(rewardSchema),
});

export type CodexView = z.infer<typeof codexSchema>;
export type CodexReward = z.infer<typeof rewardSchema>;

export interface CodexApi {
  load(): Promise<ApiResult<CodexView>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createCodexApi(request: ApiRequest = apiRequest): CodexApi {
  return { load: () => request("/api/v1/codex", codexSchema, { method: "GET" }) };
}

/** Кодекс — только с входом: записи хранятся по аккаунту. */
export function codexAvailable(): boolean {
  return useShell.getState().capabilities.auth !== undefined;
}

/**
 * Что знает гайдбук о кодексе:
 * - `loading` — ответа ещё нет, враги показываются как раньше;
 * - `ready` — ответ получен;
 * - `error` — сеть или сервер подвели;
 * - `unavailable` — гость, нет входа или сервер без кодекса.
 */
export type CodexState = { status: "loading" } | { status: "ready"; view: CodexView } | { status: "error" } | { status: "unavailable" };

/** Отказы, при которых кодекса нет вовсе, а не «не вышло»: повтор не поможет. */
const UNAVAILABLE_FAILURES: ReadonlySet<string> = new Set(["no_identity", "disabled", "unauthorized"]);

export async function loadCodexState(api: CodexApi, available: boolean): Promise<CodexState> {
  if (!available) return { status: "unavailable" };
  const response = await api.load();
  if (response.ok) return { status: "ready", view: response.data };
  return UNAVAILABLE_FAILURES.has(response.failure) ? { status: "unavailable" } : { status: "error" };
}

/**
 * Какие враги открыты. `null` — кодекса нет (грузится, ошибка, гость): все
 * враги показываются открытыми, гайдбук такой, каким был до кодекса.
 */
export function codexOpenedSet(state: CodexState): ReadonlySet<string> | null {
  return state.status === "ready" ? new Set(state.view.opened.map((entry) => entry.enemy)) : null;
}
