import type Phaser from "phaser";
import { GEM_LAND_TICKS } from "../sim/gems";
import { PICKUP_KIND, PICKUP_LAND_TICKS, PICKUP_RADIUS_UNITS } from "../sim/pickups";
import type { World } from "../sim/world";
import { GEM_TIERS, PICKUP_LOOKS } from "./looks";
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
  /** ореол сундука по слоту подбора: сияние и столб света; создаётся по первому сундуку в слоте */
  private readonly auras: ({ glow: Phaser.GameObjects.Image; beam: Phaser.GameObjects.Image } | null)[] = [];

  constructor(scene: Phaser.Scene, world: World, layer: Phaser.GameObjects.Container) {
    this.scene = scene;
    this.world = world;
    this.layer = layer;
    this.gemSpriteTier = new Uint8Array(world.gems.alive.length).fill(NO_TIER);
    this.gemSpriteScaled = new Uint8Array(world.gems.alive.length);
    this.pickupSpriteKind = new Uint8Array(world.pickups.alive.length).fill(NO_TIER);

    const scale = world.config.unitScale;
    GEM_TIERS.forEach((tier, index) => {
      ensureShapeTexture(scene, gemTextureKey(index), tier.radiusUnits * scale, tier.color, tier.shape, { shadow: true });
    });
    for (const look of PICKUP_LOOKS) {
      ensureShapeTexture(scene, look.key, PICKUP_RADIUS_UNITS * scale * look.size, look.color, look.shape, { shadow: true });
    }
    ensureAuraTextures(scene);
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
        this.hideAura(i);
        continue;
      }

      const kind = pickups.kind[i];
      this.syncAura(i, sprite, kind, tick - pickups.bornTick[i] - PICKUP_LAND_TICKS + t, tick);
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

  /**
   * Ореол сундука: сияние под ним и столб света над ним, оба тоном яруса.
   * Сундук — главная награда, и в толпе его видно не по коробке, а по свету.
   * Слои — прямо под спрайтом сундука, поэтому сам сундук всегда поверх.
   */
  private syncAura(index: number, sprite: Phaser.GameObjects.Image, kind: number, sinceLand: number, tick: number): void {
    const tone = PICKUP_LOOKS[kind]?.aura;
    if (tone === undefined) {
      this.hideAura(index);
      return;
    }
    let aura = this.auras[index] ?? null;
    if (aura === null) {
      const glow = this.scene.add.image(0, 0, AURA_GLOW_KEY).setBlendMode(ADD_BLEND);
      const beam = this.scene.add.image(0, 0, AURA_BEAM_KEY).setBlendMode(ADD_BLEND).setOrigin(0.5, 1);
      this.layer.addAt([glow, beam], this.layer.getIndex(sprite));
      aura = { glow, beam };
      this.auras[index] = aura;
    }
    const size = PICKUP_RADIUS_UNITS * this.world.config.unitScale * (PICKUP_LOOKS[kind]?.size ?? 1);
    const state = chestAura(sinceLand, tick, index);
    aura.glow
      .setVisible(state.alpha > 0)
      .setTint(tone)
      .setAlpha(state.alpha)
      .setPosition(sprite.x, sprite.y)
      .setScale(((size * AURA_GLOW_RADIUS_MUL) / AURA_GLOW_PX) * state.glowScale);
    aura.beam
      .setVisible(state.beamAlpha > 0)
      .setTint(tone)
      .setAlpha(state.beamAlpha)
      .setPosition(sprite.x, sprite.y)
      .setScale((size * AURA_BEAM_WIDTH_MUL) / AURA_BEAM_WIDTH_PX, (size * AURA_BEAM_HEIGHT_MUL) / AURA_BEAM_HEIGHT_PX);
  }

  private hideAura(index: number): void {
    const aura = this.auras[index] ?? null;
    if (aura === null || !aura.glow.visible) return;
    aura.glow.setVisible(false);
    aura.beam.setVisible(false);
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

const NO_TIER = 255;
/** С какой ступени кристалл мерцает. */
const SHIMMER_TIER = 2;
const SHIMMER_PERIOD_TICKS = 48;
/** Высота подскока в полёте, игровые единицы. */
const GEM_HOP_UNITS = 18;
const PICKUP_HOP_UNITS = 26;
const PICKUP_PULSE_TICKS = 40;

/** Ореол сундука проявляется за треть секунды после приземления. */
export const CHEST_AURA_FADE_TICKS = 20;
/** Дыхание ореола — медленнее пульса подбора: свет, а не мигалка. */
const CHEST_AURA_PERIOD_TICKS = 84;
const AURA_GLOW_KEY = "bh-chest-aura-glow";
const AURA_BEAM_KEY = "bh-chest-aura-beam";
const AURA_GLOW_PX = 64;
const AURA_BEAM_WIDTH_PX = 32;
const AURA_BEAM_HEIGHT_PX = 128;
/** Радиус сияния и размеры столба — в радиусах сундука. */
const AURA_GLOW_RADIUS_MUL = 2.6;
const AURA_BEAM_WIDTH_MUL = 1.5;
const AURA_BEAM_HEIGHT_MUL = 7;
/** `Phaser.BlendModes.ADD`: модуль рендера импортирует Phaser только типом. */
const ADD_BLEND = 1;

export interface ChestAuraState {
  alpha: number;
  glowScale: number;
  beamAlpha: number;
}

/**
 * Ореол сундука в кадре: проявление после приземления и дыхание. Сияние
 * разгорается, когда столб гаснет, и наоборот: вместе они не слепят, а свет
 * всё время в движении. Слот сдвигает фазу — два сундука рядом не в такт.
 */
export function chestAura(sinceLand: number, tick: number, slot: number): ChestAuraState {
  const fade = Math.min(1, Math.max(0, sinceLand / CHEST_AURA_FADE_TICKS));
  const phase = (((tick + slot * 23) % CHEST_AURA_PERIOD_TICKS) + CHEST_AURA_PERIOD_TICKS) % CHEST_AURA_PERIOD_TICKS;
  const pulse = triangle(phase, CHEST_AURA_PERIOD_TICKS);
  return {
    alpha: fade * (0.45 + 0.35 * pulse),
    glowScale: 1 + 0.2 * pulse,
    beamAlpha: fade * (0.25 + 0.45 * (1 - pulse)),
  };
}

/**
 * Текстуры ореола — белые, тон даёт тинт: одна пара на все сундуки. Мягкость
 * — наложением полупрозрачных слоёв, без градиентов канвы: Graphics их не
 * умеет, а запекается это один раз.
 */
function ensureAuraTextures(scene: Phaser.Scene): void {
  if (!scene.textures.exists(AURA_GLOW_KEY)) {
    const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
    const rings = 14;
    for (let k = 0; k < rings; k++) {
      graphics.fillStyle(0xffffff, 0.075);
      graphics.fillCircle(AURA_GLOW_PX, AURA_GLOW_PX, AURA_GLOW_PX * (1 - k / rings));
    }
    graphics.generateTexture(AURA_GLOW_KEY, AURA_GLOW_PX * 2, AURA_GLOW_PX * 2);
    graphics.destroy();
  }
  if (!scene.textures.exists(AURA_BEAM_KEY)) {
    const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
    const bands = 16;
    const columns = 6;
    const band = AURA_BEAM_HEIGHT_PX / bands;
    // Снизу — ярче и шире к центру, кверху столб тает.
    for (let j = 0; j < bands; j++) {
      for (let k = 0; k < columns; k++) {
        const width = AURA_BEAM_WIDTH_PX * (1 - k / columns);
        graphics.fillStyle(0xffffff, 0.15 * (1 - j / bands));
        graphics.fillRect((AURA_BEAM_WIDTH_PX - width) / 2, AURA_BEAM_HEIGHT_PX - (j + 1) * band, width, band);
      }
    }
    graphics.generateTexture(AURA_BEAM_KEY, AURA_BEAM_WIDTH_PX, AURA_BEAM_HEIGHT_PX);
    graphics.destroy();
  }
}


function gemTextureKey(tier: number): string {
  return `bh-gem-${tier}`;
}

export function gemTier(value: number): number {
  for (let tier = GEM_TIERS.length - 1; tier > 0; tier--) {
    if (value >= GEM_TIERS[tier].minValue) return tier;
  }
  return 0;
}
