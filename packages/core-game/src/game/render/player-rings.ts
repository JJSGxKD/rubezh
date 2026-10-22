import Phaser from "phaser";
import type { World } from "../sim/world";
import { WORLD_COLORS } from "./looks";
import { ellipsePoints, hpArc, levelFlash, SHIELD_RIM, shieldBeads, SIGIL } from "./player-sigil";

/**
 * Кольца вокруг персонажа: здоровье убывает по кругу, как часы, а опыт
 * наполняется до следующего уровня.
 *
 * Полоски в HUD не заменяются, а дополняются: игрок в бою смотрит на
 * персонажа, а не в угол экрана, и «сколько у меня осталось» должно читаться
 * там же, где происходит бой (docs/27-design-system-and-app-shell.md §3.3).
 *
 * Рисуется одним `Graphics` на два кольца: две дуги в кадре дешевле, чем
 * спрайты с масками, и не плодят объектов.
 *
 * У героя-спрайта колец нет: они режут тело. Вместо них — знак под ногами
 * (`player-sigil.ts`): здоровье дугой эллипса на земле, свой `Graphics` под
 * героем и врагами; опыт — только в HUD.
 */

/** Радиусы колец в радиусах персонажа: здоровье ближе, опыт снаружи. */
const HP_RADIUS = 1.45;
const XP_RADIUS = 1.72;
const HP_WIDTH = 3.2;
const XP_WIDTH = 2.2;
/** Подложка кольца: без неё непонятно, сколько «целого» осталось. */
const TRACK_ALPHA = 0.18;
/** Начало и направление: сверху по часовой, как на часах. */
const START_ANGLE = -Math.PI / 2;

/** Ниже этой доли здоровья кольцо начинает пульсировать. */
const PULSE_BELOW = 0.3;
/** Период пульса в тиках симуляции — примерно три четверти секунды. */
const PULSE_TICKS = 45;

export class PlayerRings {
  private readonly graphics: Phaser.GameObjects.Graphics;
  /** знак под ногами — на земле, под героем и врагами */
  readonly ground: Phaser.GameObjects.Graphics;
  private shownLevel: number;
  private levelUpTick = Number.NEGATIVE_INFINITY;

  constructor(
    scene: Phaser.Scene,
    private readonly world: World,
    layer: Phaser.GameObjects.Container,
  ) {
    this.graphics = scene.add.graphics().setDepth(2);
    this.ground = scene.add.graphics();
    layer.add(this.ground);
    layer.add(this.graphics);
    this.shownLevel = world.progression.level;
  }

  /**
   * `x`, `y` — уже сглаженная позиция персонажа этого кадра; `sigil` — герой
   * нарисован спрайтом, и вместо колец — знак под ногами.
   */
  draw(x: number, y: number, sigil = false): void {
    const graphics = this.graphics;
    graphics.clear();
    this.ground.clear();

    const player = this.world.player;
    if (!player.alive) return;
    if (sigil) {
      this.drawSigil(x, y);
      return;
    }

    const scale = this.world.config.player.radius;
    const maxHp = this.world.playerStats.maxHp;
    const hp = maxHp > 0 ? Math.max(0, Math.min(1, player.hp / maxHp)) : 0;
    const progression = this.world.progression;
    const xp = progression.xpToNext > 0 ? Math.max(0, Math.min(1, progression.xp / progression.xpToNext)) : 0;

    // На последних каплях здоровья кольцо пульсирует: цвет игрок мог и не
    // заметить в бою, движение замечает всякий.
    const alpha = hp > PULSE_BELOW ? 1 : 0.55 + 0.45 * pulse(this.world.stats.tick);
    this.ring(x, y, scale * HP_RADIUS, scale * HP_WIDTH * 0.1, hp, hpColor(hp), alpha);
    this.ring(x, y, scale * XP_RADIUS, scale * XP_WIDTH * 0.1, xp, WORLD_COLORS.xpRing, 1);
  }

  destroy(): void {
    this.graphics.destroy();
    this.ground.destroy();
  }

