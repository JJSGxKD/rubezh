import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Отчёт забега и решения разбора (Р203, tasks/T-0419): `GET /runs/:id/report`,
 * `POST …/honest`, `…/annul`, `…/restore`. Форма — `RunReportView` сервера
 * (`backend/api/src/modules/runs/run-review.service.ts`).
 *
 * Сервер мог обновиться раньше панели, поэтому строки, у которых бывают
 * новые значения (`verdict`, `mode`, `review.outcome`, стиль), читаются как
 * строки: незнакомое значение показывается как есть, а не роняет страницу.
 */

const count = z.number();

const detailsSchema = z.object({
  passives: z.array(z.object({ id: z.string(), level: count })),
  damageTaken: count.nullable(),
  xpCollected: count.nullable(),
  waveReached: count.nullable(),
  topKills: z.array(z.object({ enemy: z.string(), count })),
  bossKills: count.nullable(),
  eliteKills: count.nullable(),
  chestsOpened: count.nullable(),
  rareChests: count.nullable(),
  crystals: count.nullable(),
});

const scoreSchema = z.object({
  points: count,
  axes: z.object({ t: count, k: count, h: count, c: count, b: count }),
  style: z.string(),
  band: z.string(),
  expectedPoints: count.nullable(),
});

const scoreInputSchema = z.object({
  power: count.nullable(),
  huntLog: z.array(z.object({ rank: z.string(), value: count, aliveSec: count })).nullable(),
  buildScore: count.nullable(),
});

export const runReportSchema = z.object({
  runId: z.string(),
  accountId: z.string(),
  displayName: z.string().nullable(),
  difficulty: z.string(),
  mode: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string(),
  outcome: z.string().nullable(),
  survivalSec: count.nullable(),
  level: count.nullable(),
  enemiesKilled: count.nullable(),
  deathCause: z.string().nullable(),
  weapons: z.array(z.object({ id: z.string(), level: count, damage: count.nullish() })),
  details: detailsSchema.nullable(),
  continues: z.array(count),
  cheats: z.boolean(),
  contentHash: z.string(),
  rubezh: z.object({ reached: z.boolean(), clearedSec: count.nullable() }),
  verdict: z.string().nullable(),
  verdictReasons: z.array(z.string()),
  rating: z.object({
    ranked: z.boolean(),
    ratingRestricted: z.enum(["notified", "silent"]).nullable(),
    /** «Честный» и «Вернуть забег» вернут забег в текущие доски */
    returnable: z.boolean(),
  }),
  score: scoreSchema.nullable(),
  scoreInput: scoreInputSchema.nullable(),
  review: z.object({
    outcome: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    reviewedBy: z.string().nullable(),
    reviewerName: z.string().nullable(),
  }),
  /** что разрешает состояние забега; права панель проверяет сама */
  actions: z.object({ honest: z.boolean(), annul: z.boolean(), restore: z.boolean() }),
});

export type RunReport = z.infer<typeof runReportSchema>;

/** Причина решения — от 1 до 500 знаков: как на сервере. */
export const DECISION_REASON = { min: 1, max: 500 } as const;

function pathOf(runId: string, tail: string): string {
  return `/runs/${encodeURIComponent(runId)}/${tail}`;
}

export function fetchRunReport(api: AdminApi, runId: string): Promise<ApiResult<RunReport>> {
  return api.request(pathOf(runId, "report"), { schema: runReportSchema });
}

/** «Честный»: причина необязательна, поэтому тела нет. */
export function markHonest(api: AdminApi, runId: string): Promise<ApiResult<RunReport>> {
  return api.request(pathOf(runId, "honest"), { method: "POST", body: {}, schema: runReportSchema });
}

export function annulRun(api: AdminApi, runId: string, comment: string): Promise<ApiResult<RunReport>> {
  return api.request(pathOf(runId, "annul"), { method: "POST", body: { comment }, schema: runReportSchema });
}

export function restoreRun(api: AdminApi, runId: string, comment: string): Promise<ApiResult<RunReport>> {
  return api.request(pathOf(runId, "restore"), { method: "POST", body: { comment }, schema: runReportSchema });
}
