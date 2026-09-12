import Phaser from "phaser";
import type { EnemyPattern } from "@bh/shared-types";
import type { World } from "../sim/world";
import { SIM_EVENT } from "../sim/events";
import { DASH_PHASE, EXPLODER_PHASE } from "../patterns";
import { orbiterCount, orbiterPosition, type OrbiterPoint } from "../weapons";
import { drawShape, type ShapeKind } from "./shapes";

const orbiterScratch: OrbiterPoint = { x: 0, y: 0 };

/**
 * Рендер состояния симуляции. Отделён от неё полностью: симуляция не знает,
 * что её кто-то рисует, и потому запускается headless
 * (docs/17-testing-strategy.md §3.0).
 *
 * Спрайты переиспользуются и никогда не уничтожаются: создание и уничтожение
 * объектов Phaser в кадре — источник пауз сборщика мусора, а именно они портят
 * p99 времени кадра на бюджетном Android.
 *
 * Создаются они при этом по мере надобности, а не сразу по ёмкости пулов.
 * Phaser обходит весь список отображения каждый кадр, включая невидимые
 * объекты; в агрессивном прогоне ёмкость — тысячи, и предсоздание отдало бы
 * заметную часть кадра на обход спрайтов, которых на экране нет.
 *
 * Формы генерируются в текстуры один раз. Рисовать врагов через Graphics
 * каждый кадр нельзя: это отдельный вызов отрисовки на врага вместо одного
 * батча на всех.
 */
export class WorldRenderer {
  private readonly scene: Phaser.Scene;
  private readonly world: World;
  /**
   * Слой мира. Камера забега — это трансформация слоя, а не камера Phaser:
   * HUD и экраны живут в том же дереве сцены и обязаны остаться в экранных
   * координатах, не масштабируясь вместе с миром. Вторая камера Phaser
   * потребовала бы вести список игнорирования для каждого создаваемого на ходу
   * спрайта — легко забыть, и промах виден только на устройстве.
   */
  private readonly layer: Phaser.GameObjects.Container;
  /** повторяющийся фон: единственное, что даёт почувствовать движение мира */
  private readonly ground: Phaser.GameObjects.TileSprite;
  private readonly enemySprites: Phaser.GameObjects.Image[] = [];
  private readonly enemySpriteType: Int16Array;
  /** последний применённый вид спрайта — чтобы не дёргать Phaser каждый кадр */
  private readonly enemySpriteLook: Uint8Array;
  private readonly projectileSprites: Phaser.GameObjects.Image[] = [];
  private readonly player: Phaser.GameObjects.Image;
  private readonly textureKeyByType: string[] = [];
  private readonly gemSprites: Phaser.GameObjects.Image[] = [];
  private readonly orbiterSprites: Phaser.GameObjects.Image[] = [];
  private readonly blasts: Phaser.GameObjects.Image[] = [];
  private readonly blastStartTick: Int32Array = new Int32Array(MAX_BLASTS).fill(-1);
  private readonly blastRadius: Float32Array = new Float32Array(MAX_BLASTS);
  private readonly blastKind: Uint8Array = new Uint8Array(MAX_BLASTS);
  private eventsRead = 0;
  private nextBlast = 0;

  constructor(scene: Phaser.Scene, world: World) {
    this.scene = scene;
    this.world = world;
    this.enemySpriteType = new Int16Array(world.config.maxEnemies).fill(-1);
    this.enemySpriteLook = new Uint8Array(world.config.maxEnemies);

    for (const type of world.enemyTypes) {
      const key = `bh-enemy-${type.id}`;
      const look = LOOK_BY_PATTERN[type.pattern];
      // Элита крупнее и светлее: одинаковые на глаз танк и элитный танк
      // читаются как дефект, а не как контрольная точка сложности.
      this.ensureTexture(key, type.radius, type.elite ? brighten(look.color) : look.color, look.shape);
      this.textureKeyByType.push(key);
    }

    const scale = world.config.unitScale;
    this.ensureGroundTexture(scale);
    this.ground = scene.add
      .tileSprite(0, 0, scene.scale.width, scene.scale.height, "bh-ground")
      .setOrigin(0, 0)
      .setDepth(-10);
    this.layer = scene.add.container(0, 0).setDepth(0);
    this.ensureTexture("bh-player", world.config.player.radius, 0x6ee7a8, "circle");
    this.ensureTexture("bh-projectile", world.config.player.projectileRadius, 0xffe066, "circle");
    this.ensureTexture("bh-projectile-enemy", world.config.player.projectileRadius, 0xff6b6b, "circle");
    this.ensureTexture("bh-blast", BLAST_TEXTURE_UNITS * scale, 0xffa24d, "ring");
    this.ensureTexture("bh-strike", BLAST_TEXTURE_UNITS * scale, 0x9bd0ff, "ring");
    this.ensureTexture("bh-gem", GEM_RADIUS_UNITS * scale, 0x7ce7ff, "diamond");
    this.ensureTexture("bh-orbiter", ORBITER_RADIUS_UNITS * scale, 0xffe0a3, "circle");

    this.player = scene.add.image(world.player.x, world.player.y, "bh-player").setDepth(2);
    this.layer.add(this.player);
    this.eventsRead = world.events.written;
  }

