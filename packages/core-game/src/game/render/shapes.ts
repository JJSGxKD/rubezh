import type Phaser from "phaser";

export type ShapeKind = "circle" | "square" | "triangle" | "diamond" | "ring" | "hexagon" | "double";

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
      fillPolygon(graphics, r, DIAMOND);
      return;
    case "hexagon":
      fillPolygon(graphics, r, HEXAGON);
      return;
    case "ring":
      graphics.lineStyle(Math.max(2, r * 0.35), spec.color, 1);
      graphics.strokeCircle(r, r, r * 0.8);
      return;
    case "double":
      graphics.fillCircle(r * 0.65, r * 0.75, r * 0.6);
      graphics.fillCircle(r * 1.35, r * 1.25, r * 0.6);
      return;
    default:
      graphics.fillCircle(r, r, r);
  }
}

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

/**
 * Многоугольник путём, а не `fillPoints`: в Phaser 4 тот принимает только
 * экземпляры `Vector2`, а путь строится из чисел — без объектов-посредников и
 * без импорта Phaser как значения в этот модуль.
 */
function fillPolygon(
  graphics: Phaser.GameObjects.Graphics,
  radius: number,
  unit: readonly (readonly [number, number])[],
): void {
  graphics.beginPath();
  unit.forEach(([x, y], index) => {
    const px = radius + x * radius;
    const py = radius + y * radius;
    if (index === 0) graphics.moveTo(px, py);
    else graphics.lineTo(px, py);
  });
  graphics.closePath();
  graphics.fillPath();
}
