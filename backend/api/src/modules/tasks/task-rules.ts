import { z } from "zod";
import { runReward } from "../progress/progress-rules.js";
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
 * Виды целей. У каждого — как забег двигает прогресс: `sum` копит за срок,
 * `max` помнит лучший забег. Новый вид — код здесь (и строка текста у
 * клиента), новое задание на готовом виде — строка каталога в панели.
 */
export const TASK_KINDS = {
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

export type TaskKind = keyof typeof TASK_KINDS;
export const TASK_KIND_IDS = Object.keys(TASK_KINDS) as TaskKind[];

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
  .refine((task) => task.coins + task.gems + task.shards > 0, { message: "задание без награды" });

export type TaskDef = z.infer<typeof taskDefSchema>;
