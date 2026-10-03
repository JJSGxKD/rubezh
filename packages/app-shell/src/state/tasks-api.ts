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
  /** места в партнёрской цели с лимитом (Р82); сервер до лимита поля не отдавал */
  slots: z.optional(z.nullable(z.object({ left: z.number(), total: z.number(), holdUntil: z.nullable(z.string()) }))),
});
/**
 * Задание рекламной сети (docs/35-stage4-plan.md WP13, часть 6). У AdsGram
 * задание рисует SDK сети, наши — награда, пометка и кнопки: `offer` — что
 * передать SDK; `null` — сеть упёрлась в потолок суток или паузу, и строки
 * сейчас нет. У ленты сети (`delivery: "feed"`, обмен Taddy) строка наша
 * целиком и спрашивает своё задание сама, пока `nextAt` пуст.
 */
const networkTaskSchema = z.object({
  network: z.string(),
  /** сервер до ленты Taddy поля не отдавал — все задания были элементом сети */
  delivery: z.optional(z.string()),
  title: z.string(),
  reward: rewardSchema,
  doneToday: z.number(),
  dailyCap: z.number(),
  offer: z.nullable(
    z.object({
      sessionId: z.string(),
      network: z.string(),
      blockId: z.nullable(z.string()),
      keys: z.record(z.string(), z.string()),
      debug: z.boolean(),
      expiresAt: z.string(),
    }),
  ),
  nextAt: z.nullable(z.string()),
});
/** сервер до заданий сетей поля не отдавал */
const viewSchema = z.object({ tasks: z.array(taskSchema), networks: z.optional(z.array(networkTaskSchema)) });
const claimSchema = z.object({ claimed: z.boolean(), credited: rewardSchema, tasks: z.array(taskSchema) });
const openSchema = z.object({ url: z.string(), tasks: z.array(taskSchema) });
const stepSchema = z.object({ ok: z.literal(true) });

/**
 * Задание ленты сети — то, что рисует наша строка. `action` — строкой: сеть
 * может завести вид, которого клиент не знает, и кнопка скажет «Перейти».
 */
const feedTaskSchema = z.object({
  sessionId: z.string(),
  network: z.string(),
  title: z.string(),
  description: z.nullable(z.string()),
  image: z.nullable(z.string()),
  action: z.string(),
  link: z.string(),
  opened: z.boolean(),
});
const progressFields = { doneToday: z.number(), nextAt: z.nullable(z.string()) };
const feedItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), task: feedTaskSchema }),
  z.object({ kind: z.literal("done"), ...progressFields }),
  z.object({ kind: z.literal("none") }),
]);
/** Исход проверки — строкой: незнакомый клиент читает как «сеть не ответила». */
const feedCheckSchema = z.object({ result: z.string(), ...progressFields });

/** Язык — как его ждёт сервер (`ru`, `pt-br`), как у выдачи рекламы; что-то иное — не передаём. */
const LANGUAGE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})?$/;

/** Кто спрашивает ленту — для подбора заданий сетью; со слов клиента площадки, на награду не влияет. */
export interface FeedHints {
  language: string | null;
  premium: boolean | null;
}

function hintsBody(hints: FeedHints): Record<string, string | boolean> {
  return {
    ...(hints.language !== null && LANGUAGE.test(hints.language) ? { language: hints.language } : {}),
    ...(hints.premium === null ? {} : { premium: hints.premium }),
  };
}

export type TaskItem = z.infer<typeof taskSchema>;
export type NetworkTaskItem = z.infer<typeof networkTaskSchema>;
export type FeedTask = z.infer<typeof feedTaskSchema>;
export type FeedItem = z.infer<typeof feedItemSchema>;
export type FeedCheck = z.infer<typeof feedCheckSchema>;
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
/** Места в цели с лимитом закончились, а игрок к ней не переходил в последний час. */
export const TASK_LIMIT_REACHED = "task_limit_reached";

/** Текст отказа в заборе по коду сервера — ключом словаря. */
export function claimFailureKey(code: string | undefined): string {
  if (code === TASK_NOT_DONE) return "tasks.stale";
  if (code === TASK_NOT_JOINED) return "tasks.notJoined";
  if (code === TASK_CHECK_UNAVAILABLE) return "tasks.checkUnavailable";
  if (code === TASK_NOT_OPENED) return "tasks.notOpened";
  if (code === TASK_LIMIT_REACHED) return "tasks.limitReached";
  return "tasks.claimFailed";
}

/**
 * Что сказать о местах в цели с лимитом: «Осталось 37 из 500» — пока места
 * есть; кончились, а место игрока держится — до какого времени. Без лимита
 * и у выполнившего — ничего: место у него уже есть.
 */
