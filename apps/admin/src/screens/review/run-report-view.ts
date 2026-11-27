import type { RunReport } from "../../api/run-report";
import type { RunReplay } from "../../api/review";
import { formatDateTime, formatNumber } from "../../format";
import { shortId } from "../players/card-rules";

/**
 * Слова страницы отчёта забега (Р203, tasks/T-0420). Чистые функции без
 * React: что окна решений говорят про рейтинг до нажатия, а что тост — после,
 * проверяется тестом, а не глазами.
 *
 * Сервер отдаёт ключи осей `t`, `k`, `h`, `c`, `b`; названия — здесь, как в
 * `STYLE_NAMES` сервера (`rating/score-rules.ts`).
 */

export type ReviewViewId = "queue" | "report";

/** Что рисует раздел: адрес с объектом — отчёт забега, без него — очередь. */
export function reviewView(id: string | null): ReviewViewId {
  return id === null ? "queue" : "report";
}

export const AXIS_TITLES: Readonly<Record<"t" | "k" | "h" | "c" | "b", string>> = {
  t: "Стойкость (время)",
  k: "Убийства в минуту",
  h: "Охота на элит и боссов",
  c: "Чистота (получено урона)",
  b: "Сборка",
};

export const STYLE_TITLES: Readonly<Record<"t" | "k" | "h" | "c" | "b", string>> = {
  t: "Стена",
  k: "Ураган",
  h: "Охотник",
  c: "Тень",
  b: "Мастер",
};

/** Порядок осей в таблице — как в словаре, а не как пришёл объект. */
export const AXIS_ORDER = ["t", "k", "h", "c", "b"] as const;

export type BadgeTone = "neutral" | "danger" | "success" | "warning";

export function verdictBadge(verdict: string | null): { tone: BadgeTone; text: string } {
  switch (verdict) {
    case "rejected":
      return { tone: "danger", text: "отклонён" };
    case "suspicious":
      return { tone: "warning", text: "подозрительный" };
    case "ok":
      return { tone: "success", text: "честный по проверке" };
    default:
      return { tone: "neutral", text: "без вердикта" };
  }
}

const OUTCOME_WORDS: Readonly<Record<string, string>> = { honest: "честный", annulled: "аннулирован" };

/** Решение команды одной строкой; `null` — забег не разбирали (или исход новее панели и безымянный). */
export function reviewText(review: RunReport["review"]): string | null {
  if (review.outcome === null) return null;
  const word = OUTCOME_WORDS[review.outcome] ?? review.outcome;
  const who = review.reviewerName ?? (review.reviewedBy === null ? null : shortId(review.reviewedBy));
  const parts = [who, review.reviewedAt === null ? null : formatDateTime(review.reviewedAt)].filter((part): part is string => part !== null);
  return parts.length === 0 ? `Решение: ${word}` : `Решение: ${word} — ${parts.join(", ")}`;
}

export function ratingText(rating: RunReport["rating"]): string {
  if (rating.ranked) return "В рейтинге";
  if (rating.ratingRestricted === "silent") return "Не в рейтинге: молчаливое ограничение";
  if (rating.ratingRestricted === "notified") return "Не в рейтинге: ограничение, игроку сообщили";
  return "Не в рейтинге";
}

export function axisText(value: number): string {
  return `${value.toFixed(2).replace(".", ",")} × ожидаемого`;
}

/** Почему решение не вернёт забег в рейтинг — по первому совпадению. */
export function notReturnableWhy(report: Pick<RunReport, "cheats" | "mode" | "rating">): string {
  if (report.cheats) return "забег с читами";
  if (report.rating.ratingRestricted !== null) return "сдан под ограничением рейтинга";
  if (report.mode === "prologue") return "пролог";
  return "нерейтинговая сложность или забег раньше отсечки рейтинга";
}

/** Строка «Рейтинг» окон «Честный» и «Вернуть забег»: панель говорит заранее, а не обещает вслепую. */
export function ratingChange(report: Pick<RunReport, "cheats" | "mode" | "rating">): string {
  if (report.rating.ranked) return "уже в рейтинге";
  if (report.rating.returnable) return "вернуть в текущие доски";
  return `без изменений: ${notReturnableWhy(report)}`;
}

export interface Change {
  label: string;
  value: string;
}

export function honestChanges(report: RunReport): Change[] {
  return [
    { label: "Очередь разбора", value: "убрать" },
    { label: "Рейтинг", value: ratingChange(report) },
    { label: "Закрытые сезоны", value: "не меняются" },
  ];
}

export function annulChanges(report: RunReport): Change[] {
  return [
    { label: "Доски рейтинга и сезона", value: report.rating.ranked ? "убрать забег" : "забега в них нет" },
    { label: "Выданные награды", value: "не отнимаются" },
    { label: "Закрытые сезоны", value: "не меняются" },
    { label: "Очередь разбора", value: "убрать" },
  ];
}