  /**
   * Перенести камеру забега на слой мира и на фон.
   *
   * Мир бесконечен, поэтому фон — повторяющаяся текстура, сдвинутая на
   * положение камеры: без него на пустом участке карты движение не видно
   * вовсе — персонаж и враги висят в чёрном, и игрок не понимает, бежит он
   * или стоит (docs/26-stage2-plan.md, WP4.1).
   */
  applyCamera(x: number, y: number, zoom: number): void {
    const width = this.scene.scale.width;
    const height = this.scene.scale.height;

    this.layer.setScale(zoom);
    this.layer.setPosition(width / 2 - x * zoom, height / 2 - y * zoom);

    this.ground.setSize(width, height);
    this.ground.setTileScale(zoom, zoom);
    this.ground.setTilePosition(x - width / (2 * zoom), y - height / (2 * zoom));
  }

  /**
   * Перенести состояние мира на спрайты. Вызывается раз в кадр, не раз в тик.
   *
   * `alpha` — доля пройденного времени до следующего шага симуляции.
   * Симуляция идёт фиксированными шагами по 60 Гц, а кадры приходят когда
   * придут; без интерполяции между предыдущим и текущим положением картинка
   * дёргается каждый раз, когда кадр не совпал с шагом.
   */
  sync(alpha: number): void {
    const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    this.syncEnemies(t);
    this.syncProjectiles(t);
    this.syncGems(t);
    this.syncOrbiters();
    this.syncBlasts();

    this.player.setPosition(
      lerp(this.world.player.prevX, this.world.player.x, t),
      lerp(this.world.player.prevY, this.world.player.y, t),
    );
    this.player.setVisible(this.world.player.alive);
  }

  private syncEnemies(t: number): void {
    const enemies = this.world.enemies;
    const tick = this.world.stats.tick;

    for (let i = 0; i < enemies.count; i++) {
      const sprite = this.enemySprite(i);
      if (enemies.alive[i] === 0) {
        if (sprite.visible) sprite.setVisible(false);
        continue;
      }

      const typeIndex = enemies.type[i];
      if (this.enemySpriteType[i] !== typeIndex) {
        sprite.setTexture(this.textureKeyByType[typeIndex]);
        this.enemySpriteType[i] = typeIndex;
      }
      this.applyLook(sprite, i, lookFor(this.world.enemyTypes[typeIndex].pattern, enemies.phase[i], tick));
      sprite.setVisible(true);
      sprite.setPosition(
        lerp(enemies.prevX[i], enemies.x[i], t),
        lerp(enemies.prevY[i], enemies.y[i], t),
      );
    }
  }

  private syncProjectiles(t: number): void {
    const projectiles = this.world.projectiles;
    for (let p = 0; p < projectiles.count; p++) {
      const sprite = this.projectileSprite(p);
      if (projectiles.alive[p] === 0) {
        if (sprite.visible) sprite.setVisible(false);
        continue;
      }
      sprite.setTexture(
        projectiles.fromPlayer[p] === 1 ? "bh-projectile" : "bh-projectile-enemy",
      );
      sprite.setVisible(true);
      sprite.setPosition(
        lerp(projectiles.prevX[p], projectiles.x[p], t),
        lerp(projectiles.prevY[p], projectiles.y[p], t),
      );
    }
  }

  private syncGems(t: number): void {
    const gems = this.world.gems;
    for (let i = 0; i < gems.count; i++) {
      const sprite = this.gemSprite(i);
      if (gems.alive[i] === 0) {
        if (sprite.visible) sprite.setVisible(false);
        continue;
      }
      sprite.setVisible(true);
      sprite.setPosition(lerp(gems.prevX[i], gems.x[i], t), lerp(gems.prevY[i], gems.y[i], t));
    }
  }

