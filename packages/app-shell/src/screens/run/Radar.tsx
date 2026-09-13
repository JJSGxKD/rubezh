import { memo, useLayoutEffect, useRef, type ReactNode } from "react";
import type { RadarSnapshot } from "@bh/core-game";
import { COLORS } from "../../design-system/tokens";
import { t } from "../../i18n";

/**
 * Радар забега: враги, элиты и подборы вокруг игрока в пределах кольца спавна
 * (docs/27-design-system-and-app-shell.md §3.2).
 *
 * Рисуется на своей маленькой канве, а не разметкой: сотня точек элементами
 * DOM — сотня узлов, которые React сравнивает десять раз в секунду. Канва
 * перерисовывается только с новым снимком HUD, то есть не чаще 10 Гц, и под
 * живой канвой мира не анимирует ничего (§3.3).
 *
 * Цвета — из токенов: оболочка рисует их сама, движок о палитре интерфейса не
 * знает.
 */
const SIZE_PX = 88;
const BLIP_PX = 2.5;
const ELITE_PX = 4.5;
const MEDKIT_PX = 4;

/** Виды точек — те же числа, что кладёт движок (`RadarBlipKind`). */
const KIND_ELITE = 1;
const KIND_MEDKIT = 2;

export const Radar = memo(function Radar(props: { radar: RadarSnapshot }): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas === null || context === null || context === undefined) return;

    const ratio = globalThis.devicePixelRatio ?? 1;
    const size = Math.round(SIZE_PX * ratio);
    if (canvas.width !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    draw(context, props.radar, size, ratio);
  }, [props.radar]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={t("run.radar")}
      className="block rounded-full"
      style={{ width: SIZE_PX, height: SIZE_PX }}
    />
  );
});

function draw(context: CanvasRenderingContext2D, radar: RadarSnapshot, size: number, ratio: number): void {
  const center = size / 2;
  const radius = center - ratio;
  context.clearRect(0, 0, size, size);

  // Подложка и два кольца дистанции: где край экрана примерно, а где — спавн.
  context.fillStyle = withAlpha(COLORS.bg, 0.72);
  context.beginPath();
  context.arc(center, center, radius, 0, Math.PI * 2);
  context.fill();
  context.lineWidth = ratio;
  context.strokeStyle = withAlpha(COLORS.borderStrong, 0.9);
  context.stroke();
  context.strokeStyle = withAlpha(COLORS.border, 0.9);
  context.beginPath();
  context.arc(center, center, radius * 0.5, 0, Math.PI * 2);
  context.stroke();

  const blips = radar.blips;
  context.fillStyle = COLORS.danger;
  for (let i = 0; i < radar.count; i++) {
    if (blips[i * 3 + 2] !== 0) continue;
    dot(context, center + blips[i * 3] * radius, center + blips[i * 3 + 1] * radius, BLIP_PX * ratio);
  }

  // Элиты и подборы — поверх роя и крупнее: их важно заметить первыми.
  for (let i = 0; i < radar.count; i++) {
    const kind = blips[i * 3 + 2];
    const x = center + blips[i * 3] * radius;
    const y = center + blips[i * 3 + 1] * radius;
    if (kind === KIND_ELITE) {
      context.fillStyle = COLORS.elite;
      dot(context, x, y, ELITE_PX * ratio);
    } else if (kind === KIND_MEDKIT) {
      context.fillStyle = COLORS.hp;
      cross(context, x, y, MEDKIT_PX * ratio);
    }
  }

  // Игрок — в центре, светлый: радар всегда относительно него.
  context.fillStyle = COLORS.text;
  dot(context, center, center, 3 * ratio);
}

function dot(context: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
}

/** Подбор — крестом, а не только зелёным цветом (§4.4). */
function cross(context: CanvasRenderingContext2D, x: number, y: number, half: number): void {
  const bar = half * 0.7;
  context.fillRect(x - half, y - bar / 2, half * 2, bar);
  context.fillRect(x - bar / 2, y - half, bar, half * 2);
}

function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${alpha})`;
}
