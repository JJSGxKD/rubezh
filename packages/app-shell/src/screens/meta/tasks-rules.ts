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

/**
 * Сутки для строки о правиле отписки (Р115, T-0183) или `null`, если строки нет. Забранное
 * достижение награду уже получило: предупреждать поздно. Ежедневным и еженедельным строка
 * нужна всегда — у каждой награды своё окно.
 */
export function recheckHintDays(task: Pick<TaskItem, "period" | "claimed"> & { recheckDays?: number | null }): number | null {
  const days = task.recheckDays ?? 0;
  if (days <= 0) return null;
  if (task.period === "achievement" && task.claimed) return null;
  return days;
}

/** Что на вкладке стоит в группе «Можно забрать», а что ниже (T-0373, Р186). */
export interface TabLayout<T> {
  /** готовые задания в порядке `sortTasks` */
  claimable: T[];
  /** полоса очков в группе: на «Дне» и «Неделе», если готова хоть одна ступень */
  pointsInGroup: boolean;
  /** остальные задания вкладки в порядке `sortTasks` */
  rest: T[];
}

/**
 * Раскладка вкладки. Ступени живут в одной полосе, поэтому в группу встаёт
 * полоса целиком. Под ограничением партнёрских заданий кнопок нет, и группа
 * «Можно забрать» обещала бы то, чего нажать нельзя.
 */
export function tabLayout<T extends Pick<TaskItem, "done" | "claimed">>(input: {
  view: TasksView;
  tasks: readonly T[];
  pointsReady: number;
  partnerClosed: boolean;
}): TabLayout<T> {
  const hidden = input.view === "partner" && input.partnerClosed;
  const claimable = hidden ? [] : input.tasks.filter(isClaimable);
  const rest = hidden ? [...input.tasks] : input.tasks.filter((task) => !isClaimable(task));
  const pointsInGroup = (input.view === "daily" || input.view === "weekly") && input.pointsReady > 0;
  return { claimable, pointsInGroup, rest };
}

export function hasClaimableGroup(layout: TabLayout<unknown>): boolean {
  return layout.claimable.length > 0 || layout.pointsInGroup;
}
