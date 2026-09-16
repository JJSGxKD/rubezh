import type Phaser from "phaser";
import { WORLD_COLORS, type ShapeKind } from "./looks";

export type { ShapeKind } from "./looks";

export interface ShapeSpec {
  shape: ShapeKind;
  /** радиус описанной окружности — фигура вписана в квадрат 2r × 2r */
  radius: number;
  color: number;
  /** светлое ядро поверх фигуры: так читается ступень врага */
  core?: number | null;
}

/**
 * Нарисовать фигуру-плейсхолдер в Graphics для генерации текстуры. Вызывается
 * один раз на тип, не в кадре — поэтому массивы точек здесь допустимы.
 *
 * Координаты фигур заданы литералами, а не через тригонометрию: это рендер, на
 * исход забега он не влияет, но таблица читается проще формулы.
 */
export function drawShape(graphics: Phaser.GameObjects.Graphics, spec: ShapeSpec): void {
  drawBody(graphics, spec);
  const core = spec.core;
  if (core === undefined || core === null) return;

  // Ядро — круг в середине фигуры: одинаково садится и на круг, и на клин, и
  // остаётся видимым, когда враг размером в полпальца.
  graphics.fillStyle(core, 1);
  graphics.fillCircle(spec.radius, spec.radius, spec.radius * CORE_RATIO);
}

/** Доля радиуса, которую занимает ядро ступени. */
const CORE_RATIO = 0.34;

function drawBody(graphics: Phaser.GameObjects.Graphics, spec: ShapeSpec): void {
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
    case "chevron":
      // Остриё вперёд: рывковый враг читается как летящий на игрока клин, а
      // не как подбираемый ромб.
      graphics.fillPoints(points(r, CHEVRON), true);
      return;
    case "gem":
      drawGem(graphics, spec, false);
      return;
    case "gem_rich":
      drawGem(graphics, spec, true);
      return;
    case "bolt":
      // Снаряд врага: тёмный ореол, цветное тело и почти белое ядро. Раньше
      // это был ровный красный кружок, и его путали с мелким врагом.
      graphics.fillStyle(spec.color, 0.25);
      graphics.fillCircle(r, r, r);
      graphics.fillStyle(spec.color, 1);
      graphics.fillCircle(r, r, r * 0.68);
      graphics.fillStyle(WORLD_COLORS.enemyProjectileCore, 1);
      graphics.fillCircle(r, r, r * 0.3);
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

/**
 * Кристалл опыта: гранёное тело, светлая верхняя грань и тёмная нижняя —
 * камень, а не плоский ромб. У ценного добавляется искра в центре.
 */
function drawGem(graphics: Phaser.GameObjects.Graphics, spec: ShapeSpec, rich: boolean): void {
  const r = spec.radius;
  graphics.fillStyle(spec.color, 1);
  graphics.fillPoints(points(r, GEM_BODY), true);
  graphics.fillStyle(WORLD_COLORS.gemLight, 0.55);
  graphics.fillPoints(points(r, GEM_TOP_FACET), true);
  graphics.fillStyle(0x000000, 0.22);
  graphics.fillPoints(points(r, GEM_BOTTOM_FACET), true);
  graphics.lineStyle(Math.max(1, r * 0.12), WORLD_COLORS.gemLight, rich ? 0.85 : 0.5);
  graphics.strokePoints(points(r, GEM_BODY), true, true);
  if (!rich) return;
  graphics.fillStyle(WORLD_COLORS.gemLight, 0.9);
  graphics.fillPoints(points(r * 0.42, GEM_BODY).map((point) => ({ x: point.x + r * 0.58, y: point.y + r * 0.58 })), true);
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

/** Клин остриём вверх: вершина, широкие плечи и вырез сзади. */
const CHEVRON: readonly (readonly [number, number])[] = [
  [0, -1],
  [0.85, 0.75],
  [0, 0.25],
  [-0.85, 0.75],
];

/** Восьмигранник кристалла: срезанная верхушка и острый низ. */
const GEM_BODY: readonly (readonly [number, number])[] = [
  [-0.36, -0.62],
  [0.36, -0.62],
  [0.78, -0.1],
  [0, 1],
  [-0.78, -0.1],
];

/** Верхняя грань — блик. */
const GEM_TOP_FACET: readonly (readonly [number, number])[] = [
  [-0.36, -0.62],
  [0.36, -0.62],
  [0.2, -0.24],
  [-0.2, -0.24],
];

/** Нижняя грань — тень, от неё камень выглядит гранёным. */
const GEM_BOTTOM_FACET: readonly (readonly [number, number])[] = [
  [0.2, -0.24],
  [0.78, -0.1],
  [0, 1],
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
