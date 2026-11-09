import { formatDuration, formatNumber, t } from "../../i18n";
import "../../i18n/run-card";
import { STYLE_AXES, type StyleAxis } from "./rating-rules";

/**
 * Правила карточки забега (tasks/T-0297, Р66, Р152, `design/art/meta-v2.md`
 * §2.4): точки «паутины», длины полос разбора, подписи осей и адрес в
 * стартовом параметре. Всё чистое — без React и сети: каждое правило
 * проверяется на границе отдельно, а экран только рисует их ответы.
 */

/** Ось в разборе — как её отдаёт сервер (`run-card.service.ts`). */
export interface CardAxis {
  axis: StyleAxis;
  /** сырой индекс оси: 1 — ровно ожидаемое */
  index: number;
  /** слагаемое очков */
  points: number;
  /** слагаемое ожидаемого забега */
  expectedPoints: number;
}

export interface WebPoint {
  x: number;
  y: number;
}

/**
 * Направления пяти лучей, единичные векторы (y вниз): Стойкость вверх, дальше
 * по часовой стрелке — Натиск, Охота, Чистота, Сборка. Готовая таблица, а не
 * синус и косинус в цикле отрисовки: её видно глазами и проверяет тест.
 */
const RAYS: Readonly<Record<StyleAxis, WebPoint>> = {
  t: { x: 0, y: -1 },
  k: { x: 0.9510565162951535, y: -0.30901699437494745 },
  h: { x: 0.5877852522924731, y: 0.8090169943749475 },
  c: { x: -0.5877852522924731, y: 0.8090169943749475 },
  b: { x: -0.9510565162951535, y: -0.30901699437494745 },
};

/** Доля луча от нуля до потолка: индекс выше потолка обрезается (очки его тоже срезают), ниже нуля и не число — центр. */
function share(index: number, cap: number): number {
  if (!(index > 0) || !(cap > 0)) return 0;
  return Math.min(index, cap) / cap;
}

/**
 * Вершины фигуры забега в единичном круге: ось, дошедшая до потолка, лежит на
 * его краю. При потолке 3 ожидаемое (все единицы) — правильный пятиугольник
 * радиуса 1/3.
 */
export function webPoints(indexes: Readonly<Record<StyleAxis, number>>, cap: number): WebPoint[] {
  return STYLE_AXES.map((axis) => {
    const length = share(indexes[axis], cap);
    const ray = RAYS[axis];
    return { x: ray.x * length, y: ray.y * length };
  });
}

/** Подпись оси «Стойкость»… для скринридера и рисунка. */
export function axisName(axis: StyleAxis): string {
  return t(`runCard.axis.${axis}`);
}

/** Заголовок экрана: «Забег · 9 812». */
export function cardTitle(points: number): string {
  return t("runCard.title", { points: formatNumber(points) });
}

export interface BarShare {
  axis: StyleAxis;
  /** длина полосы: доля самого длинного из слагаемых (очков и ожидаемого) */
  share: number;
  /** положение черты ожидаемого на той же шкале */
  expectedShare: number;
}

/**
 * Длины полос разбора: пропорциональны слагаемым, шкала одна на все оси —
 * по самому большому слагаемому, очков или ожидаемого, чтобы ни полоса, ни
 * черта не вылезали за край, а полосы оси с оси оставались сравнимыми.
 */
export function barShares(axes: readonly CardAxis[]): BarShare[] {
  let scale = 0;
  for (const axis of axes) scale = Math.max(scale, axis.points, axis.expectedPoints);
  const of = (value: number): number => (scale > 0 && value > 0 ? Math.min(1, value / scale) : 0);
  return axes.map((axis) => ({ axis: axis.axis, share: of(axis.points), expectedShare: of(axis.expectedPoints) }));
}

/** Числа, из которых составляются подписи осей. */
export interface CaptionSource {
  survivalSec: number;
  facts: { killsPerMin: number; bossKills: number | null; eliteKills: number | null; damageDeltaPct: number | null };
}

/** Знак процента: настоящий минус, как в макете, а не дефис; нуль без знака. */
function signed(value: number): string {
  if (value > 0) return `+${formatNumber(value)}`;
  if (value < 0) return `−${formatNumber(Math.abs(value))}`;
  return "0";
}

/**
 * Подпись под названием оси: «31:48 при 10:00», «412 / мин», «6 боссов · 58
 * элит», «урон −38 %», «2 эволюции». Нет числа (забег записан сборкой без
 * него) — `null`: подписи нет совсем, а не нули вместо неизвестного.
 */
export function axisCaption(axis: StyleAxis, source: CaptionSource, evolutions: number): string | null {
  const { facts } = source;
  switch (axis) {
    case "t":
      return t("runCard.caption.t", { time: formatDuration(source.survivalSec) });
    case "k":
      return t("runCard.caption.k", { rate: formatNumber(facts.killsPerMin) });
    case "h":
      if (facts.bossKills === null || facts.eliteKills === null) return null;
      return t("runCard.caption.h", { bosses: facts.bossKills, elites: facts.eliteKills });
    case "c":
      return facts.damageDeltaPct === null ? null : t("runCard.caption.c", { pct: signed(facts.damageDeltaPct) });
    case "b":
      return evolutions > 0 ? t("runCard.caption.b", { n: evolutions }) : t("runCard.caption.bNone");
  }
}

/** Сколько эволюций в наборе: что считать эволюцией, решает вызывающий (контент игры), повторы не в счёт. */
export function evolutionCount(weapons: readonly { id: string }[], isEvolution: (id: string) => boolean): number {
  return new Set(weapons.filter((weapon) => isEvolution(weapon.id)).map((weapon) => weapon.id)).size;
}

// Пара `run` стартового параметра живёт в state: её читает навигация в первой загрузке.
export { parseRunCardStart, runCardStartParam } from "../../state/run-card-start";
