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
});
const viewSchema = z.object({ tasks: z.array(taskSchema) });
const claimSchema = z.object({ claimed: z.boolean(), credited: rewardSchema, tasks: z.array(taskSchema) });

export type TaskItem = z.infer<typeof taskSchema>;
export type TaskReward = z.infer<typeof rewardSchema>;
export type TaskClaim = z.infer<typeof claimSchema>;

/** Цель не выполнена — экран устарел: перечитать задания. */
export const TASK_NOT_DONE = "task_not_done";

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
