import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Очередь разбора забегов (`GET /admin/runs/review`): подозрительные и
 * отклонённые проверкой сервера, свежие первыми (docs/34-stage3-plan.md, WP4).
 */
export const reviewRowSchema = z.object({
  runId: z.string(),
  accountId: z.string(),
  displayName: z.string().nullable(),
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

/**
 * Причины вердикта словами — те же, что в карточке разбора в чате
 * (`backend/api/src/modules/admin-notify/run-review-card.ts`). Код новее
 * панели показывается как есть: лучше код, чем пустое место.
 */
const REASON_TITLES: Readonly<Record<string, string>> = {
  weapons_over_slots: "оружий больше, чем слотов",
  longer_than_wall_clock: "забег дольше, чем прошло по часам сервера",
  kill_rate: "убийств в секунду больше порога",
  level_rate: "уровни растут быстрее порога",
  unknown_content: "незнакомый отпечаток контента — сборка не из выпущенных",
  unpaid_continue: "второй шанс без оплаты",
  underpaid_continue: "второй шанс оплачен за меньшее время, чем прошло",
  unverified_time: "старт не дошёл — время забега не проверено",
  loadout_forged: "снимок снаряжения не подписан сервером",
  loadout_stale: "снаряжение сменилось после выдачи снимка",
  loadout_level_ahead: "уровень снимка выше уровня аккаунта",
  boost_unpaid: "буст не куплен на этот забег",
};

export function reasonTitle(code: string): string {
  return REASON_TITLES[code] ?? code;
}

/** Сложность — как её называет игра (`difficulty.<id>.name` в словаре оболочки). */
const DIFFICULTY_TITLES: Readonly<Record<string, string>> = { easy: "лёгкая", normal: "нормальная", hard: "сложная" };

export function difficultyTitle(id: string): string {
  return DIFFICULTY_TITLES[id] ?? id;
}

export const VERDICT_FILTERS = [
  { id: "all", title: "Все" },
  { id: "rejected", title: "Отклонённые" },
  { id: "suspicious", title: "Подозрительные" },
] as const;
export type VerdictFilter = (typeof VERDICT_FILTERS)[number]["id"];

/** Сколько забегов каждого игрока в очереди: повтор — сильнее повод разобраться, чем один забег. */
export function runsPerPlayer(rows: readonly ReviewRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.accountId, (counts.get(row.accountId) ?? 0) + 1);
  return counts;
}
