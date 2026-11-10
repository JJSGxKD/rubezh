import { z } from "zod";
import { AXIS_IDS, type AxisId, type AxisValues } from "./score-rules.js";

/**
 * Очки в строке забега и в ответе записи (tasks/T-0293). Отдельный файл без
 * Nest и настроек: его читает и репозиторий забегов, и сервис очков, и
 * пересчёт, а им не нужно тащить друг друга.
 *
 * Колонки `axes` и `score_input` — JSON из базы, поэтому читаются схемой, а не
 * приведением типа: строка, правленная руками, не должна ронять ответ.
 */

const axisIndex = z.number().finite().nonnegative();

export const storedAxesSchema = z.object({ t: axisIndex, k: axisIndex, h: axisIndex, c: axisIndex, b: axisIndex });

/** Что кладётся в строку забега. */
export interface StoredScore {
  points: number;
  /** сырые индексы с тремя знаками */
  axes: AxisValues;
  style: AxisId;
  band: string;
}

/** То, что уходит в ответ записи. */
export interface RunScoreView extends StoredScore {
  expectedPoints: number;
}

/**
 * Исходные числа подсчёта, которых нет в других колонках строки: сила на
 * старте и два поля из итога. Полученный урон, убийства и время — в колонках
 * и `details`. Нужны, чтобы `runs:rescore` пересчитывал по сохранённому, а не
 * по телу запроса, которого уже нет.
 */
export const storedScoreInputSchema = z.object({
  power: z.number().finite().nonnegative().nullable(),
  huntLog: z
    .array(z.object({ rank: z.enum(["elite", "boss"]), value: z.number().min(0), aliveSec: z.number().min(0) }))
    .nullable(),
  buildScore: z.number().finite().nonnegative().nullable(),
});

export type StoredScoreInput = z.infer<typeof storedScoreInputSchema>;

const styleSchema = z.enum(AXIS_IDS);

/** Очки из колонок строки; неполные или битые — `null`, как забег без очков. */
export function storedScoreOf(columns: { points: number | null; axes: unknown; style: string | null; band: string | null }): StoredScore | null {
  if (columns.points === null || columns.band === null) return null;
  const axes = storedAxesSchema.safeParse(columns.axes);
  const style = styleSchema.safeParse(columns.style);
  if (!axes.success || !style.success) return null;
  return { points: columns.points, axes: axes.data, style: style.data, band: columns.band };
}
