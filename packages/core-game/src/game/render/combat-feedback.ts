import Phaser from "phaser";
import { NEVER_HIT } from "../sim/pools";
import type { World } from "../sim/world";

/**
 * Обратная связь боя: всплывающие числа урона и вспышка гибели врага.
 *
 * Симуляция о них не знает и ничего для них не пишет. Попадание видно по пулу
 * врагов: изменился тик попадания — значит, по врагу попали, и разница
 * здоровья с прошлым кадром — нанесённый урон. Слот, который из живого стал
 * пустым сразу после попадания, — убитый игроком враг. Так числа не требуют
 * буфера событий, который попадания сотнями вытеснили бы целиком.
 *
 * Всё живёт в тиках симуляции, а не во времени кадра: на паузе числа замирают
 * вместе с миром.
 *
 * Бережём кадр на бюджетном Android: текст — самый дорогой объект Phaser
 * (своя канва и загрузка текстуры на каждое изменение), поэтому чисел на
 * экране не больше `MAX_NUMBERS`, новых за кадр — не больше
 * `MAX_NEW_NUMBERS_PER_FRAME`, а мелкие попадания одного врага за кадр
 * складываются в одно число.
 */

/** Сколько чисел урона живёт одновременно; новые вытесняют самые старые. */
const MAX_NUMBERS = 18;
/** Сколько новых чисел может появиться за кадр — остальные попадания молча. */
const MAX_NEW_NUMBERS_PER_FRAME = 3;
/** Жизнь числа урона в тиках — полсекунды. */
const NUMBER_LIFETIME_TICKS = 32;
/** На сколько игровых единиц число поднимается за жизнь. */
const NUMBER_RISE_UNITS = 22;
/** Размер шрифта числа в игровых единицах. */
const NUMBER_SIZE_UNITS = 13;

/** Сколько вспышек гибели показывается одновременно. */
const MAX_BURSTS = 24;
const BURST_LIFETIME_TICKS = 16;
/** Вспышка гибели шире врага: смерть должна читаться, а не мигнуть. */
const BURST_RADIUS_MUL = 2.4;
const BURST_TEXTURE_UNITS = 24;

/** Попадание засчитывается как убийство, если тик попадания не старше этого. */
const KILL_HIT_WINDOW_TICKS = 2;

export class CombatFeedback {
  private readonly scene: Phaser.Scene;
  private readonly world: World;
  private readonly layer: Phaser.GameObjects.Container;
  private readonly colorByType: readonly number[];

  /** здоровье и тик попадания каждого слота на прошлом кадре */
  private readonly lastHp: Float32Array;
  private readonly lastHitTick: Int32Array;
  private readonly lastAlive: Uint8Array;

  private readonly numbers: Phaser.GameObjects.Text[] = [];
  private readonly numberBornTick: Int32Array = new Int32Array(MAX_NUMBERS).fill(-1);
  private readonly numberX: Float32Array = new Float32Array(MAX_NUMBERS);
  private readonly numberY: Float32Array = new Float32Array(MAX_NUMBERS);
  private nextNumber = 0;
  /**
   * Режим разработчика выключает числа и вспышки. Память здоровья при этом
   * ведётся дальше: включённые обратно, они не покажут урон, накопленный за
   * время выключения, одним огромным числом.
   */
  enabled = true;

  private readonly bursts: Phaser.GameObjects.Image[] = [];
  private readonly burstBornTick: Int32Array = new Int32Array(MAX_BURSTS).fill(-1);
  private readonly burstScale: Float32Array = new Float32Array(MAX_BURSTS);
  private nextBurst = 0;

  constructor(
    scene: Phaser.Scene,
    world: World,
    layer: Phaser.GameObjects.Container,
    colorByType: readonly number[],
  ) {
    this.scene = scene;
    this.world = world;
    this.layer = layer;
    this.colorByType = colorByType;

    const capacity = world.enemies.alive.length;
    this.lastHp = new Float32Array(capacity);
    this.lastHitTick = new Int32Array(capacity);
    this.lastAlive = new Uint8Array(capacity);
    this.remember();

    this.ensureBurstTexture();
  }

  sync(): void {
    const tick = this.world.stats.tick;
    this.detect(tick);
    this.animateNumbers(tick);
    this.animateBursts(tick);
  }

  private detect(tick: number): void {
    const enemies = this.world.enemies;
    let created = 0;

    for (let i = 0; i < enemies.count; i++) {
      const wasAlive = this.lastAlive[i] === 1;
      const alive = enemies.alive[i] === 1;

      // Новый враг в слоте — в том числе занявший слот убитого за этот же кадр:
      // у свежего врага тик попадания сброшен. Сравнивать его здоровье не с чем.
      if (alive && (!wasAlive || (enemies.hitTick[i] === NEVER_HIT && this.lastHitTick[i] !== NEVER_HIT))) {
        this.lastHp[i] = enemies.hp[i];
        this.lastHitTick[i] = enemies.hitTick[i];
        this.lastAlive[i] = 1;
        continue;
      }
      if (!alive && wasAlive) {
        this.lastAlive[i] = 0;
        // Самоподрыв и прочий уход без попадания — не убийство игроком.
        if (!this.enabled || tick - enemies.hitTick[i] > KILL_HIT_WINDOW_TICKS) continue;
        const type = this.world.enemyTypes[enemies.type[i]];
        this.startBurst(enemies.x[i], enemies.y[i], type.radius, this.colorByType[enemies.type[i]] ?? 0xffffff, tick);
        if (created < MAX_NEW_NUMBERS_PER_FRAME && this.lastHp[i] > 0) {
          this.startNumber(enemies.x[i], enemies.y[i] - type.radius, this.lastHp[i], true, tick);
          created++;
        }
        continue;
      }
      if (!alive) continue;

      if (enemies.hitTick[i] !== this.lastHitTick[i]) {
        const dealt = this.lastHp[i] - enemies.hp[i];
        if (this.enabled && dealt > 0 && created < MAX_NEW_NUMBERS_PER_FRAME) {
          const type = this.world.enemyTypes[enemies.type[i]];
          this.startNumber(enemies.x[i], enemies.y[i] - type.radius, dealt, false, tick);
          created++;
        }
        this.lastHitTick[i] = enemies.hitTick[i];
      }
      this.lastHp[i] = enemies.hp[i];
    }
  }