  /**
   * Обереги не живут в пуле снарядов: их положение целиком задаётся
   * состоянием оружия, поэтому рендер спрашивает его у самого оружия.
   */
  private syncOrbiters(): void {
    const world = this.world;
    let drawn = 0;

    for (let slot = 0; slot < world.loadout.weapons.length; slot++) {
      const weapon = world.loadout.weapons[slot];
      const type = world.weaponTypes[weapon.typeIndex];
      if (type.behavior !== "orbit") continue;

      const level = type.levels[Math.min(weapon.level, type.levels.length) - 1];
      const count = orbiterCount(level);
      for (let k = 0; k < count; k++) {
        orbiterPosition(world, slot, level, k, orbiterScratch);
        const sprite = this.orbiterSprite(drawn++);
        sprite.setVisible(true);
        sprite.setPosition(orbiterScratch.x, orbiterScratch.y);
      }
    }

    for (let i = drawn; i < this.orbiterSprites.length; i++) {
      if (this.orbiterSprites[i].visible) this.orbiterSprites[i].setVisible(false);
    }
  }

  /**
   * Вид спрайта меняется только при смене состояния: вызов setAlpha и
   * setScale на каждого врага каждый кадр — лишняя работа на сотнях объектов.
   */
  private applyLook(sprite: Phaser.GameObjects.Image, index: number, look: number): void {
    if (this.enemySpriteLook[index] === look && sprite.visible) return;
    this.enemySpriteLook[index] = look;
    sprite.setAlpha(look === LOOK.dim ? 0.35 : 1);
    sprite.setScale(look === LOOK.normal ? 1 : 1.2);
    if (look === LOOK.warning) sprite.setTint(0xffffff);
    else sprite.clearTint();
  }

  /**
   * Взрывы — из буфера событий симуляции. Длительность эффекта считается в
   * тиках симуляции, а не в реальном времени: на паузе эффект замирает вместе
   * с миром, и рендеру не нужно знать время кадра.
   */
  private syncBlasts(): void {
    const events = this.world.events;
    const capacity = events.kind.length;
    const first = Math.max(this.eventsRead, events.written - capacity);

    for (let seq = first; seq < events.written; seq++) {
      const slot = seq % capacity;
      const kind = events.kind[slot];
      if (kind !== SIM_EVENT.explosion && kind !== SIM_EVENT.strike) continue;
      this.startBlast(events.x[slot], events.y[slot], events.radius[slot], events.tick[slot], kind);
    }
    this.eventsRead = events.written;

    const tick = this.world.stats.tick;
    const textureRadius = BLAST_TEXTURE_UNITS * this.world.config.unitScale;
    for (let b = 0; b < this.blasts.length; b++) {
      const sprite = this.blasts[b];
      const age = tick - this.blastStartTick[b];
      if (this.blastStartTick[b] < 0 || age >= BLAST_LIFETIME_TICKS) {
        if (sprite.visible) sprite.setVisible(false);
        continue;
      }
      const progress = age / BLAST_LIFETIME_TICKS;
      sprite.setScale((this.blastRadius[b] / textureRadius) * (0.6 + 0.4 * progress));
      sprite.setAlpha(1 - progress);
      sprite.setVisible(true);
    }
  }

  private startBlast(x: number, y: number, radius: number, tick: number, kind: number): void {
    const b = this.nextBlast;
    this.nextBlast = (this.nextBlast + 1) % MAX_BLASTS;
    while (this.blasts.length <= b) {
      const sprite = this.scene.add.image(0, 0, "bh-blast").setVisible(false).setDepth(3);
      this.layer.add(sprite);
      this.blasts.push(sprite);
    }
    if (this.blastKind[b] !== kind) {
      this.blasts[b].setTexture(kind === SIM_EVENT.strike ? "bh-strike" : "bh-blast");
      this.blastKind[b] = kind;
    }
    this.blasts[b].setPosition(x, y);
    this.blastStartTick[b] = tick;
    this.blastRadius[b] = radius;
  }

  private gemSprite(index: number): Phaser.GameObjects.Image {
    while (this.gemSprites.length <= index) {
      this.gemSprites.push(this.createHiddenSprite("bh-gem"));
    }
    return this.gemSprites[index];
  }

  private orbiterSprite(index: number): Phaser.GameObjects.Image {
    while (this.orbiterSprites.length <= index) {
      const sprite = this.scene.add.image(0, 0, "bh-orbiter").setVisible(false).setDepth(2);
      this.layer.add(sprite);
      this.orbiterSprites.push(sprite);
    }
    return this.orbiterSprites[index];
  }

  /**
   * Спрайты появляются по мере роста занятой части пула и дальше живут вечно.
   * Верхняя граница — та же ёмкость пула, так что бесконтрольного роста нет.
   */
  private enemySprite(index: number): Phaser.GameObjects.Image {
    while (this.enemySprites.length <= index) {
      this.enemySprites.push(this.createHiddenSprite(this.textureKeyByType[0] ?? "bh-player"));
    }
    return this.enemySprites[index];
  }

