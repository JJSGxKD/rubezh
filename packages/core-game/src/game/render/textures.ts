import type Phaser from "phaser";
import { shadowLayout } from "./shadow-layout";
import { drawShape, type ShapeKind } from "./shapes";

/**
 * Общее для модулей рендера: генерация текстур-фигур и мелкая математика
 * анимаций. Всё здесь — рендер: на исход забега не влияет.
 */

/** Тень под телом — мягкая, не чёрная: мир средней светлоты, а чёрное пятно читалось бы дырой. */
const SHADOW_ALPHA = 0.35;

export interface ShapeTextureOptions {
  /** светлое ядро ступени врага */
  core?: number | null;
  /** запечь тень под телом: текстура получает поле, тело остаётся в центре */
  shadow?: boolean;
  /** кайма по контуру; толщина в пикселях */
  rim?: { color: number; width: number } | null;
}

/**
 * Сгенерировать текстуру фигуры один раз на ключ: рисовать Graphics в кадре
 * нельзя. С тенью текстура шире тела, но тело рисуется тем же радиусом и стоит
 * в центре: при масштабе спрайта 1 оно на экране прежнего размера.
 */
export function ensureShapeTexture(
  scene: Phaser.Scene,
  key: string,
  radius: number,
  color: number,
  shape: ShapeKind,
  options: ShapeTextureOptions = {},
): void {
  if (scene.textures.exists(key)) return;

  const layout = options.shadow === true ? shadowLayout(radius) : null;
  const size = layout?.size ?? Math.ceil(radius * 2);

  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
  if (layout !== null) {
    graphics.fillStyle(0x000000, SHADOW_ALPHA);
    graphics.fillEllipse(layout.shadowX, layout.shadowY, layout.shadowRx * 2, layout.shadowRy * 2);
  }
  drawShape(graphics, {
    shape,
    radius,
    color,
    core: options.core ?? null,
    rim: options.rim ?? null,
    offset: layout === null ? 0 : layout.bodyX - radius,
  });
  graphics.generateTexture(key, size, size);
  graphics.destroy();
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** Треугольная волна 0 → 1 → 0 за период. */
export function triangle(phase: number, period: number): number {
  const half = period / 2;
  return phase < half ? phase / half : (period - phase) / half;
}

/**
 * Масштаб выпадающего предмета в полёте: выскакивает маленьким, на трети пути
 * чуть больше себя и оседает к обычному размеру — «пружина» без тригонометрии.
 */
export function popScale(progress: number): number {
  if (progress < 0.35) return 0.35 + (progress / 0.35) * 0.9;
  return 1.25 - ((progress - 0.35) / 0.65) * 0.25;
}
