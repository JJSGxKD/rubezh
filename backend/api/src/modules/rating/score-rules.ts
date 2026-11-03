import { TABLE_MINUTES, type ExpectedRow } from "./expected-table.js";

/**
 * Очки эффективности забега (tasks/T-0293, Р66, Р152, `design/art/meta-v2.md`
 * §2.2): пять осей против ожидаемого для силы игрока и минуты, очки и стиль.
 * Всё чистое — без базы, настроек и часов: каждое правило проверяется на
 * границе отдельно.
 *
 * Ось — индекс `I`: 1 — ровно ожидаемое, 1,5 — в полтора раза лучше. Очки —
 * `1000 × Σ вес × min(I, потолок)`: один выброс (повезло с сундуком) забег не
 * делает, а сам выброс сверх двух потолков — подозрение, а не очки.
 */

/** Порядок осей — он же порядок при равенстве стиля: Стойкость, Натиск, Охота, Чистота, Сборка. */
export const AXIS_IDS = ["t", "k", "h", "c", "b"] as const;
export type AxisId = (typeof AXIS_IDS)[number];
export type AxisValues = Record<AxisId, number>;

/** Названия стилей забега: ключ сильнейшей оси → имя у игрока. Хранится ключ, имя — для логов и текстов. */
export const STYLE_NAMES: Readonly<Record<AxisId, string>> = { t: "Стена", k: "Ураган", h: "Охотник", c: "Тень", b: "Мастер" };

/** Очки идеального по всем осям забега при потолке индекса 1: масштаб Р152. */
const POINTS_SCALE = 1_000;

/** Минут для темпа не меньше полуминуты: забег в две секунды иначе давал бы темп в тысячи раз выше ожидаемого. */
const MIN_MINUTES = 0.5;
/** Коридор скорости убийства элиты и босса: быстрее вдвое — вдвое дороже, медленнее вдвое — вполовину. */
const HUNT_SPEED_MIN = 0.5;
const HUNT_SPEED_MAX = 2;
/** Коридор Чистоты. */
const CLEAN_MIN = 0.3;
const CLEAN_MAX = 2;
/** Полученный урон в минуту не меньше единицы: нулевой урон не делит на ноль и даёт верх коридора. */
const MIN_DAMAGE_PER_MIN = 1;
/** Стойкость отсчитывается от десяти минут: типичный забег калибровки. */
const ENDURANCE_REFERENCE_SEC = 600;

export interface ScoreParams {
  /** веса осей, сумма — единица (`normalizeWeights`) */
  weights: AxisValues;
  /** показатель Стойкости: `(t / 600) ^ показатель` */
  enduranceExponent: number;
  /** потолок индекса в очках */
  cap: number;
}

export interface HuntLogEntry {
  rank: "elite" | "boss";
  value: number;
  aliveSec: number;
}

/** Что даёт забег подсчёту; `null` — клиент прошлой сборки поля не прислал, ось считается единицей. */
export interface ScoreInput {
  survivalSec: number;
  enemiesKilled: number;
  damageTaken: number | null;
  huntLog: readonly HuntLogEntry[] | null;
  buildScore: number | null;
}

/** Минута забега для таблицы: потолок от минут, от первой до двадцатой. */
export function minuteOf(survivalSec: number): number {
  return Math.min(TABLE_MINUTES, Math.max(1, Math.ceil(survivalSec / 60)));
}

/**
 * Сырые индексы пяти осей. Потолок индекса здесь не применяется: выброс
 * должен быть виден антифроду, очки его срезают отдельно (`pointsOf`).
 */
export function axisIndexes(input: ScoreInput, expected: ExpectedRow, params: ScoreParams): AxisValues {
  const minutes = Math.max(input.survivalSec / 60, MIN_MINUTES);
  return {
    t: (Math.max(input.survivalSec, 0) / ENDURANCE_REFERENCE_SEC) ** params.enduranceExponent,
    k: expected.killsPerMin > 0 ? input.enemiesKilled / minutes / expected.killsPerMin : 1,
    h: huntIndex(input.huntLog, expected, minutes),
    c: cleanIndex(input.damageTaken, expected, minutes),
    b: input.buildScore === null ? 1 : input.buildScore / Math.max(expected.buildScore, 1),
  };
}

/**
 * Охота: ценность убитых элит и боссов, умноженная на скорость убийства,
 * в минуту — к ожидаемой. Ранние минуты без элит (`huntPerMin = 0`) и забег
 * без журнала — единица: охотиться там было не на кого или нечем измерить.
 * Ожидаемое время убийства, которого таблица не знает (нуль: такого убитого в
 * прогонах калибровки ещё не было), даёт нижний край коридора — по формуле
 * спецификации, без особого случая.
 */
