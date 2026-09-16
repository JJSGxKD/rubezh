import Phaser from "phaser";
import type { World } from "../sim/world";
import { WORLD_COLORS } from "./looks";

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

  constructor(
    scene: Phaser.Scene,
    private readonly world: World,
    layer: Phaser.GameObjects.Container,
  ) {
    this.graphics = scene.add.graphics().setDepth(2);
    layer.add(this.graphics);
  }

  /** `x`, `y` — уже сглаженная позиция персонажа этого кадра. */
  draw(x: number, y: number): void {
    const graphics = this.graphics;
    graphics.clear();

    const player = this.world.player;
    if (!player.alive) return;

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

/** Треугольная волна 0 → 1 → 0: без тригонометрии, её здесь и не нужно. */
function pulse(tick: number): number {
  const phase = tick % PULSE_TICKS;
  const half = PULSE_TICKS / 2;
  return phase < half ? phase / half : (PULSE_TICKS - phase) / half;
}
