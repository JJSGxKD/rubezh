import { t } from "../../i18n";
import "../../i18n/season";
import type { LadderStep, PendingReward, SeasonReward } from "../../state/seasons-api";

/**
 * Чистые правила экрана недельного сезона (tasks/T-0111): время до конца,
 * даты, прогресс порога, лестница наград. Тексты — из словаря
 * `i18n/ru-season.json`, числа наград клиент не выдумывает: только множитель
 * сложности и то же округление, что у сервера.
 */

const HOUR_SEC = 3600;
const DAY_SEC = 86_400;
const MINUTE_SEC = 60;

/** Сколько осталось до конца сезона словами: «3 д 4 ч», «5 ч 20 мин», «12 мин». */
export function formatSeasonLeft(secondsLeft: number): string {
  if (!Number.isFinite(secondsLeft) || secondsLeft <= 0) return t("season.closing");
  const whole = Math.floor(secondsLeft);
  if (whole >= DAY_SEC) {
    return t("season.left.day", { days: Math.floor(whole / DAY_SEC), hours: Math.floor((whole % DAY_SEC) / HOUR_SEC) });
  }
  if (whole >= HOUR_SEC) {
    return t("season.left.hour", { hours: Math.floor(whole / HOUR_SEC), minutes: Math.floor((whole % HOUR_SEC) / MINUTE_SEC) });
  }
  if (whole >= MINUTE_SEC) return t("season.left.min", { minutes: Math.floor(whole / MINUTE_SEC) });
  return t("season.left.lt1");
}

/**
 * Сколько осталось сейчас: ответ сервера минус время по монотонным часам
 * устройства (`performance.now()`), а не по часам телефона — у части они сбиты.
 * Часы, пошедшие назад (чужие данные в тесте), времени не прибавляют.
 */
export function seasonLeftAt(secondsLeft: number, receivedAtMs: number, nowMs: number): number {
  const elapsedSec = Math.max(0, nowMs - receivedAtMs) / 1000;
  return Math.max(0, secondsLeft - elapsedSec);
}

const DATE_PARTS = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });

interface DateLabel {
  day: string;
  month: string;
}

function dateLabel(iso: string): DateLabel | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = DATE_PARTS.formatToParts(date);
  const day = parts.find((part) => part.type === "day")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return day === undefined || month === undefined ? null : { day, month };
}

/**
 * Даты сезона по Гринвичу: «2–8 ноября», на стыке месяцев — «28 декабря –
 * 3 января». Конец сезона — понедельник 00:00, последний день — сутками раньше.
 * Часовой пояс устройства не участвует: всё через UTC.
 */
export function seasonRangeLabel(startsAt: string, endsAt: string): string {
  const end = new Date(endsAt);
  const first = dateLabel(startsAt);
  const last = Number.isNaN(end.getTime()) ? null : dateLabel(new Date(end.getTime() - DAY_SEC * 1000).toISOString());
  if (first === null || last === null) return "";
  if (first.month === last.month) return `${first.day}–${last.day} ${last.month}`;
  return `${first.day} ${first.month} – ${last.day} ${last.month}`;
}

/** Одна дата по Гринвичу — «2 ноября»: когда начнётся первый сезон. */
export function seasonDateLabel(iso: string): string {
  const label = dateLabel(iso);
  return label === null ? "" : `${label.day} ${label.month}`;
}

/** Порог недели: достигнут ли и сколько секунд осталось продержаться. */
export function thresholdProgress(best: number | null, threshold: number): { reached: boolean; leftSec: number } {
  if (best === null) return { reached: false, leftSec: threshold };
  return best >= threshold ? { reached: true, leftSec: 0 } : { reached: false, leftSec: threshold - best };
}

export interface LadderRow {
  /** «1 место», «2–3 места» */
  label: string;
  coins: number;
  prestige: number;
}

