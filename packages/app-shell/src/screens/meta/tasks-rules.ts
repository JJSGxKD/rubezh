import { isClaimable, tabOf, type TaskItem, type TaskTab } from "../../state/tasks-api";

export type TasksView = "daily" | "weekly" | "achievements" | "partner";

/** Порядок вкладок на экране: первой выбирается та, где ждёт награда. */
export const TASKS_VIEW_ORDER: readonly TasksView[] = ["partner", "daily", "weekly", "achievements"];

export const TASK_TAB_OF: Record<TasksView, TaskTab> = {
  daily: "daily",
  weekly: "weekly",
  achievements: "achievement",
  partner: "partner",
};

type RewardTask = Pick<TaskItem, "category" | "period" | "done" | "claimed">;

/**
 * Вкладка при открытии: первая по порядку, где есть выполненное и не
 * забранное задание; иначе по умолчанию — «Партнёры», если они есть, а
 * иначе «День».
 */
export function initialTasksView(input: { tasks: readonly RewardTask[]; hasPartner: boolean }): TasksView {
  for (const view of TASKS_VIEW_ORDER) {
    if (input.tasks.some((task) => tabOf(task) === TASK_TAB_OF[view] && isClaimable(task))) return view;
  }
  return input.hasPartner ? "partner" : "daily";
}

/**
 * Вкладка после ответа сервера. Выбор игрока важнее правила: экран не
 * перескакивает, пока игрок ждёт награду или обновляется список.
 */
export function viewAfterLoad(input: { chosen: TasksView | null; tasks: readonly RewardTask[]; hasPartner: boolean }): TasksView {
  return input.chosen ?? initialTasksView(input);
}
