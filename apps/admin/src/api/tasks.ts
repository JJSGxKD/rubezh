import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Каталог заданий и достижений (`/admin/tasks`, docs/35-stage4-plan.md Р52,
 * WP13): цели, награды, текст и включённость без релиза — под `tasks.edit`.
 * Удаления нет: задание выключают, на него ссылается прогресс игроков. Срок
 * и вид после создания не меняются.
 *
 * Цель «канал» выполняет подписка, а не забег: у неё площадка, канал и
 * ссылка, и она — только достижение с целью 1 (подписку не копят).
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
  channel: "Подписка на канал",
};

/** Вид, который выполняет подписка: у него канал вместо числа. */
export const CHANNEL_KIND = "channel";

/** Площадки, где есть каналы, — те же, что принимает сервер. */
export const CHANNEL_PLATFORMS = ["telegram", "max", "vk"] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];
export const CHANNEL_PLATFORM_TITLES: Record<ChannelPlatform, string> = { telegram: "Telegram", max: "MAX", vk: "VK" };

const CHAT_MIN = 2;
const CHAT_MAX = 64;
const URL_MAX = 256;

/** Цели во времени — в секундах: форма подсказывает минуты. */
export const TIME_KINDS: ReadonlySet<string> = new Set(["survive_sec", "best_survival_sec"]);

/** Тот же формат id, что проверяет сервер (`tasks/task-rules.ts`). */
export const TASK_ID_PATTERN = /^[a-z][a-z0-9_]{1,47}$/;
export const TITLE_MAX = 120;

const channelSchema = z.object({ platform: z.enum(CHANNEL_PLATFORMS), chat: z.string(), url: z.string() });
export type ChannelParams = z.infer<typeof channelSchema>;

const taskSchema = z.object({
  taskId: z.string(),
  period: z.enum(TASK_PERIODS),
  kind: z.string(),
  /** сервер до цели «канал» поля не отдавал */
  params: channelSchema.nullable().default(null),
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
  const params = task.params === null ? null : { ...task.params, chat: task.params.chat.trim(), url: task.params.url.trim() };
  return api.request("/tasks", { method: "POST", body: { ...task, taskId: task.taskId.trim(), title: title === "" ? null : title, params }, schema: taskSchema });
}

/**
 * Смена вида в форме: у канала — пустые параметры, срок «достижение» и цель
 * 1; у вида забега параметров нет. Остальное поле формы сохраняет.
 */
export function withKind(task: TaskDef, kind: string): TaskDef {
  if (kind === CHANNEL_KIND) return { ...task, kind, period: "achievement", target: 1, params: task.params ?? { platform: "telegram", chat: "", url: "" } };
  return { ...task, kind, params: null };
}

function isHttpsUrl(value: string): boolean {
  return URL.canParse(value) && new URL(value).protocol === "https:";
}

function channelProblem(task: TaskDef): string | null {
  if (task.params === null) return "У подписки на канал нужны площадка, канал и ссылка";
  if (task.period !== "achievement" || task.target !== 1) return "Подписка — только достижение с целью 1: её не копят, а каждый день за неё не платят";
  const chat = task.params.chat.trim();
  if (chat.length < CHAT_MIN || chat.length > CHAT_MAX) return `Канал — @имя или id, от ${String(CHAT_MIN)} до ${String(CHAT_MAX)} знаков`;
  const url = task.params.url.trim();
  if (url.length > URL_MAX || !isHttpsUrl(url)) return `Ссылка — https://…, до ${String(URL_MAX)} знаков`;
  return null;
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
  if (task.kind === CHANNEL_KIND) return channelProblem(task);
  if (task.params !== null) return "Канал и ссылка — только у подписки на канал";
  return null;
}

export function rewardLabel(task: Pick<TaskDef, "coins" | "gems" | "shards">): string {
  const parts = [task.coins > 0 ? `${String(task.coins)} мон.` : null, task.gems > 0 ? `${String(task.gems)} самоцв.` : null, task.shards > 0 ? `${String(task.shards)} оск.` : null];
  return parts.filter((part): part is string => part !== null).join(" + ");
}

/** Цель подписью: время — минутами, канал — именем, остальное — числом. */
export function targetLabel(task: Pick<TaskDef, "kind" | "target"> & Partial<Pick<TaskDef, "params">>): string {
  const params = task.params ?? null;
  if (task.kind === CHANNEL_KIND && params !== null) return `${params.chat} (${CHANNEL_PLATFORM_TITLES[params.platform]})`;
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
