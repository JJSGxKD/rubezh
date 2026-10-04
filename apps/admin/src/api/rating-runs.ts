import { z } from "zod";
import { formatDuration } from "../format";
import type { AdminApi, ApiResult } from "./client";

/**
 * Рекорды игрока в рейтинге (docs/35-stage4-plan.md WP44, часть 3б):
 * модератор снимает сомнительный забег с рейтинга или возвращает его, с
 * причиной. Ограничение рейтинга закрывает доски на срок, а это — про
 * конкретный рекорд: иначе поставленный до ограничения вернулся бы вместе
 * с игроком.
 */

export const DIFFICULTY_IDS = ["easy", "normal", "hard"] as const;
export type DifficultyId = (typeof DIFFICULTY_IDS)[number];

/** Сколько забегов сложности отдаёт сервер — тот же `MODERATION_RUNS_SHOWN`, что в `runs-view.service.ts`. */
export const RATING_RUNS_SHOWN = 10;

const runSchema = z.object({
  runId: z.string(),
  survivalSec: z.number(),
  level: z.number(),
  enemiesKilled: z.number(),
  startingWeaponId: z.string(),
  finishedAt: z.string(),
  /** `false` — снят с рейтинга модератором */
  ranked: z.boolean(),
});
export type RatingRun = z.infer<typeof runSchema>;

const listSchema = z.array(runSchema);
export const ratingRunsSchema = z.object({ runs: z.object({ easy: listSchema, normal: listSchema, hard: listSchema }) });
export type RatingRuns = z.infer<typeof ratingRunsSchema>["runs"];

const changeSchema = z.object({ accountId: z.string(), ranked: z.boolean() });

/** Какую сложность открыть первой: где есть что разбирать, а не пустую «лёгкую». */
export function firstDifficulty(runs: RatingRuns): DifficultyId {
  return DIFFICULTY_IDS.find((id) => runs[id].length > 0) ?? "normal";
}

/** Рекорд в доске — лучший рейтинговый: список с сервера отсортирован лучшими вперёд. */
export function holderOf(rows: readonly RatingRun[]): RatingRun | null {
  return rows.find((row) => row.ranked) ?? null;
}

/**
 * Что станет с местом игрока — до нажатия, словами. Закрытый рейтинг
 * (ограничение или блокировка) доску не трогает: игрок вернётся в неё по
 * сроку уже с тем, что останется рейтинговым.
 */
export function rankingEffect(rows: readonly RatingRun[], run: RatingRun, ratingClosed: boolean): string {
  const holder = holderOf(rows);
  const time = formatDuration;
  if (run.ranked) {
    if (ratingClosed) return "Рейтинг игроку сейчас закрыт — в досках его нет. По сроку он вернётся уже без этого забега.";
    if (holder !== null && holder.runId !== run.runId) return `Рекорд в доске — другой забег, ${time(holder.survivalSec)}: место игрока не изменится.`;
    const index = rows.findIndex((row) => row.runId === run.runId);
    const next = rows.slice(index + 1).find((row) => row.ranked);
    if (next !== undefined) return `Рекордом в доске станет следующий забег — ${time(next.survivalSec)}; место пересчитается сразу.`;
    if (rows.length >= RATING_RUNS_SHOWN) return "Рекордом в доске станет следующий лучший забег; место пересчитается сразу.";
    return "Других забегов в рейтинге на этой сложности нет — игрок уйдёт из доски, пока не сдаст новый.";
  }
  if (ratingClosed) return "Рейтинг игроку сейчас закрыт — забег учтётся, когда игрок вернётся в доску по сроку.";
  if (holder === null) return `Игрок вернётся в доску с этим забегом — ${time(run.survivalSec)}.`;
  if (run.survivalSec > holder.survivalSec) return `Забег снова станет рекордом в доске: ${time(run.survivalSec)} вместо ${time(holder.survivalSec)}.`;
  return `Рекорд в доске лучше — ${time(holder.survivalSec)}: место игрока не изменится.`;
}

export function fetchRatingRuns(api: AdminApi, accountId: string): Promise<ApiResult<RatingRuns>> {
  return api.request(`/players/${encodeURIComponent(accountId)}/runs/rating`, { schema: ratingRunsSchema.transform((value) => value.runs) });
}

/** Снять с рейтинга (`ranked: false`) или вернуть (`true`); причина — в журнал аудита. */
export function setRunRanked(api: AdminApi, runId: string, ranked: boolean, comment: string): Promise<ApiResult<z.infer<typeof changeSchema>>> {
  return api.request(`/runs/${encodeURIComponent(runId)}/${ranked ? "rerank" : "unrank"}`, { method: "POST", body: { comment }, schema: changeSchema });
}
