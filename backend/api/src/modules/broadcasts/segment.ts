import { z } from "zod";
import { BROADCAST_RULES } from "./broadcast-rules.js";

/**
 * Аудитория рассылки (docs/35-stage4-plan.md §3.10, docs/29-admin-panel.md
 * §7.1): вехи воронки, источник и кампания первого касания, давность.
 * Всегда — только тем, кому можно писать, и без заблокированных: этого
 * фильтра в сегменте нет, его не выключить.
 *
 * Вехи — ключи, а не имена колонок: колонку по ключу берёт хранилище из
 * своего белого списка, строка из панели в SQL не попадает.
 */

export const MILESTONES = [
  "entered",
  "app_opened",
  "first_run_started",
  "first_run_finished",
  "runs_2",
  "runs_5",
  "returned_d1",
  "returned_d7",
  "first_purchase",
] as const;

export type Milestone = (typeof MILESTONES)[number];

/** Откуда пришёл — вид первого касания (`acquisition.first_start_kind`). */
export const START_KINDS = ["organic", "click", "invite", "telegram_affiliate", "friend", "unknown"] as const;

const DAYS = z.number().int().min(1).max(3650);

export const segmentSchema = z
  .object({
    startKinds: z.array(z.enum(START_KINDS)).max(START_KINDS.length).default([]),
    /** кампания ссылки первого касания — формат тот же, что у ссылок кампаний */
    campaign: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .optional(),
    reached: z.array(z.enum(MILESTONES)).max(MILESTONES.length).default([]),
    notReached: z.array(z.enum(MILESTONES)).max(MILESTONES.length).default([]),
    registeredWithinDays: DAYS.optional(),
    activeWithinDays: DAYS.optional(),
    inactiveForDays: DAYS.optional(),
    skipRecentDays: z.number().int().min(0).max(90).default(BROADCAST_RULES.skipRecentDays),
  })
  .strict()
  .refine((segment) => !segment.reached.some((milestone) => segment.notReached.includes(milestone)), "Веха не может быть и пройдена, и не пройдена")
  .refine(
    (segment) => segment.activeWithinDays === undefined || segment.inactiveForDays === undefined || segment.inactiveForDays < segment.activeWithinDays,
    "«Заходил за N дней» и «не заходил M дней» не пересекаются",
  );

export type Segment = z.output<typeof segmentSchema>;
export type SegmentInput = z.input<typeof segmentSchema>;
