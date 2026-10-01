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
  /** вкладка: партнёрские цели — своей; сервер до партнёрских поля не отдавал */
  category: z.optional(z.string()),
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
const openSchema = z.object({ url: z.string(), tasks: z.array(taskSchema) });

export type TaskItem = z.infer<typeof taskSchema>;
export type TaskReward = z.infer<typeof rewardSchema>;
export type TaskClaim = z.infer<typeof claimSchema>;

/** Вкладка задания: партнёрские — своей, остальные — по сроку. */
export type TaskTab = "daily" | "weekly" | "achievement" | "partner";

export function tabOf(task: Pick<TaskItem, "category" | "period">): TaskTab {
  return task.category === "partner" ? "partner" : task.period;
}

/** Цели, которые засчитывает сам переход по ссылке: ссылка и бот. Подписку проверяет «Проверить». */
const OPEN_KINDS: ReadonlySet<string> = new Set(["link", "bot"]);

export function isOpenKind(kind: string): boolean {
  return OPEN_KINDS.has(kind);
}

/** Можно забрать награду — то, что показывает знак на вкладке. */
export function isClaimable(task: Pick<TaskItem, "done" | "claimed">): boolean {
  return task.done && !task.claimed;
}

/** Порядок видов цели внутри группы: похожие стоят рядом, а не вперемешку. */
const KIND_ORDER = ["runs", "kills", "survive_sec", "best_survival_sec", "run_level", "channel", "bot", "link"];

/**
 * Порядок на экране: сверху — что можно забрать, дальше — в работе, внизу —
 * уже полученное. Внутри — по виду цели, чтобы похожие стояли рядом, и по
 * величине цели; незнакомый вид — после знакомых, порядок сервера сохраняется.
 */
export function sortTasks<T extends Pick<TaskItem, "done" | "claimed" | "kind" | "target">>(tasks: readonly T[]): T[] {
  const stage = (task: T) => (isClaimable(task) ? 0 : task.claimed ? 2 : 1);
  const kind = (task: T) => {
    const index = KIND_ORDER.indexOf(task.kind);
    return index < 0 ? KIND_ORDER.length : index;
  };
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => stage(a.task) - stage(b.task) || kind(a.task) - kind(b.task) || a.task.target - b.task.target || a.index - b.index)
    .map((entry) => entry.task);
}

/** Цель не выполнена — экран устарел: перечитать задания. */
export const TASK_NOT_DONE = "task_not_done";
/** Площадка не видит игрока в канале. */
export const TASK_NOT_JOINED = "task_not_joined";
/** Цель засчитывает переход, а игрок ещё не переходил. */
export const TASK_NOT_OPENED = "task_not_opened";
/** Площадка не ответила или задание настроено так, что проверить нечем. */
export const TASK_CHECK_UNAVAILABLE = "task_check_unavailable";

/** Текст отказа в заборе по коду сервера — ключом словаря. */
export function claimFailureKey(code: string | undefined): string {
  if (code === TASK_NOT_DONE) return "tasks.stale";
  if (code === TASK_NOT_JOINED) return "tasks.notJoined";
  if (code === TASK_CHECK_UNAVAILABLE) return "tasks.checkUnavailable";
  if (code === TASK_NOT_OPENED) return "tasks.notOpened";
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
  /** переход по ссылке партнёрской цели: ссылку и бота он и выполняет */
  open(taskId: string): Promise<ApiResult<{ url: string; tasks: TaskItem[] }>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createTasksApi(request: ApiRequest = apiRequest): TasksApi {
  return {
    view: () => request("/api/v1/tasks", viewSchema, { method: "GET" }),
    claim: (taskId) => request(`/api/v1/tasks/${encodeURIComponent(taskId)}/claim`, claimSchema, { method: "POST" }),
    open: (taskId) => request(`/api/v1/tasks/${encodeURIComponent(taskId)}/open`, openSchema, { method: "POST" }),
  };
}

/** Задания — только с входом: прогресс считает сервер по аккаунту. */
export function tasksAvailable(): boolean {
  return useShell.getState().capabilities.auth !== undefined;
}
