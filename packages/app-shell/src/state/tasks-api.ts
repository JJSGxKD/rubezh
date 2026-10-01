import type { PlatformAdapter } from "@bh/shared-types";
import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { useShell } from "./shell";

/**
 * Задания и достижения с сервера (docs/35-stage4-plan.md Р52, WP13): прогресс
 * считает сервер по записанным забегам, награду выдаёт он же — клиент только
 * показывает и просит забрать.
 *
 * Модуль грузится вместе с экраном заданий — первой загрузке он не нужен.
 *
 * Вид цели — строкой, а не перечислением: сервер новее клиента может завести
 * вид, которого клиент ещё не знает, и задание нарисуется с заголовком из
 * каталога, а не уронит экран.
 *
 * Цель со ссылкой — подписка на канал (Р52): её выполняет не забег, а
 * подписка, и проверяет сервер ботом площадки по нажатию «Проверить».
 */

const rewardSchema = z.object({ coins: z.number(), gems: z.number(), shards: z.number() });
const taskSchema = z.object({
  id: z.string(),
  period: z.enum(["daily", "weekly", "achievement"]),
  kind: z.string(),
  title: z.nullable(z.string()),
  target: z.number(),
  value: z.number(),
  done: z.boolean(),
  claimed: z.boolean(),
  reward: rewardSchema,
  passPoints: z.number(),
  /** куда вести игрока — у цели «канал»; сервер до канала поля не отдавал */
  link: z.optional(z.nullable(z.string())),
});
const viewSchema = z.object({ tasks: z.array(taskSchema) });
const claimSchema = z.object({ claimed: z.boolean(), credited: rewardSchema, tasks: z.array(taskSchema) });

export type TaskItem = z.infer<typeof taskSchema>;
export type TaskReward = z.infer<typeof rewardSchema>;
export type TaskClaim = z.infer<typeof claimSchema>;

/** Цель не выполнена — экран устарел: перечитать задания. */
export const TASK_NOT_DONE = "task_not_done";
/** Площадка не видит игрока в канале. */
export const TASK_NOT_JOINED = "task_not_joined";
/** Площадка не ответила или задание настроено так, что проверить нечем. */
export const TASK_CHECK_UNAVAILABLE = "task_check_unavailable";

/** Текст отказа в заборе по коду сервера — ключом словаря. */
export function claimFailureKey(code: string | undefined): string {
  if (code === TASK_NOT_DONE) return "tasks.stale";
  if (code === TASK_NOT_JOINED) return "tasks.notJoined";
  if (code === TASK_CHECK_UNAVAILABLE) return "tasks.checkUnavailable";
  return "tasks.claimFailed";
}

/**
 * Ссылка цели, которую можно открыть: только `https`. Сервер её уже
 * проверил, но клиент не открывает `javascript:` и `data:` ни от кого.
 */
export function taskLink(task: Pick<TaskItem, "link">): string | null {
  const link = task.link ?? null;
  if (link === null || !URL.canParse(link)) return null;
  return new URL(link).protocol === "https:" ? link : null;
}

/** Открыть ссылку адаптером площадки, а без него — окном браузера. */
export function openTaskLink(
  url: string,
  adapter: Pick<PlatformAdapter, "openLink"> = useShell.getState().adapter,
  browser: (url: string) => void = (link) => void globalThis.open(link, "_blank", "noopener"),
): void {
  if (adapter.openLink === undefined) browser(url);
  else adapter.openLink(url);
}

export interface TasksApi {
  view(): Promise<ApiResult<{ tasks: TaskItem[] }>>;
  claim(taskId: string): Promise<ApiResult<TaskClaim>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createTasksApi(request: ApiRequest = apiRequest): TasksApi {
  return {
    view: () => request("/api/v1/tasks", viewSchema, { method: "GET" }),
    claim: (taskId) => request(`/api/v1/tasks/${encodeURIComponent(taskId)}/claim`, claimSchema, { method: "POST" }),
  };
}

/** Задания — только с входом: прогресс считает сервер по аккаунту. */
export function tasksAvailable(): boolean {
  return useShell.getState().capabilities.auth !== undefined;
}
