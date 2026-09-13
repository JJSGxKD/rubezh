import type Phaser from "phaser";
import type { World } from "../sim/world";
import { ensureShapeTexture } from "./textures";

/**
 * Телеграфы угроз: что враг сделает в следующую секунду.
 *
 * - кольцо — радиус будущего взрыва, пока горит фитиль подрывника: без него
 *   игрок узнаёт границу поражения только по своему здоровью;
 * - полоса — направление будущего рывка, пока враг мигает: направление
 *   зафиксировано в начале телеграфа, и игрок успевает уйти вбок.
 *
 * Пульсация идёт по тикам симуляции: на паузе телеграф замирает вместе с миром.
 * Спрайты раздаются заново каждый кадр: `begin`, по вызову на угрозу, `end`.
 */
export class Telegraphs {
  private readonly scene: Phaser.Scene;
  private readonly world: World;
  private readonly layer: Phaser.GameObjects.Container;
  private readonly rings: Phaser.GameObjects.Image[] = [];
  private readonly lanes: Phaser.GameObjects.Image[] = [];
  private ringsUsed = 0;
  private lanesUsed = 0;

  constructor(scene: Phaser.Scene, world: World, layer: Phaser.GameObjects.Container) {
    this.scene = scene;
    this.world = world;
    this.layer = layer;

    const scale = world.config.unitScale;
    ensureShapeTexture(scene, RING_KEY, RING_TEXTURE_UNITS * scale, 0xff5a5a, "ring");
    this.ensureLaneTexture(scale);
  }

  begin(): void {
    this.ringsUsed = 0;
    this.lanesUsed = 0;
  }

  ring(x: number, y: number, radius: number, tick: number): void {
    const sprite = this.take(this.rings, this.ringsUsed++, RING_KEY, 0.5);
    const textureRadius = RING_TEXTURE_UNITS * this.world.config.unitScale;
    const pulse = 0.94 + 0.06 * ((tick >> 2) % 2);
    sprite.setPosition(x, y);
    sprite.setScale((radius / textureRadius) * pulse);
    sprite.setAlpha(0.55);
    sprite.setVisible(true);
  }

  /**
   * Поворот через `Math.atan2` здесь допустим: это рендер, а запрет на
   * приближённую математику касается симуляции (CLAUDE.md, «Детерминизм»).
   */
  lane(x: number, y: number, dirX: number, dirY: number, length: number, tick: number): void {
    const sprite = this.take(this.lanes, this.lanesUsed++, LANE_KEY, 0);
    const textureLength = LANE_TEXTURE_UNITS * this.world.config.unitScale;
    sprite.setPosition(x, y);
    sprite.setRotation(Math.atan2(dirY, dirX));
    sprite.setScale(length / textureLength, 1);
    sprite.setAlpha(0.3 + 0.2 * ((tick >> 3) % 2));
    sprite.setVisible(true);
  }

  end(): void {
    hideFrom(this.rings, this.ringsUsed);
    hideFrom(this.lanes, this.lanesUsed);
  }

  private take(
    pool: Phaser.GameObjects.Image[],
    index: number,
    key: string,
    originX: number,
  ): Phaser.GameObjects.Image {
    while (pool.length <= index) {
      const sprite = this.scene.add.image(0, 0, key).setOrigin(originX, 0.5).setDepth(0).setVisible(false);
      this.layer.add(sprite);
      pool.push(sprite);
    }
    return pool[index];
  }

  /** Полоса светлее к началу и гаснет к концу — видно, откуда и куда. */
  private ensureLaneTexture(scale: number): void {
    if (this.scene.textures.exists(LANE_KEY)) return;
    const length = Math.ceil(LANE_TEXTURE_UNITS * scale);
    const width = Math.max(2, Math.ceil(LANE_WIDTH_UNITS * scale));
    const graphics = this.scene.make.graphics({ x: 0, y: 0 }, false);
    const steps = 8;
    for (let s = 0; s < steps; s++) {
      graphics.fillStyle(0xffd36b, 1 - s / steps);
      graphics.fillRect((length * s) / steps, 0, length / steps + 1, width);
    }
    graphics.generateTexture(LANE_KEY, length, width);
    graphics.destroy();
  }
}

function hideFrom(pool: readonly Phaser.GameObjects.Image[], from: number): void {
  for (let k = from; k < pool.length; k++) {
    if (pool[k].visible) pool[k].setVisible(false);
  }
}

const RING_KEY = "bh-telegraph";
const RING_TEXTURE_UNITS = 32;
const LANE_KEY = "bh-dash-lane";
/** Длина текстуры полосы рывка; на экране она растягивается до длины рывка. */
const LANE_TEXTURE_UNITS = 64;
const LANE_WIDTH_UNITS = 10;
