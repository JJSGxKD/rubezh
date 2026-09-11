import Phaser from "phaser";
import type { World } from "../sim/world";

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
  private readonly enemySprites: Phaser.GameObjects.Image[] = [];
  private readonly enemySpriteType: Int16Array;
  private readonly projectileSprites: Phaser.GameObjects.Image[] = [];
  private readonly player: Phaser.GameObjects.Image;
  private readonly textureKeyByType: string[] = [];

  constructor(scene: Phaser.Scene, world: World) {
    this.scene = scene;
    this.world = world;
    this.enemySpriteType = new Int16Array(world.config.maxEnemies).fill(-1);

    for (let i = 0; i < world.enemyTypes.length; i++) {
      const type = world.enemyTypes[i];
      const key = `bh-enemy-${type.id}`;
      this.ensureCircleTexture(key, type.radius, COLOR_BY_PATTERN[type.pattern]);
      this.textureKeyByType.push(key);
    }

    this.ensureCircleTexture("bh-player", world.config.player.radius, 0x6ee7a8);
    this.ensureCircleTexture("bh-projectile", world.config.player.projectileRadius, 0xffe066);
    this.ensureCircleTexture("bh-projectile-enemy", world.config.player.projectileRadius, 0xff6b6b);

    this.player = scene.add.image(world.player.x, world.player.y, "bh-player").setDepth(2);
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
    const enemies = this.world.enemies;
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
      sprite.setVisible(true);
      sprite.setPosition(
        lerp(enemies.prevX[i], enemies.x[i], t),
        lerp(enemies.prevY[i], enemies.y[i], t),
      );
    }

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

    this.player.setPosition(
      lerp(this.world.player.prevX, this.world.player.x, t),
      lerp(this.world.player.prevY, this.world.player.y, t),
    );
    this.player.setVisible(this.world.player.alive);
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

  private createHiddenSprite(key: string): Phaser.GameObjects.Image {
    return this.scene.add.image(0, 0, key).setVisible(false).setDepth(1);
  }

  private ensureCircleTexture(key: string, radius: number, color: number): void {
    if (this.scene.textures.exists(key)) return;

    const size = Math.ceil(radius * 2);
    const graphics = this.scene.make.graphics({ x: 0, y: 0 }, false);
    graphics.fillStyle(color, 1);
    graphics.fillCircle(radius, radius, radius);
    graphics.generateTexture(key, size, size);
    graphics.destroy();
  }
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

const COLOR_BY_PATTERN: Record<string, number> = {
  swarm: 0xff8f6b,
  chase: 0xc06bff,
  kite_and_shoot: 0x6bd5ff,
};
