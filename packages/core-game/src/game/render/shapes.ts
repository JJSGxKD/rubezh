import type Phaser from "phaser";
import { WORLD_COLORS, type ShapeKind } from "./looks";

export type { ShapeKind } from "./looks";

export interface ShapeSpec {
  shape: ShapeKind;
  /** радиус описанной окружности — фигура вписана в квадрат 2r × 2r */
  radius: number;
  color: number;
}

/**
 * Нарисовать фигуру-плейсхолдер в Graphics для генерации текстуры. Вызывается
 * один раз на тип, не в кадре — поэтому массивы точек здесь допустимы.
 *
 * Координаты фигур заданы литералами, а не через тригонометрию: это рендер, на
 * исход забега он не влияет, но таблица читается проще формулы.
 */
export function drawShape(graphics: Phaser.GameObjects.Graphics, spec: ShapeSpec): void {
  const r = spec.radius;
  graphics.fillStyle(spec.color, 1);

  switch (spec.shape) {
    case "square":
      graphics.fillRect(r * 0.15, r * 0.15, r * 1.7, r * 1.7);
      return;
    case "triangle":
      graphics.fillTriangle(r, 0, r * 2, r * 2, 0, r * 2);
      return;
    case "diamond":
      graphics.fillPoints(points(r, DIAMOND), true);
      return;
    case "hexagon":
      graphics.fillPoints(points(r, HEXAGON), true);
      return;
    case "ring":
      graphics.lineStyle(Math.max(2, r * 0.35), spec.color, 1);
      graphics.strokeCircle(r, r, r * 0.8);
      return;
    case "wave":
      // Ударная волна: тонкий контур и бледная заливка. Рисуется крупной
      // текстурой, чтобы на радиусе взрыва в пол-экрана не превращаться в
      // растянутый пиксельный бублик.
      graphics.fillStyle(spec.color, 0.12);
      graphics.fillCircle(r, r, r * 0.95);
      graphics.lineStyle(Math.max(2, r * 0.05), spec.color, 1);
      graphics.strokeCircle(r, r, r * 0.95);
      return;
    case "medkit":
      // Светлая плашка с красным крестом: аптечку узнают по силуэту креста, а
      // не по цвету — красного на поле и так много (§4.4).
      graphics.fillStyle(MEDKIT_BODY, 1);
      graphics.fillRoundedRect(r * 0.1, r * 0.1, r * 1.8, r * 1.8, r * 0.35);
      graphics.fillStyle(spec.color, 1);
      graphics.fillRect(r * 0.78, r * 0.4, r * 0.44, r * 1.2);
      graphics.fillRect(r * 0.4, r * 0.78, r * 1.2, r * 0.44);
      return;
    case "magnet":
      // Подкова: цветная дуга и светлые полюса. Узнаётся по силуэту буквы U,
      // а не по цвету (§4.4).
      graphics.lineStyle(r * 0.5, spec.color, 1);
      graphics.beginPath();
      graphics.arc(r, r * 0.95, r * 0.6, 0, Math.PI, false);
      graphics.strokePath();
      graphics.fillStyle(spec.color, 1);
      graphics.fillRect(r * 0.15, r * 0.25, r * 0.5, r * 0.7);
      graphics.fillRect(r * 1.35, r * 0.25, r * 0.5, r * 0.7);
      graphics.fillStyle(PICKUP_LIGHT, 1);
      graphics.fillRect(r * 0.15, r * 0.1, r * 0.5, r * 0.35);
      graphics.fillRect(r * 1.35, r * 0.1, r * 0.5, r * 0.35);
      return;
    case "dynamite":
      // Шашка с фитилём и искрой: красная палка, тёмные полосы, жёлтая точка.
      graphics.fillRoundedRect(r * 0.55, r * 0.5, r * 0.9, r * 1.45, r * 0.2);
      graphics.fillStyle(DYNAMITE_BAND, 1);
      graphics.fillRect(r * 0.55, r * 0.85, r * 0.9, r * 0.15);
      graphics.fillRect(r * 0.55, r * 1.45, r * 0.9, r * 0.15);
      graphics.lineStyle(Math.max(1, r * 0.12), PICKUP_LIGHT, 1);
      graphics.lineBetween(r, r * 0.5, r * 1.3, r * 0.2);
      graphics.fillStyle(DYNAMITE_SPARK, 1);
      graphics.fillCircle(r * 1.35, r * 0.18, r * 0.2);
      return;
    case "double":
      graphics.fillCircle(r * 0.65, r * 0.75, r * 0.6);
      graphics.fillCircle(r * 1.35, r * 1.25, r * 0.6);
      return;
    default:
      graphics.fillCircle(r, r, r);
  }
}

/** Плашка аптечки: светлая, чтобы крест читался на тёмной земле. */
const MEDKIT_BODY = WORLD_COLORS.pickupLight;
/** Светлые детали подборов: полюса магнита, фитиль. */
const PICKUP_LIGHT = WORLD_COLORS.pickupLight;
const DYNAMITE_BAND = WORLD_COLORS.dynamiteBand;
const DYNAMITE_SPARK = WORLD_COLORS.dynamiteSpark;

/** Вершины в долях радиуса относительно центра фигуры. */
const DIAMOND: readonly (readonly [number, number])[] = [
  [0, -1],
  [0.75, 0],
  [0, 1],
  [-0.75, 0],
];

const HEXAGON: readonly (readonly [number, number])[] = [
  [0.5, -0.866],
  [1, 0],
  [0.5, 0.866],
  [-0.5, 0.866],
  [-1, 0],
  [-0.5, -0.866],
];

function points(radius: number, unit: readonly (readonly [number, number])[]): { x: number; y: number }[] {
  return unit.map(([x, y]) => ({ x: radius + x * radius, y: radius + y * radius }));
}