  private drawSigil(x: number, y: number): void {
    const ground = this.ground;
    const r = this.world.config.player.radius;
    const cx = x;
    const cy = y + r * SIGIL.offsetY;
    const rx = r * SIGIL.rx;
    const ry = r * SIGIL.ry;
    const width = r * SIGIL.width;
    const maxHp = this.world.playerStats.maxHp;
    const hp = maxHp > 0 ? Math.max(0, Math.min(1, this.world.player.hp / maxHp)) : 0;
    const tick = this.world.stats.tick;

    // Подложка — тёмная и цветная: знак читается и на светлом лугу, и на погосте.
    ground.lineStyle(width * 1.6, 0x000000, 0.28);
    ground.strokeEllipse(cx, cy, rx * 2, ry * 2);
    const color = hpColor(hp);
    ground.lineStyle(width, color, TRACK_ALPHA);
    ground.strokeEllipse(cx, cy, rx * 2, ry * 2);

    const arc = hpArc(hp);
    if (arc !== null) {
      const alpha = hp > PULSE_BELOW ? 0.95 : 0.55 + 0.45 * pulse(tick);
      ground.lineStyle(width, color, alpha);
      strokeLine(ground, ellipsePoints(cx, cy, rx, ry, arc.start, arc.end, SIGIL_SEGMENTS));
    }

    // Щит «Эгиды» — светлый ободок вокруг знака и бусина на каждое попадание,
    // которое он ещё примет: щит виден до удара, а не только вспышкой после.
    const shield = this.world.player.shieldHits;
    if (shield > 0) {
      const srx = rx * SHIELD_RIM.scale;
      const sry = ry * SHIELD_RIM.scale;
      ground.lineStyle(width * 0.45, SHIELD_RIM.color, 0.7);
      ground.strokeEllipse(cx, cy, srx * 2, sry * 2);
      ground.fillStyle(SHIELD_RIM.color, 0.95);
      for (const angle of shieldBeads(shield)) {
        const bx = cx + Math.cos(angle) * srx;
        const by = cy + Math.sin(angle) * sry;
        // Ромб двумя треугольниками — без новых объектов в каждом кадре.
        const half = width * 0.7;
        ground.fillTriangle(bx, by - width, bx + half, by, bx - half, by);
        ground.fillTriangle(bx - half, by, bx + half, by, bx, by + width);
      }
    }

    // Новый уровень — кольцо расходится от знака: момент виден на герое.
    const level = this.world.progression.level;
    if (level > this.shownLevel) this.levelUpTick = tick;
    this.shownLevel = level;
    const flash = levelFlash(tick - this.levelUpTick);
    if (flash !== null) {
      ground.lineStyle(width * 0.8, WORLD_COLORS.xpRing, flash.alpha);
      ground.strokeEllipse(cx, cy, rx * 2 * flash.scale, ry * 2 * flash.scale);
    }
  }

  private ring(
    x: number,
    y: number,
    radius: number,
    width: number,
    fill: number,
    color: number,
    alpha: number,
  ): void {
    const graphics = this.graphics;
    graphics.lineStyle(width, color, TRACK_ALPHA);
    graphics.beginPath();
    graphics.arc(x, y, radius, 0, Math.PI * 2);
    graphics.strokePath();
    if (fill <= 0) return;

    graphics.lineStyle(width, color, 0.9 * alpha);
    graphics.beginPath();
    graphics.arc(x, y, radius, START_ANGLE, START_ANGLE + Math.PI * 2 * fill);
    graphics.strokePath();
  }
}

/**
 * Цвет кольца здоровья: зелёный, пока запас есть, жёлтый на исходе и красный
 * в конце. Свои цвета, а не цвета эффектов лечения и взрыва: кольцо обязано
 * читаться само по себе, даже когда вокруг персонажа и то, и другое.
 */
function hpColor(fill: number): number {
  return fill > 0.6 ? WORLD_COLORS.hpFull : fill > PULSE_BELOW ? WORLD_COLORS.hpMid : WORLD_COLORS.hpLow;
}

/** Отрезков на полный эллипс знака: глаз не видит граней, а точек немного. */
const SIGIL_SEGMENTS = 40;

function strokeLine(graphics: Phaser.GameObjects.Graphics, points: readonly number[]): void {
  graphics.beginPath();
  graphics.moveTo(points[0] ?? 0, points[1] ?? 0);
  for (let i = 2; i < points.length; i += 2) graphics.lineTo(points[i] ?? 0, points[i + 1] ?? 0);
  graphics.strokePath();
}

/** Треугольная волна 0 → 1 → 0: без тригонометрии, её здесь и не нужно. */
function pulse(tick: number): number {
  const phase = tick % PULSE_TICKS;
  const half = PULSE_TICKS / 2;
  return phase < half ? phase / half : (PULSE_TICKS - phase) / half;
}
