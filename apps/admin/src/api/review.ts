import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Очередь разбора забегов (`GET /admin/runs/review`): подозрительные и
 * отклонённые проверкой сервера, свежие первыми (docs/34-stage3-plan.md, WP4).
 */
export const reviewRowSchema = z.object({
  runId: z.string(),
  accountId: z.string(),
  verdict: z.string(),
  verdictReasons: z.array(z.string()),
  difficulty: z.string(),
  survivalSec: z.number().nullable(),
  level: z.number().nullable(),
  enemiesKilled: z.number().nullable(),
  finishedAt: z.string().nullable(),
});

export type ReviewRow = z.infer<typeof reviewRowSchema>;

/** Сервер отдаёт не больше двухсот; очередь длиннее — повод разбираться, а не листать. */
export const REVIEW_LIMIT = 200;

export function fetchReviewQueue(api: AdminApi): Promise<ApiResult<{ runs: ReviewRow[] }>> {
  return api.request("/runs/review", { query: { limit: REVIEW_LIMIT }, schema: z.object({ runs: z.array(reviewRowSchema) }) });
}