  private remember(): void {
    const enemies = this.world.enemies;
    for (let i = 0; i < enemies.alive.length; i++) {
      this.lastAlive[i] = enemies.alive[i];
      this.lastHp[i] = enemies.hp[i];
      this.lastHitTick[i] = enemies.hitTick[i];
    }
  }

  private startNumber(x: number, y: number, amount: number, kill: boolean, tick: number): void {
    const n = this.nextNumber;
    this.nextNumber = (this.nextNumber + 1) % MAX_NUMBERS;

    while (this.numbers.length <= n) {
      const scale = this.world.config.unitScale;
      const text = this.scene.add
        .text(0, 0, "", {
          fontFamily: '"Rubik Variable", "Segoe UI", system-ui, sans-serif',
          fontStyle: "800",
          fontSize: `${Math.round(NUMBER_SIZE_UNITS * scale)}px`,
          color: "#f3f6fc",
          stroke: "#07090e",
          strokeThickness: Math.max(2, Math.round(3 * scale)),
        })
        .setOrigin(0.5, 1)
        .setDepth(4)
        .setVisible(false);
      this.layer.add(text);
      this.numbers.push(text);
    }

    const text = this.numbers[n];
    text.setText(String(Math.max(1, Math.round(amount))));
    // Добивание — тёплым цветом и крупнее: игрок видит, какой удар убил.
    text.setColor(kill ? "#ffd27a" : "#f3f6fc");
    text.setVisible(true);
    this.numberBornTick[n] = tick;
    this.numberX[n] = x;
    this.numberY[n] = y;
  }

  private animateNumbers(tick: number): void {
    const rise = NUMBER_RISE_UNITS * this.world.config.unitScale;
    for (let n = 0; n < this.numbers.length; n++) {
      const text = this.numbers[n];
      const age = tick - this.numberBornTick[n];
      if (this.numberBornTick[n] < 0 || age >= NUMBER_LIFETIME_TICKS) {
        if (text.visible) text.setVisible(false);
        continue;
      }
      const p = age / NUMBER_LIFETIME_TICKS;
      // Быстро вверх и плавное торможение, гаснет последней третью жизни.
      const eased = 1 - (1 - p) * (1 - p);
      text.setPosition(this.numberX[n], this.numberY[n] - rise * eased);
      text.setAlpha(p < 0.66 ? 1 : 1 - (p - 0.66) / 0.34);
      text.setScale(p < 0.15 ? 0.7 + (p / 0.15) * 0.45 : 1.15 - Math.min(1, (p - 0.15) / 0.2) * 0.15);
    }
  }

  private startBurst(x: number, y: number, radius: number, color: number, tick: number): void {
    const b = this.nextBurst;
    this.nextBurst = (this.nextBurst + 1) % MAX_BURSTS;

    while (this.bursts.length <= b) {
      const sprite = this.scene.add.image(0, 0, BURST_KEY).setDepth(3).setVisible(false);
      this.layer.add(sprite);
      this.bursts.push(sprite);
    }

    const sprite = this.bursts[b];
    sprite.setPosition(x, y);
    // Белая текстура, окрашенная цветом врага: вспышка того же цвета, что и
    // сам погибший, — видно, кто именно умер.
    sprite.setTint(color);
    sprite.setVisible(true);
    this.burstBornTick[b] = tick;
    this.burstScale[b] = (radius * BURST_RADIUS_MUL) / (BURST_TEXTURE_UNITS * this.world.config.unitScale);
  }

  private animateBursts(tick: number): void {
    for (let b = 0; b < this.bursts.length; b++) {
      const sprite = this.bursts[b];
      const age = tick - this.burstBornTick[b];
      if (this.burstBornTick[b] < 0 || age >= BURST_LIFETIME_TICKS) {
        if (sprite.visible) sprite.setVisible(false);
        continue;
      }
      const p = age / BURST_LIFETIME_TICKS;
      sprite.setScale(this.burstScale[b] * (0.35 + 0.65 * (1 - (1 - p) * (1 - p))));
      sprite.setAlpha(1 - p);
    }
  }

  /** Кольцо с заливкой по центру: «хлопок», а не просто обводка. */
  private ensureBurstTexture(): void {
    if (this.scene.textures.exists(BURST_KEY)) return;
    const radius = BURST_TEXTURE_UNITS * this.world.config.unitScale;
    const size = Math.ceil(radius * 2);
    const graphics = this.scene.make.graphics({ x: 0, y: 0 }, false);
    graphics.lineStyle(Math.max(2, radius * 0.22), 0xffffff, 1);
    graphics.strokeCircle(radius, radius, radius * 0.86);
    graphics.fillStyle(0xffffff, 0.35);
    graphics.fillCircle(radius, radius, radius * 0.55);
    graphics.generateTexture(BURST_KEY, size, size);
    graphics.destroy();
  }
}

const BURST_KEY = "bh-burst";
