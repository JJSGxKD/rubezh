import type { ReactNode } from "react";
import { t } from "../../i18n";
import "../../i18n/run-card";
import { axisName, webPoints, type CardAxis, type WebPoint } from "./run-card-rules";
import { STYLE_AXES, type StyleAxis } from "./rating-rules";

/**
 * «Паутина» пяти осей (tasks/T-0297, `design/art/mockups/rating-v2.html`):
 * сплошная фигура — забег, пунктир — ожидаемое для силы игрока (все единицы),
 * кольца — через потолок индекса в очках. Рисунок один SVG без анимации и без
 * подписок: он считается раз на ответ сервера и не трогает цикл забега.
 */

/** Радиус потолка в единицах рисунка (viewBox ±110 × ±100 оставляет место подписям). */
const RADIUS = 80;

/** Тон подписи и фигуры каждой оси — те же токены, что у значков стиля в строках рейтинга. */
export const AXIS_TEXT: Readonly<Record<StyleAxis, string>> = {
  t: "text-secondary",
  k: "text-accent",
  h: "text-elite",
  c: "text-info",
  b: "text-passive",
};

/** Где стоит подпись оси: чуть дальше конца луча, выше или ниже — по стороне. */
const LABEL: Readonly<Record<StyleAxis, { x: number; y: number }>> = {
  t: { x: 0, y: -90 },
  k: { x: 92, y: -26 },
  h: { x: 56, y: 80 },
  c: { x: -56, y: 80 },
  b: { x: -90, y: -26 },
};

const RINGS = [1 / 3, 2 / 3, 1] as const;

function polygon(points: readonly WebPoint[]): string {
  return points.map((point) => `${(point.x * RADIUS).toFixed(1)},${(point.y * RADIUS).toFixed(1)}`).join(" ");
}

const INDEX = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

export function RunWeb(props: { axes: readonly CardAxis[]; cap: number }): ReactNode {
  const { cap } = props;
  const byAxis = new Map(props.axes.map((axis) => [axis.axis, axis.index]));
  const indexes = { t: byAxis.get("t") ?? 0, k: byAxis.get("k") ?? 0, h: byAxis.get("h") ?? 0, c: byAxis.get("c") ?? 0, b: byAxis.get("b") ?? 0 };
  const ones = { t: 1, k: 1, h: 1, c: 1, b: 1 };
  const label = t("runCard.web", { axes: STYLE_AXES.map((axis) => t("runCard.webAxis", { name: axisName(axis), index: INDEX.format(indexes[axis]) })).join(", ") });

  return (
    <svg viewBox="-110 -100 220 200" width="100%" height="190" role="img" aria-label={label} className="mt-1 block">
      {/* Кольца и лучи — сетка шкалы от нуля до потолка. */}
      <g fill="none" className="text-text-muted" stroke="currentColor" strokeOpacity="0.25">
        {RINGS.map((ring) => (
          <polygon key={ring} points={polygon(webPoints({ t: cap * ring, k: cap * ring, h: cap * ring, c: cap * ring, b: cap * ring }, cap))} />
        ))}
      </g>
      {/* Ожидаемое для силы игрока — пунктир, все оси по единице. */}
      <polygon points={polygon(webPoints(ones, cap))} fill="none" className="text-text" stroke="currentColor" strokeOpacity="0.5" strokeDasharray="3 3" />
      {/* Забег. */}
      <polygon points={polygon(webPoints(indexes, cap))} className="text-secondary" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
      <g fontSize="10" textAnchor="middle" className="font-display" aria-hidden="true">
        {STYLE_AXES.map((axis) => (
          <text key={axis} x={LABEL[axis].x} y={LABEL[axis].y} fill="currentColor" className={AXIS_TEXT[axis]}>
            {axisName(axis)}
          </text>
        ))}
      </g>
    </svg>
  );
}
