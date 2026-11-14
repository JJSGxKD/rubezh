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
  /** есть только у держателя права `players.board.restrict` (T-0115) */
  boardMarked: z.boolean().optional(),
  /** исход перепроверки повтором (T-0319); у забега, которому повтор не назначали, поля нет. Исход читается строкой: он мог появиться на сервере раньше панели */
  replay: z.object({ verdict: z.string(), divergedTick: z.number().nullable() }).optional(),
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
  counters_implausible: "счётчики забега не сходятся с ходом боя",
  replay_mismatch: "повтор забега на сервере разошёлся с записью",
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

/**
 * Исход перепроверки забега повтором (`GET /runs/:id/replay`) — форма `ReplayView`
 * сервера (`backend/api/src/modules/runs/run-replay.service.ts`). Исход читается
 * строкой: сервер мог обновиться раньше панели.
 */
const replayedSchema = z.object({ ticks: z.number(), survivalSec: z.number(), level: z.number(), enemiesKilled: z.number(), checksum: z.number() });

export const runReplaySchema = z.object({
  /** `null` — повтор забегу не назначали */
  verdict: z.string().nullable(),
  required: z.boolean(),
  divergedTick: z.number().nullable(),
  replayedAt: z.string().nullable(),
  reason: z.string().nullable(),
  durationMs: z.number().nullable(),
  claimed: z.object({ survivalSec: z.number(), level: z.number(), enemiesKilled: z.number() }),
  replayed: replayedSchema.nullable(),
  hasProof: z.boolean(),
  /** кнопка «Повторить снова»: запись жива и повтор сейчас не идёт */
  canRepeat: z.boolean(),
});

export type RunReplay = z.infer<typeof runReplaySchema>;

export function fetchRunReplay(api: AdminApi, runId: string): Promise<ApiResult<RunReplay>> {
  return api.request(`/runs/${encodeURIComponent(runId)}/replay`, { schema: runReplaySchema });
}

/** «Повторить снова»: сервер ставит задание ещё раз и пишет действие в журнал; ответ — новое состояние. */
export function repeatRunReplay(api: AdminApi, runId: string): Promise<ApiResult<RunReplay>> {
  return api.request(`/runs/${encodeURIComponent(runId)}/replay`, { method: "POST", body: {}, schema: runReplaySchema });
}
