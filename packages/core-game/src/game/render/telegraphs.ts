import type Phaser from "phaser";
import type { World } from "../sim/world";
import { WORLD_COLORS } from "./looks";
import { ensureShapeTexture } from "./textures";

/**
 * Телеграфы угроз: что враг сделает и **через сколько**.
 *
 * Каждый телеграф показывает сразу и зону, и отсчёт:
 *
 * - подрывник — кольцо полного радиуса взрыва появляется сразу, а внутри к
 *   нему растёт второе кольцо с заливкой. Сомкнулись — взрыв. Без отсчёта
 *   игрок видел, где рванёт, но не знал, успеет ли выйти;
 * - рывок — полоса во всю длину, по ней от врага заполняется яркая часть.
 *   Дошла до конца — враг сорвался. Направление зафиксировано в начале
 *   телеграфа, поэтому шаг вбок спасает;
 * - стрелок — перед выстрелом тонкая линия прицела к игроку заполняется от
 *   стрелка. Заполнилась — снаряд вылетел.
 *
 * Прогресс считается из таймеров фазы в мире: рендер их только читает, и на
 * исход забега телеграф не влияет. На паузе он замирает вместе с миром.
 * Спрайты раздаются заново каждый кадр: `begin`, по вызову на угрозу, `end`.
 */
export class Telegraphs {
  private readonly scene: Phaser.Scene;
  private readonly world: World;
  private readonly layer: Phaser.GameObjects.Container;
  private readonly pools = new Map<string, { sprites: Phaser.GameObjects.Image[]; used: number }>();

  constructor(scene: Phaser.Scene, world: World, layer: Phaser.GameObjects.Container) {
    this.scene = scene;
    this.world = world;
    this.layer = layer;

    const scale = world.config.unitScale;
    ensureShapeTexture(scene, RING_KEY, RING_TEXTURE_UNITS * scale, WORLD_COLORS.threat, "ring");
    ensureShapeTexture(scene, FILL_KEY, RING_TEXTURE_UNITS * scale, WORLD_COLORS.threat, "circle");
    this.ensureBarTexture(LANE_KEY, LANE_WIDTH_UNITS * scale, WORLD_COLORS.dashLane);
    this.ensureBarTexture(AIM_KEY, AIM_WIDTH_UNITS * scale, WORLD_COLORS.enemyProjectile);
  }

  begin(): void {
    for (const pool of this.pools.values()) pool.used = 0;
  }

  /** Взрыв: `progress` от 0 в начале фитиля до 1 в момент взрыва. */
  ring(x: number, y: number, radius: number, progress: number): void {
    const textureRadius = RING_TEXTURE_UNITS * this.world.config.unitScale;
    const p = clamp01(progress);

    const outer = this.take(RING_KEY, 0.5);
    outer.setPosition(x, y).setScale(radius / textureRadius).setAlpha(0.45);

    const fill = this.take(FILL_KEY, 0.5);
    fill.setPosition(x, y).setScale(Math.max(0.001, (radius * p) / textureRadius)).setAlpha(0.14 + 0.16 * p);

    const inner = this.take(RING_KEY, 0.5);
    inner.setPosition(x, y).setScale(Math.max(0.001, (radius * p) / textureRadius)).setAlpha(0.6 + 0.4 * p);
  }

  /**
   * Рывок: полоса на всю длину и заполнение от врага.
   * Поворот через `Math.atan2` допустим: это рендер, а запрет на приближённую
   * математику касается симуляции (CLAUDE.md, «Детерминизм»).
   */
  lane(x: number, y: number, dirX: number, dirY: number, length: number, progress: number): void {
    const rotation = Math.atan2(dirY, dirX);
    const textureLength = BAR_TEXTURE_UNITS * this.world.config.unitScale;
    const p = clamp01(progress);

    const track = this.take(LANE_KEY, 0);
    track.setPosition(x, y).setRotation(rotation).setScale(length / textureLength, 1).setAlpha(0.22);

    const fill = this.take(LANE_KEY, 0);
    fill.setPosition(x, y).setRotation(rotation).setScale(Math.max(0.001, (length * p) / textureLength), 1).setAlpha(0.7);
  }

  /** Прицел стрелка: линия к игроку, заполняется к выстрелу. */
  aim(x: number, y: number, targetX: number, targetY: number, progress: number): void {
    const dx = targetX - x;
    const dy = targetY - y;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length < 1) return;
    const rotation = Math.atan2(dy, dx);
    const textureLength = BAR_TEXTURE_UNITS * this.world.config.unitScale;
    const p = clamp01(progress);

    const track = this.take(AIM_KEY, 0);
    track.setPosition(x, y).setRotation(rotation).setScale(length / textureLength, 1).setAlpha(0.12 + 0.1 * p);

    const fill = this.take(AIM_KEY, 0);
    fill.setPosition(x, y).setRotation(rotation).setScale(Math.max(0.001, (length * p) / textureLength), 1).setAlpha(0.55);
  }

  end(): void {
    for (const pool of this.pools.values()) {
      for (let k = pool.used; k < pool.sprites.length; k++) {
        if (pool.sprites[k].visible) pool.sprites[k].setVisible(false);
      }
    }
  }

  private take(key: string, originX: number): Phaser.GameObjects.Image {
    let pool = this.pools.get(key);
    if (pool === undefined) {
      pool = { sprites: [], used: 0 };
      this.pools.set(key, pool);
    }
    while (pool.sprites.length <= pool.used) {
      const sprite = this.scene.add.image(0, 0, key).setDepth(0).setVisible(false);
      this.layer.add(sprite);
      pool.sprites.push(sprite);
    }
    const sprite = pool.sprites[pool.used++];
    sprite.setOrigin(originX, 0.5).setRotation(0).setVisible(true);
    return sprite;
  }

  /** Полоса светлее к началу и гаснет к концу — видно, откуда и куда. */
  private ensureBarTexture(key: string, width: number, color: number): void {
    if (this.scene.textures.exists(key)) return;
    const length = Math.ceil(BAR_TEXTURE_UNITS * this.world.config.unitScale);
    const height = Math.max(2, Math.ceil(width));
    const graphics = this.scene.make.graphics({ x: 0, y: 0 }, false);
    const steps = 8;
    for (let s = 0; s < steps; s++) {
      graphics.fillStyle(color, 1 - (0.6 * s) / steps);
      graphics.fillRect((length * s) / steps, 0, length / steps + 1, height);
    }
    graphics.generateTexture(key, length, height);
    graphics.destroy();
  }
}

/** Сколько секунд до выстрела стрелок показывает прицел. */
export const AIM_TELEGRAPH_SEC = 0.5;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

const RING_KEY = "bh-telegraph";
const FILL_KEY = "bh-telegraph-fill";
const RING_TEXTURE_UNITS = 32;
const LANE_KEY = "bh-dash-lane";
const AIM_KEY = "bh-aim-line";
/** Длина текстуры полос; на экране они растягиваются до нужной длины. */
const BAR_TEXTURE_UNITS = 64;
const LANE_WIDTH_UNITS = 10;
const AIM_WIDTH_UNITS = 3;
