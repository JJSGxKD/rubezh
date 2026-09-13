import type Phaser from "phaser";
import { GEM_LAND_TICKS } from "../sim/gems";
import { PICKUP_KIND, PICKUP_LAND_TICKS, PICKUP_RADIUS_UNITS } from "../sim/pickups";
import type { World } from "../sim/world";
import type { ShapeKind } from "./shapes";
import { ensureShapeTexture, lerp, popScale, triangle } from "./textures";

/**
 * Рендер того, что лежит на земле и подбирается: кристаллы опыта, аптечки,
 * магниты и динамит.
 *
 * Оба вылетают из места смерти врага дугой. Полёт рисуется по тикам симуляции
 * плюс доля до следующего шага: на паузе он замирает вместе с миром. Сам
 * предмет в симуляции с первого тика лежит в точке приземления, дуга — только
 * картинка, поэтому на исход забега она не влияет.
 */
export class PickupRenderer {
  private readonly scene: Phaser.Scene;
  private readonly world: World;
  private readonly layer: Phaser.GameObjects.Container;
  private readonly gemSprites: Phaser.GameObjects.Image[] = [];
  /** ступень ценности, под которую сейчас стоит текстура спрайта кристалла */
  private readonly gemSpriteTier: Uint8Array;
  /** спрайт кристалла сейчас не в масштабе 1 — после приземления его надо вернуть */
  private readonly gemSpriteScaled: Uint8Array;
  private readonly pickupSprites: Phaser.GameObjects.Image[] = [];
  /** вид подбора, под который сейчас стоит текстура спрайта */
  private readonly pickupSpriteKind: Uint8Array;

  constructor(scene: Phaser.Scene, world: World, layer: Phaser.GameObjects.Container) {
    this.scene = scene;
    this.world = world;
    this.layer = layer;
    this.gemSpriteTier = new Uint8Array(world.gems.alive.length).fill(NO_TIER);
    this.gemSpriteScaled = new Uint8Array(world.gems.alive.length);
    this.pickupSpriteKind = new Uint8Array(world.pickups.alive.length).fill(NO_TIER);

    const scale = world.config.unitScale;
    GEM_TIERS.forEach((tier, index) => {
      ensureShapeTexture(scene, gemTextureKey(index), tier.radiusUnits * scale, tier.color, tier.shape);
    });
    for (const look of PICKUP_LOOKS) {
      ensureShapeTexture(scene, look.key, PICKUP_RADIUS_UNITS * scale * look.size, look.color, look.shape);
    }
  }

  sync(t: number): void {
    this.syncGems(t);
    this.syncPickups(t);
  }

  private syncGems(t: number): void {
    const gems = this.world.gems;
    const tick = this.world.stats.tick;
    const hop = GEM_HOP_UNITS * this.world.config.unitScale;

    for (let i = 0; i < gems.count; i++) {
      const sprite = this.gemSprite(i);
      if (gems.alive[i] === 0) {
        if (sprite.visible) sprite.setVisible(false);
        continue;
      }

      // Ценность растёт при слиянии кристаллов, поэтому ступень проверяется
      // каждый кадр, а текстура меняется только при переходе.
      const tier = gemTier(gems.value[i]);
      if (this.gemSpriteTier[i] !== tier) {
        sprite.setTexture(gemTextureKey(tier));
        this.gemSpriteTier[i] = tier;
      }
      sprite.setVisible(true);

      // Шаг, на котором кристалл вылетел, уже прошёл: отсчёт от нуля.
      const progress = (tick - gems.bornTick[i] - 1 + t) / GEM_LAND_TICKS;
      if (progress < 1) {
        const p = progress < 0 ? 0 : progress;
        const eased = 1 - (1 - p) * (1 - p);
        sprite.setPosition(
          lerp(gems.originX[i], gems.x[i], eased),
          lerp(gems.originY[i], gems.y[i], eased) - hop * 4 * p * (1 - p),
        );
        sprite.setScale(popScale(p));
        this.gemSpriteScaled[i] = 1;
        continue;
      }

      sprite.setPosition(lerp(gems.prevX[i], gems.x[i], t), lerp(gems.prevY[i], gems.y[i], t));
      if (tier >= SHIMMER_TIER) {
        // Крупные кристаллы мерцают — их видно издалека, и за ними хочется идти.
        sprite.setScale(1 + 0.1 * triangle((tick + i * 7) % SHIMMER_PERIOD_TICKS, SHIMMER_PERIOD_TICKS));
        this.gemSpriteScaled[i] = 1;
      } else if (this.gemSpriteScaled[i] === 1) {
        sprite.setScale(1);
        this.gemSpriteScaled[i] = 0;
      }
    }
  }