export function slotsText(slots: TaskItem["slots"], nowMs: number): { key: string; params: Record<string, number> } | null {
  if (slots === null || slots === undefined) return null;
  if (slots.left > 0) return { key: "tasks.slotsLeft", params: { left: slots.left, total: slots.total } };
  const until = slots.holdUntil === null ? Number.NaN : Date.parse(slots.holdUntil);
  if (Number.isNaN(until) || until <= nowMs) return null;
  return { key: "tasks.slotsHeld", params: { minutes: Math.max(1, Math.ceil((until - nowMs) / 60_000)) } };
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

/** Ссылка цели открывается как любая внешняя — адаптером площадки. */
export { openExternalLink as openTaskLink } from "./external-link";

export interface TasksApi {
  view(): Promise<ApiResult<{ tasks: TaskItem[]; networks?: NetworkTaskItem[] | undefined }>>;
  claim(taskId: string): Promise<ApiResult<TaskClaim>>;
  /** переход по ссылке партнёрской цели: ссылку и бота он и выполняет */
  open(taskId: string): Promise<ApiResult<{ url: string; tasks: TaskItem[] }>>;
  /**
   * Шаг задания сети для воронки места «Задания» — та же ручка, что у
   * показов рекламы: задание нарисовано (`shown`) или игрок нажал «Перейти»
   * (`clicked`). Выполнение отсюда не сообщается — его подтверждает сеть.
   */
  networkStep(sessionId: string, outcome: "shown" | "clicked"): Promise<ApiResult<unknown>>;
  /** Задание ленты сети для её строки: сервер спрашивает сеть, экран заданий её не ждёт. */
  networkItem(network: string, hints: FeedHints): Promise<ApiResult<FeedItem>>;
  /** «Проверить» у задания ленты: выполнение подтверждает сеть, награду выдаёт сервер. */
  networkCheck(network: string, sessionId: string, hints: FeedHints): Promise<ApiResult<FeedCheck>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createTasksApi(request: ApiRequest = apiRequest): TasksApi {
  return {
    view: () => request("/api/v1/tasks", viewSchema, { method: "GET" }),
    claim: (taskId) => request(`/api/v1/tasks/${encodeURIComponent(taskId)}/claim`, claimSchema, { method: "POST" }),
    open: (taskId) => request(`/api/v1/tasks/${encodeURIComponent(taskId)}/open`, openSchema, { method: "POST" }),
    networkStep: (sessionId, outcome) => request(`/api/v1/ads/sessions/${encodeURIComponent(sessionId)}/result`, stepSchema, { method: "POST", body: { outcome } }),
    networkItem: (network, hints) => request(`/api/v1/tasks/networks/${encodeURIComponent(network)}/item`, feedItemSchema, { method: "POST", body: hintsBody(hints) }),
    networkCheck: (network, sessionId, hints) =>
      request(`/api/v1/tasks/networks/${encodeURIComponent(network)}/check`, feedCheckSchema, { method: "POST", body: { sessionId, ...hintsBody(hints) } }),
  };
}

/** Задания — только с входом: прогресс считает сервер по аккаунту. */
export function tasksAvailable(): boolean {
  return useShell.getState().capabilities.auth !== undefined;
}

/**
 * Подтвердила ли сеть задание: за игровые сутки выполненных стало больше,
 * чем было до события `reward`. Сеть подтверждает сама, и ответ приходит
 * не сразу — экран спрашивает несколько раз.
 */
export function networkTaskConfirmed(before: Pick<NetworkTaskItem, "doneToday">, now: Pick<NetworkTaskItem, "doneToday"> | undefined): boolean {
  return now !== undefined && now.doneToday > before.doneToday;
}

/** Когда спрашивать сервер после события сети, мс от него: подтверждение AdsGram идёт секунды, реже — десятки секунд. */
export const NETWORK_TASK_CHECKS_MS = [1_500, 4_000, 8_000, 15_000, 30_000] as const;

/** Строка сети — лента: сервер так сказал. Старый сервер поля не отдавал, и всё было элементом сети. */
export function isFeedTask(item: Pick<NetworkTaskItem, "delivery">): boolean {
  return item.delivery === "feed";
}

/** Надпись кнопки задания ленты по виду: бот — «Запустить бота», приложение — «Открыть», остальное — «Перейти». */
export function feedActionKey(action: string): string {
  if (action === "bot") return "tasks.startBot";
  if (action === "app") return "tasks.network.openApp";
  return "tasks.go";
}

/**
 * Что сказать после «Проверить»: `confirmed` — награда выдана, строка
 * уходит в «готово»; `closed` — задания больше нет, строка спросит новое;
 * остальное — подсказка под кнопкой. Незнакомый исход — как «не ответила»:
 * нажать ещё раз безопасно.
 */
export function feedCheckNotice(result: string): string | null {
  if (result === "confirmed" || result === "closed") return null;
  return result === "not_done" ? "tasks.network.notDone" : "tasks.network.unavailable";
}
