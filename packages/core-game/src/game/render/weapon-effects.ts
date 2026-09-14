import type Phaser from "phaser";
import type { World } from "../sim/world";
import { WORLD_COLORS } from "./looks";
import { ensureShapeTexture, lerp } from "./textures";

/**
 * Видимая работа оружия, которой нет у снаряда.
 *
 * - **«Очаг»** — зона урона вокруг игрока. Без границы игрок не знает, кого
 *   она достаёт: враг в шаге от края выглядит так же, как враг внутри. Граница
 *   видна всегда и вспыхивает в момент урона — ритм удара читается глазом.
 * - **«Гроза»** — ломаная молния с неба в точку удара и вспышка. Кольца
 *   площади мало: удар в случайного врага за спиной игрок иначе просто
 *   не замечает.
 *
 * Форма молнии считается из тика и координат, а не из генератора случайных
 * чисел: на паузе она не перерисовывается, а повтор забега рисует ту же.
 */
export class WeaponEffects {
  private readonly scene: Phaser.Scene;
  private readonly world: World;
  private readonly layer: Phaser.GameObjects.Container;
  private readonly auraRings: Phaser.GameObjects.Image[] = [];
  /** перезарядка ауры в прошлом кадре — рост значит, что удар случился */
  private readonly lastCooldown: number[] = [];
  private readonly auraFlashTick: number[] = [];
  private readonly bolts: { graphics: Phaser.GameObjects.Graphics; startTick: number }[] = [];
  private nextBolt = 0;

  constructor(scene: Phaser.Scene, world: World, layer: Phaser.GameObjects.Container) {
    this.scene = scene;
    this.world = world;
    this.layer = layer;
    ensureShapeTexture(scene, AURA_KEY, AURA_TEXTURE_UNITS * world.config.unitScale, WORLD_COLORS.aura, "wave");
  }

  /** Удар молнии — вызывается рендером на событие удара из симуляции. */
  strike(x: number, y: number, radius: number, tick: number): void {
    while (this.bolts.length < MAX_BOLTS) {
      const graphics = this.scene.add.graphics().setDepth(4).setVisible(false);
      this.layer.add(graphics);
      this.bolts.push({ graphics, startTick: -1 });
    }
    const bolt = this.bolts[this.nextBolt];
    this.nextBolt = (this.nextBolt + 1) % MAX_BOLTS;
    bolt.startTick = tick;
    drawBolt(bolt.graphics, x, y, radius, tick, this.world.config.unitScale);
    bolt.graphics.setVisible(true).setAlpha(1);
  }

  sync(t: number): void {
    this.syncAuras(t);
    const tick = this.world.stats.tick;
    for (const bolt of this.bolts) {
      if (bolt.startTick < 0) continue;
      const age = tick - bolt.startTick;
      if (age >= BOLT_LIFETIME_TICKS || age < 0) {
        bolt.graphics.setVisible(false);
        bolt.startTick = -1;
        continue;
      }
      // Первые тики — полная яркость, дальше молния быстро гаснет: вспышка, а
      // не висящая в воздухе линия.
      bolt.graphics.setAlpha(age < 3 ? 1 : 1 - (age - 3) / (BOLT_LIFETIME_TICKS - 3));
    }
  }

