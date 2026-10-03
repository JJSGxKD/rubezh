import { z } from "zod";
import { runReward } from "../progress/progress-rules.js";
import { PLATFORM_IDS, type PlatformId } from "../../platforms/ports/platform.js";
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
 * нечем. Цель у них всегда 1: действие делается, а не копится.
 *
 * Повтор (Р82, WP13, часть 7) — только у подписки: срок «каждый день» или
 * «каждую неделю» — своя строка прогресса за срок, и забор каждого срока
 * спрашивает бота, подписан ли игрок сейчас. Это награда за то, что игрок
 * остался, а не только за то, что пришёл. Переход по ссылке и запуск бота
 * не проверить — их повтор стал бы фермой, они только разовые.
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
 * Что нужно партнёрской цели: ссылка, которую откроет игрок, где цель видна,
 * и у канала — сам канал в записи площадки (у Telegram — `@имя` или id).
 *
 * Где видна: у канала — одна площадка (`platform`), бот спрашивает
 * подписчиков своей; у ссылки и бота — список площадок (`platforms`), без
 * списка — все. Ссылка партнёра бывает нужна в Telegram и MAX, но не в VK
 * (решение участника 1, 01.10.2026). `platform` у ссылки — запись прошлой
 * панели, читается как список из одной. Что обязательно у какого вида —
 * проверяет `taskDefSchema`.
 */
export const taskParamsSchema = z
  .object({
    platform: z.enum(CHANNEL_PLATFORMS).optional(),
    platforms: z
      .array(z.enum(PLATFORM_IDS))
      .min(1)
      .max(PLATFORM_IDS.length)
      .refine((list) => new Set(list).size === list.length, { message: "площадка повторяется" })
      .optional(),
    chat: z.string().trim().min(2).max(64).optional(),
    url: z.url({ protocol: /^https$/ }).max(256),
  })
  .strict()
  .refine((params) => params.platform === undefined || params.platforms === undefined, { message: "площадка — одна или списком, не обоими" });

export type TaskParams = z.infer<typeof taskParamsSchema>;

/** Видна ли цель игроку этой площадки: цель без площадок — всем. */
export function visibleOn(params: TaskParams | null, platform: PlatformId): boolean {
  if (params === null) return true;
  if (params.platforms !== undefined) return params.platforms.includes(platform);
  return params.platform === undefined || params.platform === platform;
}

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

/** Пределы лимита выполнений — те же у формы панели и в `CHECK` базы. */
export const TASK_LIMIT_RANGE = { min: 1, max: 1_000_000 } as const;

/**
 * Мягкий час (Р82): кто перешёл к заданию до исчерпания лимита, получает
 * награду ещё час — иначе игрок подписался бы зря. Час идёт от последнего
 * перехода, а переход после исчерпания час не продлевает.
 */
export const TASK_LIMIT_GRACE_MIN = 60;

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
    /** лимит выполнений партнёрской цели — сколько игроков получат награду; `null` — без лимита, и панель до лимита поля не слала */
    limit: z.number().int().min(TASK_LIMIT_RANGE.min).max(TASK_LIMIT_RANGE.max).nullable().default(null),
  })
  .strict()
  .refine((task) => task.coins + task.gems + task.shards > 0, { message: "задание без награды" })
  // Лимит — у того, что выполняют действием вне игры: место в нём занимает
  // игрок, а у цели забега мест нет.
  .refine((task) => task.limit === null || isCheckedKind(task.kind), { message: "лимит выполнений — только у партнёрской цели", path: ["limit"] })
  .refine((task) => isCheckedKind(task.kind) === (task.params !== null), { message: "ссылка — у партнёрской цели, и только у неё", path: ["params"] })
  .refine((task) => task.kind !== "channel" || (task.params?.platform !== undefined && task.params.chat !== undefined), {
    message: "у подписки на канал нужны площадка и канал — по ним спрашивает бот",
    path: ["params"],
  })
  .refine((task) => task.kind === "channel" || task.params?.chat === undefined, { message: "канал — только у подписки на канал", path: ["params"] })
  .refine((task) => task.kind !== "channel" || task.params?.platforms === undefined, {
    message: "у подписки на канал площадка одна — бот спрашивает подписчиков своей",
    path: ["params"],
  })
  // Партнёрское действие делается, а не копится: за срок его не «наберёшь».
  .refine((task) => !isCheckedKind(task.kind) || task.target === 1, { message: "у партнёрской цели цель — 1", path: ["target"] })
  // Повтор — только там, где каждый срок проверяет бот: повтор перехода по
  // ссылке платил бы каждый день за одно и то же нажатие.
  .refine((task) => !isCheckedKind(task.kind) || task.kind === "channel" || task.period === "achievement", {
    message: "повтор — только у подписки на канал: переход по ссылке и запуск бота разовые",
    path: ["period"],
  });

function isCheckedKind(kind: TaskKind): boolean {
  return (CHECKED_KINDS as readonly string[]).includes(kind);
}

export type TaskDef = z.infer<typeof taskDefSchema>;

/** Что игрок знает о своём месте в задании с лимитом; без лимита и для выполнивших — ничего. */
export interface TaskSlots {
  /** сколько мест осталось; 0 — исчерпано */
  left: number;
  total: number;
  /** исчерпано, но место игрока держится до этого времени — мягкий час */
  holdUntil: Date | null;
}

/** Участие игрока в партнёрской цели: последний переход и первое выполнение. */
export interface TaskParticipation {
  completions: number;
  openedAt: Date | null;
  completedAt: Date | null;
}

/**
 * Видна ли цель с лимитом игроку и что сказать ему о местах. Выполнивший
 * место уже занял — лимит его не касается. Исчерпано — цель видна только
 * тем, кто перешёл к ней в последний час; остальным её нет.
 */
export function slotsFor(limit: number | null, participation: TaskParticipation | null, at: Date): { visible: boolean; slots: TaskSlots | null } {
  if (limit === null || (participation !== null && participation.completedAt !== null)) return { visible: true, slots: null };
  const completions = participation?.completions ?? 0;
  const left = Math.max(0, limit - completions);
  if (left > 0) return { visible: true, slots: { left, total: limit, holdUntil: null } };
  const holdUntil = graceEnd(participation?.openedAt ?? null);
  return holdUntil !== null && holdUntil > at ? { visible: true, slots: { left: 0, total: limit, holdUntil } } : { visible: false, slots: null };
}

/** Конец мягкого часа от перехода; без перехода часа нет. */
export function graceEnd(openedAt: Date | null): Date | null {
  return openedAt === null ? null : new Date(openedAt.getTime() + TASK_LIMIT_GRACE_MIN * 60_000);
}
