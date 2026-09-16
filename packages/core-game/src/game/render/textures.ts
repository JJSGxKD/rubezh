import type Phaser from "phaser";
import { drawShape, type ShapeKind } from "./shapes";

/**
 * Общее для модулей рендера: генерация текстур-фигур и мелкая математика
 * анимаций. Всё здесь — рендер: на исход забега не влияет.
 */

/** Сгенерировать текстуру фигуры один раз на ключ: рисовать Graphics в кадре нельзя. */
export function ensureShapeTexture(
  scene: Phaser.Scene,
  key: string,
  radius: number,
  color: number,
  shape: ShapeKind,
  core: number | null = null,
): void {
  if (scene.textures.exists(key)) return;

  const size = Math.ceil(radius * 2);
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
  drawShape(graphics, { shape, radius, color, core });
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
