import { z } from "zod";
import { runReward } from "../progress/progress-rules.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import type { RecordedRun } from "../runs/runs-hooks.js";
import type { EarnReason } from "../wallet/wallet-types.js";

/**
 * Задания и достижения (docs/35-stage4-plan.md Р52, WP13): каталог — в базе,
 * правится из панели без релиза; здесь — то, что каталогу не поменять:
 * виды целей и как их засчитывает сервер, сроки и чем за них платят.
 *
 * Прогресс — только от серверных событий (записанный забег), а не от
 * клиентской аналитики: клиент может прислать что угодно.
 */

/**
 * Срок цели: ежедневные — до полуночи по Москве, недельные — до ночи на
 * понедельник, достижения — навсегда.
 */
export const TASK_PERIODS = ["daily", "weekly", "achievement"] as const;
export type TaskPeriod = (typeof TASK_PERIODS)[number];

/**
 * Виды целей, которые двигает забег: `sum` копит за срок, `max` помнит лучший
 * забег. Новый вид — код здесь (и строка текста у клиента), новое задание на
 * готовом виде — строка каталога в панели.
 */
export const RUN_KINDS = {
  /** сыграть забегов */
  runs: { op: "sum", measure: () => 1 },
  /** убить врагов */
  kills: { op: "sum", measure: (run: TaskRun) => run.enemiesKilled },
  /** продержаться в сумме, секунд */
  survive_sec: { op: "sum", measure: (run: TaskRun) => Math.floor(run.survivalSec) },
  /** продержаться в одном забеге, секунд */
  best_survival_sec: { op: "max", measure: (run: TaskRun) => Math.floor(run.survivalSec) },
  /** дорасти в одном забеге до уровня */
  run_level: { op: "max", measure: (run: TaskRun) => run.level },
} as const satisfies Record<string, { op: "sum" | "max"; measure: (run: TaskRun) => number }>;

export type RunKind = keyof typeof RUN_KINDS;

/**
 * Партнёрские цели (Р52): их выполняет не забег, а действие игрока вне игры,
 * и у игрока они — своей категорией. `channel` — подписаться на канал или
 * вступить в чат, проверяет бот площадки по нажатию «Проверить»; `link` —
 * перейти по ссылке, `bot` — запустить бота: засчитывается переход через
 * сервер — проверить, что игрок открыл чужого бота, без постбэка партнёра
 * нечем. Такая цель — одна на аккаунт: только достижение с целью 1.
 */
export const CHECKED_KINDS = ["channel", "link", "bot"] as const;
export type CheckedKind = (typeof CHECKED_KINDS)[number];

/** Цели, которые засчитывает сам переход: проверить их у площадки нечем. */
export const OPEN_KINDS: ReadonlySet<TaskKind> = new Set<TaskKind>(["link", "bot"]);

export type TaskKind = RunKind | CheckedKind;
export const TASK_KIND_IDS: readonly TaskKind[] = [...(Object.keys(RUN_KINDS) as RunKind[]), ...CHECKED_KINDS];

export function isRunKind(kind: TaskKind): kind is RunKind {
  return Object.hasOwn(RUN_KINDS, kind);
}

/** Категория цели у игрока: партнёрские — своей вкладкой, остальные — по сроку. */
export type TaskCategory = TaskPeriod | "partner";

/** Площадки, где есть каналы: у веб-версии их нет. */
export const CHANNEL_PLATFORMS = ["telegram", "max", "vk"] as const satisfies readonly PlatformId[];

/**
 * Что нужно партнёрской цели: ссылка, которую откроет игрок, площадка, где
 * цель есть, и у канала — сам канал в записи площадки (у Telegram — `@имя`
 * или id). Цель другой площадки игроку не показывается; ссылка и бот без
 * площадки видны всем. Что обязательно у какого вида — проверяет
 * `taskDefSchema`.
 */
export const taskParamsSchema = z
  .object({
    platform: z.enum(CHANNEL_PLATFORMS).optional(),
    chat: z.string().trim().min(2).max(64).optional(),
    url: z.url({ protocol: /^https$/ }).max(256),
  })
  .strict();

export type TaskParams = z.infer<typeof taskParamsSchema>;

export type TaskRun = Pick<RecordedRun, "difficulty" | "survivalSec" | "enemiesKilled" | "level" | "cheats" | "verdict">;

/**
 * Засчитывается тот же забег, что приносит награду: с читами, отклонённый
 * разбором и «нажал и вышел» не двигают и задания — иначе их фармили бы
 * короткими забегами.
 */
export function countsForTasks(run: TaskRun): boolean {
  return runReward(run).skipped === null;
}

/** Ежедневные и недельные платят как задания, достижения — своей причиной: у них свой потолок. */
export function rewardReason(period: TaskPeriod): Extract<EarnReason, "task_reward" | "achievement_reward"> {
  return period === "achievement" ? "achievement_reward" : "task_reward";
}

/** Строка каталога — как её правит панель и читает сервер. */
export const taskDefSchema = z
  .object({
    taskId: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/, "id — латиница, цифры и подчёркивание, до 48 знаков"),
    period: z.enum(TASK_PERIODS),
    kind: z.enum(TASK_KIND_IDS as [TaskKind, ...TaskKind[]]),
    /** партнёрская цель — куда вести и что проверять; у целей забега — пусто, и панель до партнёрских целей поля не слала */
    params: taskParamsSchema.nullable().default(null),
    target: z.number().int().positive().max(10_000_000),
    /** `null` — текст по виду цели у клиента, с правильным склонением числа */
    title: z.string().trim().min(1).max(120).nullable(),
    coins: z.number().int().nonnegative().max(100_000),
    gems: z.number().int().nonnegative().max(1_000),
    shards: z.number().int().nonnegative().max(1_000),
    /** очки батл-пасса (WP26) */
    passPoints: z.number().int().nonnegative().max(10_000),
    sort: z.number().int().min(0).max(10_000),
    active: z.boolean(),
  })
  .strict()
  .refine((task) => task.coins + task.gems + task.shards > 0, { message: "задание без награды" })
  .refine((task) => isCheckedKind(task.kind) === (task.params !== null), { message: "ссылка — у партнёрской цели, и только у неё", path: ["params"] })
  .refine((task) => task.kind !== "channel" || (task.params?.platform !== undefined && task.params.chat !== undefined), {
    message: "у подписки на канал нужны площадка и канал — по ним спрашивает бот",
    path: ["params"],
  })
  .refine((task) => task.kind === "channel" || task.params?.chat === undefined, { message: "канал — только у подписки на канал", path: ["params"] })
  // Партнёрское действие делается однажды и не копится: за срок его не
  // «наберёшь», а повторная награда за ту же подписку каждый день — фарм.
  .refine((task) => !isCheckedKind(task.kind) || (task.period === "achievement" && task.target === 1), {
    message: "партнёрская цель — только достижение с целью 1",
    path: ["period"],
  });

function isCheckedKind(kind: TaskKind): boolean {
  return (CHECKED_KINDS as readonly string[]).includes(kind);
}

export type TaskDef = z.infer<typeof taskDefSchema>;
