import Phaser from "phaser";
import { ENEMIES } from "../content/enemies";
import { WAVES } from "../content/waves";

/**
 * Плейсхолдер-сцена для технического прототипа недели 1
 * (docs/02-roadmap.md — "Неделя 1: голый Phaser-прототип, перемещение
 * персонажа + автоатака при остановке + спавн 50-100 врагов").
 * Никакой финальной логики здесь пока нет специально.
 */
export class MainScene extends Phaser.Scene {
  private player?: Phaser.GameObjects.Arc;
  private elapsedSec = 0;

  constructor() {
    super("main");
  }

  create(): void {
    this.player = this.add.circle(400, 300, 12, 0x00ff88);
    this.cameras.main.setBackgroundColor("#111");
    console.log(`Загружено ${ENEMIES.length} типов врагов, ${WAVES.length} волн`);
  }

  update(_time: number, deltaMs: number): void {
    this.elapsedSec += deltaMs / 1000;
    // TODO: перемещение по вводу + авто-атака при остановке (неделя 1)
    // TODO: спавн волн по WAVES относительно this.elapsedSec (неделя 2)
  }
}
