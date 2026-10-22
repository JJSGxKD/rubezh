import type Phaser from "phaser";
import type { PickupArt } from "./pickups";

/**
 * Черновой арт забега (design/art/README.md): атласы героя и врагов вместо
 * фигур. Включается только в режиме разработчика (`RunDevVisuals.sprites`) и
 * грузится по первому включению — обычный забег его не качает и не держит.
 *
 * Атласы берутся прямо из design/art/out: до одобрения направления арта
 * второй копии в пакете движка нет. Пак `core` по docs/27 §3.5 появится, когда
 * арт утвердят, — тогда этот модуль переедет на манифест паков.
 */

/** Пикселей атласа на игровую единицу — `PPU` в design/art/src/build.mjs. */
export const ART_PPU = 2.5;

/** Кадров шага у врага и героя. */
export const ART_WALK_FRAMES = 4;

/** Сколько тиков симуляции держится кадр шага — около восьми кадров в секунду. */
const TICKS_PER_FRAME = 8;

const ATLASES = [
  {
    key: "art-core",
    png: new URL("../../../../../design/art/out/atlas-core.png", import.meta.url).href,
    json: new URL("../../../../../design/art/out/atlas-core.json", import.meta.url).href,
  },
  {
    key: "art-late",
    png: new URL("../../../../../design/art/out/atlas-late.png", import.meta.url).href,
    json: new URL("../../../../../design/art/out/atlas-late.json", import.meta.url).href,
  },
] as const;

/** Где лежит кадр: ключ текстуры атласа и имя кадра. */
export interface ArtFrame {
  texture: string;
  frame: string;
}

/**
 * Номер кадра шага по тику. Слот врага сдвигает фазу: толпа, вышедшая одним
 * тиком, не шагает в ногу.
 */
export function walkFrame(tick: number, slot: number): number {
  return Math.floor((tick + slot * 7) / TICKS_PER_FRAME) % ART_WALK_FRAMES;
}

/**
 * Имя кадра врага. У элиты и босса ступеней нет — у них только `s0`, как и в
 * игре (content/stages.ts).
 */
export function enemyFrameName(id: string, stage: number, frame: number): string {
  return `${id}/s${String(stage)}/walk${String(frame)}`;
}

/**
 * Куда смотрит спрайт: по знаку скорости, но с порогом. Враг, идущий почти
 * вертикально, иначе мерцал бы отражением от каждого шевеления по x.
 */
export function faceLeft(vx: number, speed: number, wasLeft: boolean): boolean {
  const threshold = Math.max(1e-6, speed * 0.2);
  if (vx < -threshold) return true;
  if (vx > threshold) return false;
  return wasLeft;
}

export class ArtAtlas {
  private readonly scene: Phaser.Scene;
  private state: "idle" | "loading" | "ready" | "failed" = "idle";

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  get ready(): boolean {
    return this.state === "ready";
  }

  /** Начать загрузку один раз; `onReady` — когда оба атласа на месте. */
  load(onReady: () => void): void {
    if (this.state !== "idle") return;
    if (ATLASES.every((atlas) => this.scene.textures.exists(atlas.key))) {
      this.state = "ready";
      onReady();
      return;
    }
    this.state = "loading";
    for (const atlas of ATLASES) {
      if (!this.scene.textures.exists(atlas.key)) this.scene.load.atlas(atlas.key, atlas.png, atlas.json);
    }
    this.scene.load.once("complete", () => {
      // Недошедший атлас не роняет забег: режим разработчика остаётся на фигурах.
      this.state = ATLASES.every((atlas) => this.scene.textures.exists(atlas.key)) ? "ready" : "failed";
      if (this.state === "ready") onReady();
    });
    this.scene.load.start();
  }

  /** Кадр по имени из любого атласа; `null` — у врага ещё нет арта. */
  find(frame: string): ArtFrame | null {
    for (const atlas of ATLASES) {
      if (this.scene.textures.get(atlas.key).has(frame)) return { texture: atlas.key, frame };
    }
    return null;
  }
}

/** Что нужно режиму арта от мира: типы врагов, ступени и масштаб. */
export interface ArtWorld {
  config: { unitScale: number; maxEnemies: number };
  enemyTypes: readonly { id: string; rank: "normal" | "elite" | "boss" }[];
  stages: readonly unknown[];
}

/**
 * Режим чернового арта: врагу и герою — кадр атласа вместо фигуры. Всё
 * состояние режима — здесь, рендер спрашивает только «показываем ли арт у
 * этого слота» и масштаб: в выключенном режиме забег рисуется ровно как
 * без этого модуля.
 */
export class ArtMode {
  private readonly atlas: ArtAtlas;
  private readonly world: ArtWorld;
  private readonly stageCount: number;
  private wanted = false;
  private enabled = false;
  /** кадры по индексу «(тип × ступени + ступень) × кадры шага + кадр»; `null` — арта нет */
  private frames: (ArtFrame | null)[] = [];
  private heroFrames: { idle: ArtFrame[]; walk: ArtFrame[] } | null = null;
  private pickupFrames: PickupArt | null = null;
  private deathFrames: ArtFrame[] = [];
  /** показанный кадр у слота врага; −1 — слот рисуется фигурой */
  private readonly shown: Int16Array;
  private readonly left: Uint8Array;
  private heroLeft = false;
  /** масштаб кадра атласа к игровым единицам на экране */
  readonly scale: number;

