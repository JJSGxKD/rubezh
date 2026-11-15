import type Phaser from "phaser";
import { ELEMENTS, type StatusElement } from "@bh/shared-types";
import { PUDDLE_POOL_SIZE } from "../sim/hazards";
import { TICK_HZ, type World } from "../sim/world";
import type { ArtFrame } from "./art-atlas";
import { ELEMENT_TONE, STATUS_TONE_COLORS } from "./status-tones";
import { ensureShapeTexture } from "./textures";

/**
 * Лужи врагов со следом на земле (`sim/hazards.ts`, T-0282): круг тоном стихии
 * врага, в режиме арта — кадры лужи атласа. Слой земли — под героем, врагами и
 * подборами. Последние 0,8 с жизни лужа гаснет.
 *
 * Лужи обязательны для чтения боя: на них нельзя стоять, и игрок должен видеть,
 * где это, — поэтому их не прячет выключатель «Телеграфы» и они не относятся к
 * эффектам оружия (docs/27-design-system-and-app-shell.md §7.1). Всё здесь — рендер:
 * на исход забега не влияет.
 */

/** Сколько тиков лужа гаснет в конце жизни: 0,8 с. */
export const PUDDLE_FADE_TICKS = Math.round(0.8 * TICK_HZ);

/** Без стихии у врага лужа — грязь, не цвет состояния: тон состояния нельзя спутать с чем-то на игроке. */
const NEUTRAL_TONE = 0x8a7a52;

/** Непрозрачность круга-фигуры: сквозь лужу видна земля, а враги и герой читаются поверх. */
const SHAPE_ALPHA = 0.4;

/** Радиус текстуры круга в игровых единицах: на экране её растягивают до радиуса лужи. */
const TEXTURE_UNITS = 32;
const TEXTURE_KEY = "bh-puddle";

/**
 * Рисунок лужи в кадре: ячейка 52 единицы при 2,5 пикселя на единицу
 * (`puddle_bog` в design/art/src/fx.mjs), пятно — эллипс 88 × 52 из ячейки 100.
 */
const ART_CELL_PX = 130;
const ART_BLOB_WIDTH_SHARE = 0.88;
/** Рисунок приплюснут (44 к 26), а круг урона круглый: по высоте кадр растягивается до круга. */
const ART_BLOB_ASPECT = 44 / 26;

/** Цвет круга: тон стихии врага, как на знаках состояний; без стихии — нейтральный. */
export function puddleTone(element: StatusElement | undefined): number {
  return element === undefined ? NEUTRAL_TONE : (STATUS_TONE_COLORS[ELEMENT_TONE[element]] ?? NEUTRAL_TONE);
}

/** Непрозрачность по остатку жизни: полная, а в последние `PUDDLE_FADE_TICKS` тиков — до нуля. */
export function puddleAlpha(ttlTicks: number): number {
  if (ttlTicks >= PUDDLE_FADE_TICKS) return 1;
  return ttlTicks <= 0 ? 0 : ttlTicks / PUDDLE_FADE_TICKS;
}

/**
 * Кадр арта: гаснущий — в последние 0,8 с, свежий — первую половину жизни,
 * подсохший — между ними.
 */
export function puddleArtFrame(ttlTicks: number, lifeTicks: number): 0 | 1 | 2 {
  if (ttlTicks <= PUDDLE_FADE_TICKS) return 2;
  return ttlTicks > lifeTicks / 2 ? 0 : 1;
}

export class Puddles {
  private readonly world: World;
  /** контейнер луж: рендер ставит его на слой земли */
  readonly container: Phaser.GameObjects.Container;
  private readonly sprites: Phaser.GameObjects.Image[] = [];
  private readonly textureRadius: number;
  private art: readonly ArtFrame[] | null = null;

  constructor(scene: Phaser.Scene, world: World, layer: Phaser.GameObjects.Container) {
    this.world = world;
    this.textureRadius = TEXTURE_UNITS * world.config.unitScale;
    // Белая текстура: цвет кладётся тоном, одна текстура на все стихии.
    ensureShapeTexture(scene, TEXTURE_KEY, this.textureRadius, 0xffffff, "circle");
    this.container = scene.add.container(0, 0);
    layer.add(this.container);
    for (let i = 0; i < PUDDLE_POOL_SIZE; i++) {
      const sprite = scene.add.image(0, 0, TEXTURE_KEY).setVisible(false);
      this.container.add(sprite);
      this.sprites.push(sprite);
    }
  }

  /** Кадры арта; `null` — рисуются круги. */
  setArt(frames: readonly ArtFrame[] | null): void {
    this.art = frames;
  }

  sync(): void {
    const pool = this.world.hazards.puddles;
    for (let i = 0; i < PUDDLE_POOL_SIZE; i++) {
      const sprite = this.sprites[i];
      if (sprite === undefined) continue;
      if (pool.alive[i] === 0) {
        if (sprite.visible) sprite.setVisible(false);
        continue;
      }
      const type = this.world.enemyTypes[pool.type[i]];
      const trail = type?.trail;
      if (type === undefined || trail === null || trail === undefined) {
        sprite.setVisible(false);
        continue;
      }
      const ttl = pool.ttl[i];
      const alpha = puddleAlpha(ttl);
      sprite.setPosition(pool.x[i], pool.y[i]).setVisible(true);

      const frame = this.art === null ? undefined : this.art[puddleArtFrame(ttl, Math.round(trail.lifeSec * TICK_HZ))];
      if (frame !== undefined) {
        const scale = (trail.radius * 2) / (ART_CELL_PX * ART_BLOB_WIDTH_SHARE);
        sprite.setTexture(frame.texture, frame.frame).clearTint().setScale(scale, scale * ART_BLOB_ASPECT).setAlpha(alpha);
        continue;
      }
      const element: StatusElement | undefined = type.element === 0 ? undefined : (ELEMENTS[type.element] as StatusElement);
      sprite
        .setTexture(TEXTURE_KEY)
        .setTint(puddleTone(element))
        .setScale(trail.radius / this.textureRadius)
        .setAlpha(SHAPE_ALPHA * alpha);
    }
  }
}