function huntIndex(log: readonly HuntLogEntry[] | null, expected: ExpectedRow, minutes: number): number {
  if (log === null || expected.huntPerMin <= 0) return 1;
  let sum = 0;
  for (const entry of log) {
    const expectedSec = expected.huntKillSec[entry.rank];
    sum += entry.value * speedFactor(expectedSec, entry.aliveSec);
  }
  return sum / minutes / expected.huntPerMin;
}

/** Скорость убийства: ожидаемое время к фактическому, в коридоре. Мгновенное убийство — верх коридора. */
function speedFactor(expectedSec: number, aliveSec: number): number {
  if (expectedSec <= 0) return HUNT_SPEED_MIN;
  if (aliveSec <= 0) return HUNT_SPEED_MAX;
  return Math.min(HUNT_SPEED_MAX, Math.max(HUNT_SPEED_MIN, expectedSec / aliveSec));
}

/** Чистота: ожидаемый входящий урон в минуту к полученному, в коридоре. Нет счётчика — единица. */
function cleanIndex(damageTaken: number | null, expected: ExpectedRow, minutes: number): number {
  if (damageTaken === null) return 1;
  const perMin = Math.max(damageTaken / minutes, MIN_DAMAGE_PER_MIN);
  return Math.min(CLEAN_MAX, Math.max(CLEAN_MIN, expected.damageTakenPerMin / perMin));
}

function capped(indexes: AxisValues, cap: number): AxisValues {
  return { t: Math.min(indexes.t, cap), k: Math.min(indexes.k, cap), h: Math.min(indexes.h, cap), c: Math.min(indexes.c, cap), b: Math.min(indexes.b, cap) };
}

/** Очки: `round(1000 × Σ вес × min(I, потолок))`. */
export function pointsOf(indexes: AxisValues, params: ScoreParams): number {
  const limited = capped(indexes, params.cap);
  let sum = 0;
  for (const axis of AXIS_IDS) sum += params.weights[axis] * limited[axis];
  return Math.round(POINTS_SCALE * sum);
}

/** Стиль — ось с наибольшим потолочным индексом; при равенстве — первая по порядку `t, k, h, c, b`. */
export function styleOf(indexes: AxisValues, params: ScoreParams): AxisId {
  const limited = capped(indexes, params.cap);
  let best: AxisId = "t";
  for (const axis of AXIS_IDS) {
    if (limited[axis] > limited[best]) best = axis;
  }
  return best;
}

/** Сырой индекс любой оси выше двух потолков — выброс, который честный забег не даёт. */
export function isOutOfRange(indexes: AxisValues, cap: number): boolean {
  return AXIS_IDS.some((axis) => indexes[axis] > 2 * cap);
}

/**
 * Очки забега той же длины, сыгранного ровно по ожидаемому: Стойкость — та
 * же, остальные оси — единица. Черта «ожидаемое» на карточке забега.
 */
export function expectedPointsOf(enduranceIndex: number, params: ScoreParams): number {
  const weight = params.weights.t;
  return Math.round(POINTS_SCALE * (weight * Math.min(enduranceIndex, params.cap) + (1 - weight)));
}

/**
 * Веса к сумме единица. Сумма не единица — нормируем, а вызывающий пишет
 * предупреждение: панель правят по одному ключу, и сумма может разойтись.
 * Все нули — умолчание: делить на нуль нельзя, а очков без весов не бывает.
 */
export function normalizeWeights(raw: AxisValues, fallback: AxisValues = DEFAULT_WEIGHTS): { weights: AxisValues; normalized: boolean } {
  const sum = AXIS_IDS.reduce((total, axis) => total + raw[axis], 0);
  if (!(sum > 0)) return { weights: { ...fallback }, normalized: true };
  if (Math.abs(sum - 1) < 1e-9) return { weights: { ...raw }, normalized: false };
  return {
    weights: { t: raw.t / sum, k: raw.k / sum, h: raw.h / sum, c: raw.c / sum, b: raw.b / sum },
    normalized: true,
  };
}

/** Веса Р152 — запасные, когда панель выдала нули. Рабочие умолчания — в каталоге настроек. */
export const DEFAULT_WEIGHTS: AxisValues = { t: 0.4, k: 0.2, h: 0.2, c: 0.1, b: 0.1 };

/** Индекс с тремя знаками — так он лежит в строке забега и уходит в ответ. */
export function roundIndex(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