  constructor(scene: Phaser.Scene, world: ArtWorld) {
    this.atlas = new ArtAtlas(scene);
    this.world = world;
    this.stageCount = world.stages.length;
    this.shown = new Int16Array(world.config.maxEnemies).fill(-1);
    this.left = new Uint8Array(world.config.maxEnemies);
    this.scale = world.config.unitScale / ART_PPU;
  }

  get on(): boolean {
    return this.enabled;
  }

  /**
   * Включить или выключить по флагу разработчика. `onChange` — режим
   * сменился: рендер сбрасывает свои кэши вида, чтобы перерисовать слоты.
   */
  setWanted(wanted: boolean, onChange: () => void): void {
    this.wanted = wanted;
    if (wanted) this.atlas.load(() => this.update(onChange));
    this.update(onChange);
  }

  private update(onChange: () => void): void {
    const on = this.wanted && this.atlas.ready;
    if (on === this.enabled) return;
    this.enabled = on;
    if (on && this.frames.length === 0) this.buildFrames();
    this.shown.fill(-1);
    onChange();
  }

  private buildFrames(): void {
    this.world.enemyTypes.forEach((type) => {
      for (let stage = 0; stage < this.stageCount; stage++) {
        for (let k = 0; k < ART_WALK_FRAMES; k++) {
          this.frames.push(this.atlas.find(enemyFrameName(type.id, type.rank === "normal" ? stage : 0, k)));
        }
      }
    });
    const hero = (state: string, count: number): ArtFrame[] =>
      Array.from({ length: count }, (_, k) => this.atlas.find(`hero/${state}${String(k)}`)).filter((frame): frame is ArtFrame => frame !== null);
    const idle = hero("idle", 2);
    const walk = hero("walk", ART_WALK_FRAMES);
    this.heroFrames = idle.length > 0 && walk.length > 0 ? { idle, walk } : null;
    // Порядок — как у GEM_TIERS и PICKUP_LOOKS в looks.ts: индекс ступени и вида подбора.
    this.pickupFrames = {
      gems: ["gem1", "gem2", "gem3", "gem4"].map((id) => this.atlas.find(`pickup/${id}/0`)),
      pickups: ["medkit", "magnet", "dynamite", "chest1", "chest3", "chest5"].map((id) => this.atlas.find(`pickup/${id}/0`)),
      scale: this.scale,
    };
    this.deathFrames = Array.from({ length: 6 }, (_, k) => this.atlas.find(`fx/death${String(k)}`)).filter((frame): frame is ArtFrame => frame !== null);
  }

  /** Кадры подборов для `PickupRenderer`; `null` — режим выключен. */
  pickupArt(): PickupArt | null {
    return this.enabled ? this.pickupFrames : null;
  }

  /** Кадры развеивания для `CombatFeedback`; `null` — режим выключен. */
  deathArt(): readonly ArtFrame[] | null {
    return this.enabled && this.deathFrames.length > 0 ? this.deathFrames : null;
  }

  /**
   * Поставить врагу кадр атласа. `false` — арта у него нет или режим
   * выключен: рендер рисует фигуру, как обычно.
   */
  applyEnemy(sprite: Phaser.GameObjects.Image, slot: number, textureIndex: number, tick: number): boolean {
    const index = this.enabled ? textureIndex * ART_WALK_FRAMES + walkFrame(tick, slot) : -1;
    const frame = index >= 0 ? (this.frames[index] ?? null) : null;
    if (frame === null) {
      if (this.shown[slot] >= 0) {
        this.shown[slot] = -1;
        sprite.setFlipX(false);
      }
      return false;
    }
    if (this.shown[slot] !== index) {
      sprite.setTexture(frame.texture, frame.frame);
      this.shown[slot] = index;
    }
    return true;
  }

  /** Показан ли у слота кадр атласа — от этого зависит масштаб спрайта. */
  shows(slot: number): boolean {
    return this.shown[slot] >= 0;
  }

  /** Отражение по ходу и глубина по `y`: нижний враг перекрывает верхнего. */
  faceEnemy(sprite: Phaser.GameObjects.Image, slot: number, vx: number, vy: number): void {
    const left = faceLeft(vx, Math.abs(vx) + Math.abs(vy), this.left[slot] === 1);
    this.left[slot] = left ? 1 : 0;
    if (sprite.flipX !== left) sprite.setFlipX(left);
    if (sprite.rotation !== 0) sprite.setRotation(0);
    sprite.depth = sprite.y;
  }

  /** Отсортировать врагов по `y` — только в режиме арта: фигурам сверху порядок не важен. */
  sortEnemies(layer: Phaser.GameObjects.Container): void {
    if (this.enabled) layer.sort("depth");
  }

  /** Кадр героя: шаг на ходу, дыхание на месте. `false` — рисуется фигура. */
  applyHero(sprite: Phaser.GameObjects.Image, tick: number, vx: number, vy: number, faceX: number): boolean {
    const frames = this.enabled ? this.heroFrames : null;
    if (frames === null) return false;
    const moving = Math.abs(vx) + Math.abs(vy) > 1e-3;
    const list = moving ? frames.walk : frames.idle;
    const frame = list[moving ? walkFrame(tick, 0) % list.length : Math.floor(tick / 40) % list.length];
    if (frame !== undefined && (sprite.texture.key !== frame.texture || sprite.frame.name !== frame.frame)) sprite.setTexture(frame.texture, frame.frame);
    this.heroLeft = faceLeft(faceX, 1, this.heroLeft);
    if (sprite.flipX !== this.heroLeft) sprite.setFlipX(this.heroLeft);
    return true;
  }
}
