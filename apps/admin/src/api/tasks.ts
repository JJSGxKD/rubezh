import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Каталог заданий и достижений (`/admin/tasks`, docs/35-stage4-plan.md Р52,
 * WP13): цели, награды, текст и включённость без релиза — под `tasks.edit`.
 * Удаления нет: задание выключают, на него ссылается прогресс игроков. Срок
 * и вид после создания не меняются.
 */

export const TASK_PERIODS = ["daily", "weekly", "achievement"] as const;
export type TaskPeriod = (typeof TASK_PERIODS)[number];

export const PERIOD_TITLES: Record<TaskPeriod, string> = { daily: "Ежедневные", weekly: "Недельные", achievement: "Достижения" };

/** Подписи видов, которые панель знает; незнакомый вид от сервера новее панели показывается как есть. */
export const KIND_TITLES: Partial<Record<string, string>> = {
  runs: "Забеги",
  kills: "Враги",
  survive_sec: "Время в сумме, с",
  best_survival_sec: "Рекорд времени, с",
  run_level: "Уровень в забеге",
};

/** Цели во времени — в секундах: форма подсказывает минуты. */
export const TIME_KINDS: ReadonlySet<string> = new Set(["survive_sec", "best_survival_sec"]);

/** Тот же формат id, что проверяет сервер (`tasks/task-rules.ts`). */
export const TASK_ID_PATTERN = /^[a-z][a-z0-9_]{1,47}$/;
export const TITLE_MAX = 120;

const taskSchema = z.object({
  taskId: z.string(),
  period: z.enum(TASK_PERIODS),
  kind: z.string(),
  target: z.number(),
  title: z.string().nullable(),
  coins: z.number(),
  gems: z.number(),
  shards: z.number(),
  passPoints: z.number(),
  sort: z.number(),
  active: z.boolean(),
});

export type TaskDef = z.infer<typeof taskSchema>;

const catalogSchema = z.object({ tasks: z.array(taskSchema), kinds: z.array(z.string()), periods: z.array(z.enum(TASK_PERIODS)) });
export type TaskCatalog = z.infer<typeof catalogSchema>;

export function fetchTasks(api: AdminApi): Promise<ApiResult<TaskCatalog>> {
  return api.request("/tasks", { schema: catalogSchema });
}

export function saveTask(api: AdminApi, task: TaskDef): Promise<ApiResult<TaskDef>> {
  const title = task.title?.trim() ?? "";
  return api.request("/tasks", { method: "POST", body: { ...task, taskId: task.taskId.trim(), title: title === "" ? null : title }, schema: taskSchema });
}

function nonNegativeInt(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Что не так с формой; `null` — можно сохранять. Сервер проверит то же и ещё
 * одно: у существующего задания не меняются срок и вид.
 */
export function taskProblem(task: TaskDef, isNew: boolean, catalog: readonly TaskDef[] = []): string | null {
  const id = task.taskId.trim();
  if (!TASK_ID_PATTERN.test(id)) return "id — латиница в нижнем регистре, цифры и подчёркивание, с буквы, до 48 знаков";
  if (isNew && catalog.some((existing) => existing.taskId === id)) return "Такой id уже есть — выберите его в списке, чтобы поправить";
  if (!Number.isInteger(task.target) || task.target <= 0) return "Цель — целое число больше нуля";
  if (![task.coins, task.gems, task.shards, task.passPoints, task.sort].every(nonNegativeInt)) return "Награда, очки пасса и порядок — целые неотрицательные";
  if (task.coins + task.gems + task.shards === 0) return "Без награды задание некому выполнять — дайте монеты, самоцветы или осколки";
  if ((task.title?.trim().length ?? 0) > TITLE_MAX) return `Заголовок — до ${String(TITLE_MAX)} знаков`;
  return null;
}

export function rewardLabel(task: Pick<TaskDef, "coins" | "gems" | "shards">): string {
  const parts = [task.coins > 0 ? `${String(task.coins)} мон.` : null, task.gems > 0 ? `${String(task.gems)} самоцв.` : null, task.shards > 0 ? `${String(task.shards)} оск.` : null];
  return parts.filter((part): part is string => part !== null).join(" + ");
}

/** Цель подписью: время — минутами, остальное — числом. */
export function targetLabel(task: Pick<TaskDef, "kind" | "target">): string {
  if (!TIME_KINDS.has(task.kind)) return String(task.target);
  const minutes = task.target / 60;
  return Number.isInteger(minutes) ? `${String(minutes)} мин` : `${String(task.target)} с`;
}

/** Каталог по срокам в порядке показа игроку: место, потом id. */
export function groupByPeriod(tasks: readonly TaskDef[]): { period: TaskPeriod; tasks: TaskDef[] }[] {
  return TASK_PERIODS.map((period) => ({
    period,
    tasks: tasks.filter((task) => task.period === period).sort((a, b) => a.sort - b.sort || a.taskId.localeCompare(b.taskId)),
  }));
}