  private syncAuras(t: number): void {
    const world = this.world;
    const tick = world.stats.tick;
    const x = lerp(world.player.prevX, world.player.x, t);
    const y = lerp(world.player.prevY, world.player.y, t);
    const textureRadius = AURA_TEXTURE_UNITS * world.config.unitScale;
    let used = 0;

    for (let slot = 0; slot < world.loadout.weapons.length; slot++) {
      const weapon = world.loadout.weapons[slot];
      const type = world.weaponTypes[weapon.typeIndex];
      if (type.behavior !== "aura") continue;

      const level = type.levels[Math.min(weapon.level, type.levels.length) - 1];
      const radius = level.areaRadius * world.playerStats.areaMul;
      if ((this.lastCooldown[slot] ?? 0) < weapon.cooldown) this.auraFlashTick[slot] = tick;
      this.lastCooldown[slot] = weapon.cooldown;

      const sprite = this.auraSprite(used++);
      const age = tick - (this.auraFlashTick[slot] ?? -AURA_FLASH_TICKS);
      const flash = age >= 0 && age < AURA_FLASH_TICKS ? 1 - age / AURA_FLASH_TICKS : 0;
      sprite
        .setPosition(x, y)
        .setScale((radius / textureRadius) * (1 + 0.04 * flash))
        .setAlpha(world.player.alive ? 0.32 + 0.5 * flash : 0)
        .setVisible(true);
    }

    for (let k = used; k < this.auraRings.length; k++) {
      if (this.auraRings[k].visible) this.auraRings[k].setVisible(false);
    }
  }

  private auraSprite(index: number): Phaser.GameObjects.Image {
    while (this.auraRings.length <= index) {
      const sprite = this.scene.add.image(0, 0, AURA_KEY).setDepth(-1).setVisible(false);
      this.layer.add(sprite);
      this.auraRings.push(sprite);
    }
    return this.auraRings[index];
  }
}

/**
 * Ломаная из неба в точку удара: слой ореола и светлый стержень поверх,
 * короткое ответвление и вспышка на земле по радиусу площади.
 */
function drawBolt(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  radius: number,
  tick: number,
  scale: number,
): void {
  const height = BOLT_HEIGHT_UNITS * scale;
  const jitter = BOLT_JITTER_UNITS * scale;
  let seed = (tick * 73856093) ^ (Math.round(x) * 19349663) ^ (Math.round(y) * 83492791);
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };

  const points: { x: number; y: number }[] = [];
  const topX = x + next() * jitter * 2;
  for (let s = 0; s <= BOLT_SEGMENTS; s++) {
    const k = s / BOLT_SEGMENTS;
    const sway = s === 0 || s === BOLT_SEGMENTS ? 0 : next() * jitter * (1 - k * 0.5);
    points.push({ x: lerp(topX, x, k) + sway, y: y - height * (1 - k) });
  }

  graphics.clear();
  graphics.fillStyle(WORLD_COLORS.lightning, 0.18);
  graphics.fillCircle(x, y, radius);
  strokePath(graphics, points, 7 * scale, WORLD_COLORS.lightning, 0.35);
  strokePath(graphics, points, 2.2 * scale, WORLD_COLORS.lightningCore, 1);

  const from = points[Math.floor(BOLT_SEGMENTS / 2)];
  const branch = [from, { x: from.x + next() * jitter * 3, y: from.y + height * 0.18 }];
  strokePath(graphics, branch, 1.4 * scale, WORLD_COLORS.lightning, 0.8);
  graphics.fillStyle(WORLD_COLORS.lightningCore, 0.9);
  graphics.fillCircle(x, y, 5 * scale);
}

function strokePath(
  graphics: Phaser.GameObjects.Graphics,
  points: readonly { x: number; y: number }[],
  width: number,
  color: number,
  alpha: number,
): void {
  graphics.lineStyle(width, color, alpha);
  graphics.beginPath();
  graphics.moveTo(points[0].x, points[0].y);
  for (let k = 1; k < points.length; k++) graphics.lineTo(points[k].x, points[k].y);
  graphics.strokePath();
}

const AURA_KEY = "bh-aura-ring";
const AURA_TEXTURE_UNITS = 128;
/** Сколько тиков граница «Очага» вспыхивает после удара. */
const AURA_FLASH_TICKS = 10;
const MAX_BOLTS = 6;
const BOLT_LIFETIME_TICKS = 14;
/** С какой высоты над целью бьёт молния, игровые единицы. */
const BOLT_HEIGHT_UNITS = 360;
const BOLT_JITTER_UNITS = 26;
const BOLT_SEGMENTS = 7;