  /** Подбор на земле мягко пульсирует: за ним идут, его должно быть видно издалека. */
  private syncPickups(t: number): void {
    const pickups = this.world.pickups;
    const tick = this.world.stats.tick;
    const hop = PICKUP_HOP_UNITS * this.world.config.unitScale;

    for (let i = 0; i < pickups.count; i++) {
      const sprite = this.pickupSprite(i);
      if (pickups.alive[i] === 0) {
        if (sprite.visible) sprite.setVisible(false);
        continue;
      }

      const kind = pickups.kind[i];
      if (this.pickupSpriteKind[i] !== kind) {
        sprite.setTexture(PICKUP_LOOKS[kind]?.key ?? PICKUP_LOOKS[PICKUP_KIND.medkit].key);
        this.pickupSpriteKind[i] = kind;
      }
      sprite.setVisible(true);
      const progress = (tick - pickups.bornTick[i] - 1 + t) / PICKUP_LAND_TICKS;
      if (progress < 1) {
        const p = progress < 0 ? 0 : progress;
        const eased = 1 - (1 - p) * (1 - p);
        sprite.setPosition(
          lerp(pickups.originX[i], pickups.x[i], eased),
          lerp(pickups.originY[i], pickups.y[i], eased) - hop * 4 * p * (1 - p),
        );
        sprite.setScale(popScale(p));
        continue;
      }
      sprite.setPosition(pickups.x[i], pickups.y[i]);
      sprite.setScale(1 + 0.12 * triangle((tick + i * 11) % PICKUP_PULSE_TICKS, PICKUP_PULSE_TICKS));
    }
  }

  private gemSprite(index: number): Phaser.GameObjects.Image {
    while (this.gemSprites.length <= index) {
      this.gemSprites.push(this.hiddenSprite(gemTextureKey(0)));
    }
    return this.gemSprites[index];
  }

  private pickupSprite(index: number): Phaser.GameObjects.Image {
    while (this.pickupSprites.length <= index) {
      this.pickupSprites.push(this.hiddenSprite(PICKUP_LOOKS[PICKUP_KIND.medkit].key));
    }
    return this.pickupSprites[index];
  }

  private hiddenSprite(key: string): Phaser.GameObjects.Image {
    const sprite = this.scene.add.image(0, 0, key).setVisible(false).setDepth(1);
    this.layer.add(sprite);
    return sprite;
  }
}

/**
 * Ступени ценности кристалла: цвет, размер и форма. Порог — минимальная
 * ценность ступени. Самая ценная ступень отличается ещё и формой, а не только
 * цветом (docs/27-design-system-and-app-shell.md §4.4).
 */
const GEM_TIERS: readonly { minValue: number; radiusUnits: number; color: number; shape: ShapeKind }[] = [
  { minValue: 1, radiusUnits: 5, color: 0x5ccfff, shape: "diamond" },
  { minValue: 3, radiusUnits: 6.5, color: 0x5fe3a1, shape: "diamond" },
  { minValue: 8, radiusUnits: 8, color: 0xc47dff, shape: "diamond" },
  { minValue: 20, radiusUnits: 10, color: 0xffd36b, shape: "hexagon" },
];
const NO_TIER = 255;
/** С какой ступени кристалл мерцает. */
const SHIMMER_TIER = 2;
const SHIMMER_PERIOD_TICKS = 48;
/** Высота подскока в полёте, игровые единицы. */
const GEM_HOP_UNITS = 18;
const PICKUP_HOP_UNITS = 26;
const PICKUP_PULSE_TICKS = 40;

/**
 * Как выглядит подбор каждого вида — по индексу `PICKUP_KIND`. Виды различаются
 * силуэтом: крест, подкова, шашка с фитилём (docs/27-design-system-and-app-shell.md §4.4).
 */
const PICKUP_LOOKS: readonly { key: string; shape: ShapeKind; color: number; size: number }[] = [
  { key: "bh-medkit", shape: "medkit", color: 0xff5d5d, size: 1 },
  { key: "bh-magnet-pickup", shape: "magnet", color: 0x5ccfff, size: 1.2 },
  { key: "bh-dynamite-pickup", shape: "dynamite", color: 0xff5d5d, size: 1.35 },
];

function gemTextureKey(tier: number): string {
  return `bh-gem-${tier}`;
}

export function gemTier(value: number): number {
  for (let tier = GEM_TIERS.length - 1; tier > 0; tier--) {
    if (value >= GEM_TIERS[tier].minValue) return tier;
  }
  return 0;
}
