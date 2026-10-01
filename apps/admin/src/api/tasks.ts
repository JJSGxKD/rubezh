import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Каталог заданий и достижений (`/admin/tasks`, docs/35-stage4-plan.md Р52,
 * WP13): цели, награды, текст и включённость без релиза — под `tasks.edit`.
 * Удаления нет: задание выключают, на него ссылается прогресс игроков. Срок
 * и вид после создания не меняются.
 *
 * Партнёрские цели — подписка на канал, переход по ссылке, запуск бота —
 * выполняет действие игрока вне игры, а не забег: у них ссылка, площадка и у
 * канала — сам канал, и они — только достижение с целью 1. У игрока и в
 * панели они — своей группой.
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
  link: "Переход по ссылке",
  bot: "Запуск бота",
};

/** Подписка — её проверяет бот площадки по каналу. */
export const CHANNEL_KIND = "channel";

/** Партнёрские виды: ссылка вместо числа, своя группа в каталоге. */
export const PARTNER_KINDS: ReadonlySet<string> = new Set([CHANNEL_KIND, "link", "bot"]);

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

/** У ссылки и бота площадка необязательна — без неё цель видна на любой; канал — только у подписки. */
const paramsSchema = z.object({ platform: z.enum(CHANNEL_PLATFORMS).optional(), chat: z.string().optional(), url: z.string() });
export type TaskParams = z.infer<typeof paramsSchema>;

const taskSchema = z.object({
  taskId: z.string(),
  period: z.enum(TASK_PERIODS),
  kind: z.string(),
  /** сервер до партнёрских целей поля не отдавал */
  params: paramsSchema.nullable().default(null),
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
  return api.request("/tasks", { method: "POST", body: { ...task, taskId: task.taskId.trim(), title: title === "" ? null : title, params: cleanParams(task) }, schema: taskSchema });
}

/** Параметры в том виде, что принимает сервер: обрезанные, без пустой площадки и без канала не у подписки. */
function cleanParams(task: Pick<TaskDef, "kind" | "params">): TaskParams | null {
  if (task.params === null) return null;
  const chat = task.params.chat?.trim();
  return {
    ...(task.params.platform === undefined ? {} : { platform: task.params.platform }),
    ...(task.kind === CHANNEL_KIND && chat !== undefined ? { chat } : {}),
    url: task.params.url.trim(),
  };
}

/**
 * Смена вида в форме: у партнёрской цели — ссылка, срок «достижение» и цель
 * 1, у подписки ещё площадка и канал; у вида забега параметров нет. Остальное
 * поле формы сохраняет.
 */
export function withKind(task: TaskDef, kind: string): TaskDef {
  if (!PARTNER_KINDS.has(kind)) return { ...task, kind, params: null };
  const url = task.params?.url ?? "";
  const params: TaskParams =
    kind === CHANNEL_KIND ? { platform: task.params?.platform ?? "telegram", chat: task.params?.chat ?? "", url } : { ...(task.params?.platform === undefined ? {} : { platform: task.params.platform }), url };
  return { ...task, kind, period: "achievement", target: 1, params };
}

/** Площадка партнёрской цели; `undefined` — цель видна на всех площадках. */
export function withPlatform(params: TaskParams | null, platform: ChannelPlatform | undefined): TaskParams {
  const url = params?.url ?? "";
  const chat = params?.chat === undefined ? {} : { chat: params.chat };
  return platform === undefined ? { ...chat, url } : { ...chat, platform, url };
}

function isHttpsUrl(value: string): boolean {
  return URL.canParse(value) && new URL(value).protocol === "https:";
}

function partnerProblem(task: TaskDef): string | null {
  if (task.params === null) return "У партнёрской цели нужна ссылка, у подписки на канал — ещё площадка и канал";
  if (task.period !== "achievement" || task.target !== 1) return "Партнёрская цель — только достижение с целью 1: её не копят, а каждый день за неё не платят";
  if (task.kind === CHANNEL_KIND) {
    if (task.params.platform === undefined) return "У подписки на канал нужна площадка — бот спрашивает свою";
    const chat = task.params.chat?.trim() ?? "";
    if (chat.length < CHAT_MIN || chat.length > CHAT_MAX) return `Канал — @имя или id, от ${String(CHAT_MIN)} до ${String(CHAT_MAX)} знаков`;
  }
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
  if (PARTNER_KINDS.has(task.kind)) return partnerProblem(task);
  if (task.params !== null) return "Ссылка — только у партнёрских целей";
  return null;
}

export function rewardLabel(task: Pick<TaskDef, "coins" | "gems" | "shards">): string {
  const parts = [task.coins > 0 ? `${String(task.coins)} мон.` : null, task.gems > 0 ? `${String(task.gems)} самоцв.` : null, task.shards > 0 ? `${String(task.shards)} оск.` : null];
  return parts.filter((part): part is string => part !== null).join(" + ");
}

/** Цель подписью: время — минутами, канал — именем, ссылка — адресом, остальное — числом. */
export function targetLabel(task: Pick<TaskDef, "kind" | "target"> & Partial<Pick<TaskDef, "params">>): string {
  const params = task.params ?? null;
  if (params !== null) {
    const where = params.platform === undefined ? "все площадки" : CHANNEL_PLATFORM_TITLES[params.platform];
    const what = task.kind === CHANNEL_KIND ? (params.chat ?? "") : URL.canParse(params.url) ? new URL(params.url).host : params.url;
    return `${what} (${where})`;
  }
  if (!TIME_KINDS.has(task.kind)) return String(task.target);
  const minutes = task.target / 60;
  return Number.isInteger(minutes) ? `${String(minutes)} мин` : `${String(task.target)} с`;
}

/** Группа каталога: срок, а партнёрские — своей, как у игрока. */
export type TaskGroup = TaskPeriod | "partner";
export const GROUP_TITLES: Record<TaskGroup, string> = { ...PERIOD_TITLES, partner: "Партнёрские" };

/** Каталог по группам в порядке показа игроку: место, потом id. */
export function groupByPeriod(tasks: readonly TaskDef[]): { group: TaskGroup; tasks: TaskDef[] }[] {
  const groupOf = (task: TaskDef): TaskGroup => (PARTNER_KINDS.has(task.kind) ? "partner" : task.period);
  return [...TASK_PERIODS, "partner" as const].map((group) => ({
    group,
    tasks: tasks.filter((task) => groupOf(task) === group).sort((a, b) => a.sort - b.sort || a.taskId.localeCompare(b.taskId)),
  }));
}