export function restoreChanges(report: RunReport): Change[] {
  return [
    { label: "Решение разбора", value: "аннулирован → честный" },
    { label: "Рейтинг", value: ratingChange(report) },
    { label: "Закрытые сезоны", value: "не меняются" },
    { label: "Очередь разбора", value: "не вернётся" },
  ];
}

export type DecisionAction = "honest" | "annul" | "restore";

/** Тост после решения — по ответу сервера: в рейтинге забег или нет, решает он. */
export function decisionToast(action: DecisionAction, report: Pick<RunReport, "rating">): string {
  const ranked = report.rating.ranked;
  switch (action) {
    case "honest":
      return ranked ? "Забег снят с очереди и возвращён в рейтинг" : "Забег снят с очереди";
    case "annul":
      return "Забег аннулирован";
    case "restore":
      return ranked ? "Аннулирование отменено, забег в рейтинге" : "Аннулирование отменено";
  }
}

/**
 * Перепроверка повтором на сервере (tasks/T-0319): исход словами, тик расхождения
 * и таблица «заявлено / повтор». Сервер читает те же слова из ключей `replay.*`;
 * исход новее панели показывается как есть, а не роняет страницу.
 */
const REPLAY_VERDICTS: Readonly<Record<string, { tone: BadgeTone; text: string }>> = {
  pending: { tone: "neutral", text: "ожидает" },
  match: { tone: "success", text: "совпал" },
  mismatch: { tone: "danger", text: "разошёлся" },
  content_mismatch: { tone: "warning", text: "не тот контент (наша сторона)" },
  not_replayable: { tone: "neutral", text: "запись обрезана, повторить нельзя" },
  broken: { tone: "warning", text: "повтор не удался (наша сторона)" },
  timeout: { tone: "warning", text: "не уложился во время (наша сторона)" },
  no_proof: { tone: "neutral", text: "записи нет" },
};

export function replayBadge(verdict: string | null): { tone: BadgeTone; text: string } {
  if (verdict === null) return { tone: "neutral", text: "не назначался" };
  return REPLAY_VERDICTS[verdict] ?? { tone: "neutral", text: verdict };
}

/** Тик расхождения; у остальных исходов его нет — расхождение итога с заявленным тика не имеет. */
export function replayTickText(tick: number | null): string {
  return tick === null ? "—" : `тик ${formatNumber(tick)}`;
}

function secondsText(value: number): string {
  return `${value.toFixed(1).replace(".", ",")} с`;
}

/** Секунда округляется клиентом в любую сторону — не подлог; тот же допуск у воркера (`CLAIM_SEC_TOLERANCE`). */
export const REPLAY_SEC_TOLERANCE = 1;

export interface ReplayRow {
  label: string;
  claimed: string;
  replayed: string;
  /** повтор не сошёлся с заявленным — строка подсвечивается */
  differs: boolean;
}

/** Таблица «заявлено / повтор»; повтор не дошёл до итога — справа прочерки, подсвечивать нечего. */
export function replayRows(replay: Pick<RunReplay, "claimed" | "replayed">): ReplayRow[] {
  const { claimed, replayed } = replay;
  return [
    {
      label: "Время",
      claimed: secondsText(claimed.survivalSec),
      replayed: replayed === null ? "—" : secondsText(replayed.survivalSec),
      differs: replayed !== null && Math.abs(claimed.survivalSec - replayed.survivalSec) > REPLAY_SEC_TOLERANCE,
    },
    { label: "Уровень", claimed: formatNumber(claimed.level), replayed: replayed === null ? "—" : formatNumber(replayed.level), differs: replayed !== null && claimed.level !== replayed.level },
    {
      label: "Убийств",
      claimed: formatNumber(claimed.enemiesKilled),
      replayed: replayed === null ? "—" : formatNumber(replayed.enemiesKilled),
      differs: replayed !== null && claimed.enemiesKilled !== replayed.enemiesKilled,
    },
  ];
}

/** Окно «Повторить снова»: что произойдёт, до нажатия. */
export function replayRepeatChanges(replay: Pick<RunReplay, "verdict">): Change[] {
  return [
    { label: "Прежний исход", value: replay.verdict === null ? "повтора не было" : replayBadge(replay.verdict).text },
    { label: "Исход", value: "сбросится: забег снова ждёт повтора" },
    { label: "Очередь", value: "задание уйдёт вперёд выборки" },
    { label: "Журнал действий", value: "запись об этом нажатии" },
  ];
}

export const REPLAY_REPEAT_TOAST = "Повтор поставлен в очередь";