/** Ступени мест с множителем сложности; округление — `Math.round`, как у сервера. */
export function ladderRows(ladder: readonly LadderStep[], mul: number): LadderRow[] {
  return ladder.map((step) => ({
    label:
      step.fromPlace === step.toPlace
        ? t("season.place.single", { n: step.fromPlace })
        : t("season.place.range", { from: step.fromPlace, to: step.toPlace }),
    coins: Math.round(step.coins * mul),
    prestige: Math.round(step.prestige * mul),
  }));
}

/** Сумма наград, которые ждут в плашке «Забрать». */
export function pendingTotal(pending: readonly PendingReward[]): SeasonReward {
  return pending.reduce<SeasonReward>(
    (sum, entry) => ({ coins: sum.coins + entry.coins, prestige: sum.prestige + entry.prestige }),
    { coins: 0, prestige: 0 },
  );
}

// --- Рейтинг по очкам (tasks/T-0296, Р66, Р152) ---

/** Оси очков и стили забега: Стойкость → Стена, Натиск → Ураган, Охота → Охотник, Чистота → Тень, Сборка → Мастер. */
export const STYLE_AXES = ["t", "k", "h", "c", "b"] as const;
export type StyleAxis = (typeof STYLE_AXES)[number];

/** Дивизионы от высшего к низшему — порядок как у сервера (`rating/division-rules.ts`). */
export const DIVISION_IDS = ["ruby", "gold", "silver", "bronze"] as const;
export type DivisionId = (typeof DIVISION_IDS)[number];

/** Ось из ответа сервера; незнакомая (сервер новее клиента) — `null`, значок не рисуется. */
export function styleAxis(value: unknown): StyleAxis | null {
  return STYLE_AXES.find((axis) => axis === value) ?? null;
}

export function divisionId(value: unknown): DivisionId | null {
  return DIVISION_IDS.find((division) => division === value) ?? null;
}

/** Ключ подсказки к слабой оси; сервер отдаёт только ось, текст — у клиента. */
export function hintKey(axis: StyleAxis): string {
  return `rating.hint.${axis}`;
}

/** По чему ранжирована таблица: очки или время (сезоны до `rating.points-from`). */
export type Scoring = "points" | "time";

interface ScoreRow {
  points?: number | null | undefined;
  survivalSec: number;
}

export interface ScoreView {
  /** что показано главным числом */
  kind: Scoring;
  value: number;
  /** время забега подписью к очкам; у времени подписи нет */
  sub: number | null;
}

/**
 * Главное число строки — то, по чему ранжирована таблица, чтобы порядок строк
 * совпадал с видимым числом. Очков нет (сервер до них, сезон по времени) —
 * показывается время.
 */
export function scoreOf(row: ScoreRow, scoring: Scoring): ScoreView {
  if (scoring === "points" && row.points !== undefined && row.points !== null) {
    return { kind: "points", value: row.points, sub: row.survivalSec };
  }
  return { kind: "time", value: row.survivalSec, sub: null };
}

/**
 * По чему ранжирована таблица «Всё время»: сервер с очками отдаёт их в каждой
 * строке, до очков — только время. Решает первая строка (или «я», если таблица
 * пуста): смешанных таблиц не бывает.
 */
export function boardScoring(entries: readonly ScoreRow[], me: ScoreRow | null): Scoring {
  const probe = entries[0] ?? me;
  return probe !== null && probe.points !== undefined && probe.points !== null ? "points" : "time";
}

/** Круги таблицы недели: все, друзья, свой дивизион. */
export type RatingCircle = "all" | "friends" | "division";
export const RATING_CIRCLES: readonly RatingCircle[] = ["all", "friends", "division"];

/** Число, по которому строки стоят в таблице; `null` — по нему сравнить нельзя. */
function standing(row: ScoreRow, scoring: Scoring): number | null {
  if (scoring === "time") return row.survivalSec;
  return row.points ?? null;
}

export type NextPlace = { kind: "first" } | { kind: "gap"; place: number; gap: number; unit: Scoring } | { kind: "unknown" };

/**
 * Сколько до следующего места: цель на один забег. Берётся ближайший выше из
 * показанных строк — это сосед (место − 1), пока он на экране; когда игрок
 * далеко за показанным, цель — последняя показанная строка, и в ответе её
 * место: числа для соседа, которого клиент не видел, не выдумываем. Ровно
 * столько же очков — разрыв единица: обойти можно, только набрав больше.
 */
