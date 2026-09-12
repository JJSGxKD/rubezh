import type { MapCameraDef } from "@bh/shared-types";
import type { World } from "../sim/world";

/**
 * Динамическая камера забега (docs/26-stage2-plan.md, WP4.3).
 *
 * **Камера — только рендер.** Симуляция о масштабе не знает: от параметров
 * камеры она берёт единственное число — радиус кольца спавна, и берёт его от
 * максимально возможной видимой области, одинаковой на всех устройствах.
 * Поэтому здесь разрешён `Math.exp`: на исход забега он не влияет, а запрет
 * приближённой математики защищает воспроизводимость симуляции, а не
 * плавность картинки (WP4.5).
 *
 * Видимая область нормализуется **по площади** с ограничением соотношения
 * сторон (решение Р14): портрет и ландшафт видят одинаковый объём мира разной
 * формы, и вытянутый экран не даёт преимущества.
 */
export class RunCamera {
  private readonly params: MapCameraDef;
  private readonly unitScale: number;
  private centerX = 0;
  private centerY = 0;
  private currentZoom = 1;
  /** сколько игрок уже стоит: приближение ждёт, отдаление — нет */
  private idleSec = 0;
  private viewportWidth = 1;
  private viewportHeight = 1;

  constructor(params: MapCameraDef, unitScale: number) {
    this.params = params;
    this.unitScale = unitScale;
  }

  get x(): number {
    return this.centerX;
  }

  get y(): number {
    return this.centerY;
  }

  get zoom(): number {
    return this.currentZoom;
  }

  /** Поставить камеру на игрока без перехода: старт забега и смена размера. */
  snapTo(world: World, viewportWidth: number, viewportHeight: number): void {
    this.resize(viewportWidth, viewportHeight);
    this.idleSec = 0;
    this.currentZoom = this.zoomForArea(this.params.viewAreaMoving);
    this.centerX = world.player.x;
    this.centerY = world.player.y;
    this.clampToBounds(world);
  }

  resize(viewportWidth: number, viewportHeight: number): void {
    this.viewportWidth = Math.max(1, viewportWidth);
    this.viewportHeight = Math.max(1, viewportHeight);
  }

  /**
   * Шаг камеры. `dtSec` — реальное время кадра, а не шаг симуляции: камера
   * живёт в кадрах и на паузе просто не двигается.
   */
  update(world: World, dtSec: number): void {
    const player = world.player;
    const speed = Math.sqrt(player.vx * player.vx + player.vy * player.vy);
    const idleThreshold = world.config.player.speedPxSec * IDLE_SPEED_RATIO;

    if (speed > idleThreshold) this.idleSec = 0;
    else this.idleSec += dtSec;

    // Приближение — с задержкой: короткая остановка при уклонении не должна
    // дёргать камеру. Отдаление мгновенное: игроку нужно видеть, куда он бежит,
    // ровно в тот момент, когда он туда побежал.
    const idle = this.idleSec >= this.params.zoomInDelaySec;
    const targetZoom = this.zoomForArea(
      idle ? this.params.viewAreaIdle : this.params.viewAreaMoving,
    );

    this.currentZoom = smooth(this.currentZoom, targetZoom, dtSec, this.params.zoomSmoothingSec);
    this.centerX = smooth(this.centerX, player.x, dtSec, this.params.followSmoothingSec);
    this.centerY = smooth(this.centerY, player.y, dtSec, this.params.followSmoothingSec);
    this.clampToBounds(world);
  }

  /**
   * Масштаб, при котором видно заданную площадь мира.
   *
   * Из двух ограничений берётся более строгое: нормализация по площади и
   * потолок соотношения сторон. Экран вытянутее предела видит меньше площади —
   * иначе ландшафт на телефоне и широкое окно на десктопе смотрели бы вдаль
   * там, где портрет видит стену врагов.
   */
  private zoomForArea(areaUnits: number): number {
    const area = Math.max(1, areaUnits);
    const pixelsPerUnit = this.unitScale;
    const byArea =
      Math.sqrt(this.viewportWidth * this.viewportHeight) /
      (Math.sqrt(area) * pixelsPerUnit);

    const longSide = Math.max(this.viewportWidth, this.viewportHeight);
    const maxLongSideUnits = Math.sqrt(area * Math.max(1, this.params.maxAspect));
    const byAspect = longSide / (maxLongSideUnits * pixelsPerUnit);

    return Math.max(byArea, byAspect);
  }

  /**
   * Не показывать пустоту за стеной карты. У бесконечной карты обе границы —
   * `Infinity`, и клампа не происходит вовсе.
   */
  private clampToBounds(world: World): void {
    const bounds = world.config.bounds;
    const halfViewX = this.viewportWidth / (2 * this.currentZoom);
    const halfViewY = this.viewportHeight / (2 * this.currentZoom);

    this.centerX = clampAxis(this.centerX, bounds.halfWidth, halfViewX);
    this.centerY = clampAxis(this.centerY, bounds.halfHeight, halfViewY);
  }
}

/** Ниже этой доли полной скорости игрок считается стоящим. */
const IDLE_SPEED_RATIO = 0.15;

/**
 * Экспоненциальное сглаживание с постоянной времени: результат не зависит от
 * частоты кадров. Наивное `value += (target - value) * k` с постоянным `k`
 * даёт на 120 Гц вдвое более быструю камеру, чем на 60.
 */
function smooth(value: number, target: number, dtSec: number, tauSec: number): number {
  if (tauSec <= 0 || dtSec <= 0) return target;
  return value + (target - value) * (1 - Math.exp(-dtSec / tauSec));
}

/**
 * Карта уже видимой области — центрируем: показывать половину стены и
 * половину пустоты хуже, чем честно показать всю узкую карту.
 */
function clampAxis(value: number, halfExtent: number, halfView: number): number {
  if (!Number.isFinite(halfExtent)) return value;
  if (halfView >= halfExtent) return 0;
  const limit = halfExtent - halfView;
  return value < -limit ? -limit : value > limit ? limit : value;
}