  private projectileSprite(index: number): Phaser.GameObjects.Image {
    while (this.projectileSprites.length <= index) {
      this.projectileSprites.push(this.createHiddenSprite("bh-projectile"));
    }
    return this.projectileSprites[index];
  }

  /** Все объекты мира живут в слое: камера — это его трансформация. */
  private createHiddenSprite(key: string): Phaser.GameObjects.Image {
    const sprite = this.scene.add.image(0, 0, key).setVisible(false).setDepth(1);
    this.layer.add(sprite);
    return sprite;
  }

  /**
   * Плитка фона. Размер в игровых единицах, а не в пикселях экрана: сетка
   * обязана быть одинаковой на любом устройстве, иначе на телефоне с высокой
   * плотностью она превращается в мелкую рябь.
   */
  private ensureGroundTexture(scale: number): void {
    const key = "bh-ground";
    if (this.scene.textures.exists(key)) return;

    const size = Math.max(2, Math.round(GROUND_TILE_UNITS * scale));
    const graphics = this.scene.make.graphics({ x: 0, y: 0 }, false);
    graphics.fillStyle(0x0d0f14, 1);
    graphics.fillRect(0, 0, size, size);
    graphics.fillStyle(0x171b24, 1);
    graphics.fillRect(0, 0, size, Math.max(1, Math.round(scale)));
    graphics.fillRect(0, 0, Math.max(1, Math.round(scale)), size);
    graphics.generateTexture(key, size, size);
    graphics.destroy();
  }

  private ensureTexture(key: string, radius: number, color: number, shape: ShapeKind): void {
    if (this.scene.textures.exists(key)) return;

    const size = Math.ceil(radius * 2);
    const graphics = this.scene.make.graphics({ x: 0, y: 0 }, false);
    drawShape(graphics, { shape, radius, color });
    graphics.generateTexture(key, size, size);
    graphics.destroy();
  }
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * Осветлить цвет для элиты: половина пути к белому. Считается по каналам, а
 * не подбирается вручную для каждого паттерна, — иначе новый паттерн однажды
 * останется без своего элитного цвета.
 */
function brighten(color: number): number {
  const mix = (channel: number): number => Math.round(channel + (255 - channel) * 0.45);
  const r = mix((color >> 16) & 0xff);
  const g = mix((color >> 8) & 0xff);
  const b = mix(color & 0xff);
  return (r << 16) | (g << 8) | b;
}

/** Сколько взрывов показывается одновременно; дальше перезаписываются старые. */
const MAX_BLASTS = 24;
/** Сторона плитки фона в игровых единицах. */
const GROUND_TILE_UNITS = 64;
const BLAST_LIFETIME_TICKS = 18;
const BLAST_TEXTURE_UNITS = 32;
const GEM_RADIUS_UNITS = 5;
const ORBITER_RADIUS_UNITS = 9;

const LOOK = {
  normal: 0,
  /** телеграф: враг вот-вот атакует */
  warning: 1,
  /** второй такт мигания */
  dim: 2,
} as const;

/**
 * Плейсхолдеры до прихода ассетов: у каждого поведения своя форма и цвет,
 * чтобы типы различались на глаз без подписи (docs/26-stage2-plan.md, WP1).
 */
const LOOK_BY_PATTERN: Record<EnemyPattern, { shape: ShapeKind; color: number }> = {
  swarm: { shape: "circle", color: 0xff8f6b },
  chase: { shape: "square", color: 0xc06bff },
  kite_and_shoot: { shape: "triangle", color: 0x6bd5ff },
  dash: { shape: "diamond", color: 0xffd36b },
  orbit: { shape: "ring", color: 0x8cf0ff },
  exploder: { shape: "hexagon", color: 0xff5a5a },
  splitter: { shape: "double", color: 0x9be36b },
};

/**
 * Мигание телеграфа по тикам симуляции: рывок мигает медленнее, фитиль — чаще,
 * чтобы угрозы различались ещё и ритмом.
 */
function lookFor(pattern: EnemyPattern, phase: number, tick: number): number {
  if (pattern === "dash" && phase === DASH_PHASE.telegraph) {
    return (tick >> 3) % 2 === 0 ? LOOK.warning : LOOK.dim;
  }
  if (pattern === "exploder" && phase === EXPLODER_PHASE.fuse) {
    return (tick >> 2) % 2 === 0 ? LOOK.warning : LOOK.dim;
  }
  return LOOK.normal;
}