export function nextPlace(me: ScoreRow & { rank: number }, entries: readonly (ScoreRow & { rank: number })[], scoring: Scoring): NextPlace {
  if (me.rank <= 1) return { kind: "first" };
  let target: (ScoreRow & { rank: number }) | null = null;
  for (const row of entries) {
    if (row.rank < me.rank && (target === null || row.rank > target.rank)) target = row;
  }
  const mine = standing(me, scoring);
  const theirs = target === null ? null : standing(target, scoring);
  if (target === null || mine === null || theirs === null) return { kind: "unknown" };
  return { kind: "gap", place: target.rank, gap: Math.max(1, theirs - mine), unit: scoring };
}

export interface PodiumStep<T> {
  place: 1 | 2 | 3;
  entry: T;
}

/** Ступени пьедестала слева направо: 2 · 1 · 3; игроков меньше трёх — столько ступеней, сколько есть. */
export function podiumSteps<T>(entries: readonly T[]): PodiumStep<T>[] {
  const top = entries.slice(0, 3);
  const at = (place: 1 | 2 | 3): PodiumStep<T>[] => {
    const entry = top[place - 1];
    return entry === undefined ? [] : [{ place, entry }];
  };
  return [...at(2), ...at(1), ...at(3)];
}

/** Верхние доли доски в процентах — те же, что `DIVISION_PERCENT` сервера; у бронзы доли нет. */
const DIVISION_PERCENT: Readonly<Record<Exclude<DivisionId, "bronze">, number>> = { ruby: 1, gold: 10, silver: 35 };

/** Доля сезона, которую занимает дивизион, для плашки «топ-N%»; бронза — все с забегом, доли нет. */
export function divisionShare(division: DivisionId): number | null {
  return division === "bronze" ? null : DIVISION_PERCENT[division];
}

/** Сколько первых мест доски входит в дивизион: доля вверх, поэтому рубин — хотя бы первое место. */
function placesUpTo(division: Exclude<DivisionId, "bronze">, total: number): number {
  return Math.ceil((total * DIVISION_PERCENT[division]) / 100);
}

/** Место доски, с которого дивизион начинается. */
export function divisionFirstRank(division: DivisionId, total: number): number {
  const higher = DIVISION_IDS[DIVISION_IDS.indexOf(division) - 1];
  return higher === undefined || higher === "bronze" ? 1 : placesUpTo(higher, total) + 1;
}

/** Место внутри дивизиона: считается от его начала, а не по показанным строкам — доска показывает только верх. */
export function divisionPlace(rank: number, division: DivisionId, total: number): number {
  return Math.max(1, rank - divisionFirstRank(division, total) + 1);
}

/**
 * Сколько очков до следующего дивизиона: нужно обойти последнего игрока
 * старшего дивизиона. Если его строки нет на экране, числа нет — `null`
 * (сервер границу пока не отдаёт). У рубина старшего нет.
 */
export function nextDivisionGap(
  division: DivisionId,
  total: number,
  me: ScoreRow,
  entries: readonly (ScoreRow & { rank: number })[],
  scoring: Scoring,
): { next: DivisionId; gap: number; unit: Scoring } | null {
  const next = DIVISION_IDS[DIVISION_IDS.indexOf(division) - 1];
  if (next === undefined || next === "bronze") return null;
  const border = entries.find((row) => row.rank === placesUpTo(next, total));
  const mine = standing(me, scoring);
  const theirs = border === undefined ? null : standing(border, scoring);
  if (mine === null || theirs === null) return null;
  return { next, gap: Math.max(1, theirs - mine), unit: scoring };
}

/** Сколько суток до конца сезона для подписи над списком: неполные сутки — за целые, время вышло — ноль. */
export function seasonDaysLeft(secondsLeft: number): number {
  return Number.isFinite(secondsLeft) && secondsLeft > 0 ? Math.ceil(secondsLeft / DAY_SEC) : 0;
}

