import { formatDuration } from "../../common/card/labels.js";
import type { Difficulty } from "../runs/run-rules.js";
import type { RunVerdict, VerdictReason } from "../runs/run-verdict.js";

/**
 * Карточка забега на разбор в чат администраторов (docs/34-stage3-plan.md,
 * WP4): подозрительный или отклонённый антифродом. Текстом, а не картинкой:
 * разбирающему нужны числа и причины, а график здесь ничего не объясняет.
 *
 * Имя игрока в карточке есть — в отличие от сводки плейтеста, где только
 * счётчики: по карточке администратор решает, что делать с аккаунтом, и без
 * имени решать не о ком. Карточка уходит простым текстом, без разметки,
 * поэтому имя, пришедшее из Telegram, ничего в ней не сломает.
 */

export interface ReviewCardRun {
  runId: string;
  accountId: string;
  difficulty: Difficulty;
  outcome: "died" | "abandoned";
  survivalSec: number;
  level: number;
  enemiesKilled: number;
  deathCause: string | null;
  verdict: Exclude<RunVerdict, "ok">;
  reasons: VerdictReason[];
}

export interface ReviewCardAccount {
  displayName: string;
  username: string | null;
}

const DIFFICULTY_LABELS: Record<Difficulty, string> = { easy: "Лёгкая", normal: "Нормальная", hard: "Сложная" };

const VERDICT_LABELS: Record<ReviewCardRun["verdict"], string> = {
  suspicious: "подозрительный",
  rejected: "отклонён",
};

const REASON_LABELS: Record<VerdictReason, string> = {
  weapons_over_slots: "оружий больше, чем слотов",
  longer_than_wall_clock: "забег дольше, чем прошло по часам сервера",
  kill_rate: "убийств в секунду больше порога",
  level_rate: "уровни растут быстрее порога",
  unknown_content: "незнакомый отпечаток контента — сборка не из выпущенных",
  unverified_time: "старт не дошёл — время забега не проверено",
};

/** Сколько знаков id аккаунта показывать: хватает найти его, не загромождая строку. */
const ACCOUNT_ID_SHOWN = 8;

export function reviewCardText(run: ReviewCardRun, account: ReviewCardAccount | null): string {
  const who =
    account === null
      ? `аккаунт ${run.accountId}`
      : `${account.displayName}${account.username === null ? "" : ` (@${account.username})`} · аккаунт ${run.accountId.slice(0, ACCOUNT_ID_SHOWN)}`;
  const end = run.outcome === "abandoned" ? "сдался" : run.deathCause === null ? "погиб" : `погиб от ${run.deathCause}`;
  return [
    `🚩 Забег на разбор · ${VERDICT_LABELS[run.verdict]}`,
    who,
    `${DIFFICULTY_LABELS[run.difficulty]} · ${formatDuration(run.survivalSec)} · уровень ${run.level} · убийств ${run.enemiesKilled} · ${end}`,
    `Почему: ${run.reasons.map((reason) => REASON_LABELS[reason]).join("; ")}`,
    "В рейтинг не попал. Другие забеги этого аккаунта в ближайший час — без карточек, только в GET /api/v1/runs/review.",
    `Забег ${run.runId}`,
  ].join("\n");
}
