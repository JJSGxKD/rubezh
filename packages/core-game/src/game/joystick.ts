import Phaser from "phaser";
import type { SimInput } from "./sim/step";

/**
 * Плавающий виртуальный джойстик: появляется там, где коснулся палец
 * (docs/27-design-system-and-app-shell.md §3.2).
 *
 * Рисуется на канве Phaser, а не в React: задержка ввода не должна зависеть
 * от перерисовки дерева компонентов, а джойстик обязан появиться в том же
 * кадре, в котором игрок коснулся экрана.
 *
 * Живёт в экранных координатах: камера забега — трансформация слоя мира, а
 * джойстик в этот слой не входит и потому не ездит вместе с картой.
 */

/** Радиус кольца в игровых единицах — от него же считается полный наклон. */
const RING_UNITS = 52;
/** Мёртвая зона: дрожь пальца на месте не должна вести персонажа. */
const DEAD_ZONE_UNITS = 6;

export class Joystick {
  private readonly scale: number;
  private readonly ring: Phaser.GameObjects.Arc;
  private readonly knob: Phaser.GameObjects.Arc;
  private pointerId = -1;
  private originX = 0;
  private originY = 0;
  private moveX = 0;
  private moveY = 0;

  constructor(scene: Phaser.Scene, unitScale: number) {
    this.scale = unitScale;
    this.ring = scene.add
      .circle(0, 0, RING_UNITS * unitScale, 0xffffff, 0.06)
      .setStrokeStyle(Math.max(1, 2 * unitScale), 0xffffff, 0.25)
      .setDepth(9)
      .setVisible(false);
    this.knob = scene.add
      .circle(0, 0, RING_UNITS * unitScale * 0.38, 0xffffff, 0.35)
      .setDepth(9)
      .setVisible(false);

    scene.input.on(Phaser.Input.Events.POINTER_DOWN, this.onDown, this);
    scene.input.on(Phaser.Input.Events.POINTER_MOVE, this.onMove, this);
    scene.input.on(Phaser.Input.Events.POINTER_UP, this.onUp, this);
    scene.input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onUp, this);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.destroy(scene));
  }

  /** Направление движения; нули — палец не на экране. */
  get input(): SimInput {
    return { moveX: this.moveX, moveY: this.moveY };
  }

  get active(): boolean {
    return this.pointerId >= 0;
  }

  setVisible(visible: boolean): void {
    if (visible) return;
    this.release();
  }

  private onDown(pointer: Phaser.Input.Pointer): void {
    // Второй палец джойстик не перехватывает: он может понадобиться под
    // будущую кнопку умения, а перескок джойстика под новый палец посреди
    // забега читается как потеря управления.
    if (this.pointerId >= 0) return;

    this.pointerId = pointer.id;
    this.originX = pointer.x;
    this.originY = pointer.y;
    this.ring.setPosition(pointer.x, pointer.y).setVisible(true);
    this.knob.setPosition(pointer.x, pointer.y).setVisible(true);
    this.moveX = 0;
    this.moveY = 0;
  }

  private onMove(pointer: Phaser.Input.Pointer): void {
    if (pointer.id !== this.pointerId) return;

    const dx = pointer.x - this.originX;
    const dy = pointer.y - this.originY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < DEAD_ZONE_UNITS * this.scale) {
      this.moveX = 0;
      this.moveY = 0;
      this.knob.setPosition(this.originX, this.originY);
      return;
    }

    // Направление — единичный вектор: симуляция принимает направление, а не
    // силу наклона. Полутонов скорости в игре нет, и «чуть-чуть идти» было бы
    // приглашением умереть.
    this.moveX = dx / distance;
    this.moveY = dy / distance;

    const reach = Math.min(distance, RING_UNITS * this.scale);
    this.knob.setPosition(this.originX + this.moveX * reach, this.originY + this.moveY * reach);
  }

  private onUp(pointer: Phaser.Input.Pointer): void {
    if (pointer.id !== this.pointerId) return;
    this.release();
  }

  private release(): void {
    this.pointerId = -1;
    this.moveX = 0;
    this.moveY = 0;
    this.ring.setVisible(false);
    this.knob.setVisible(false);
  }

  private destroy(scene: Phaser.Scene): void {
    scene.input.off(Phaser.Input.Events.POINTER_DOWN, this.onDown, this);
    scene.input.off(Phaser.Input.Events.POINTER_MOVE, this.onMove, this);
    scene.input.off(Phaser.Input.Events.POINTER_UP, this.onUp, this);
    scene.input.off(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onUp, this);
  }
}
