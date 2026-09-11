import Phaser from "phaser";
import { ENEMIES } from "../content/enemies";
import { WAVES } from "../content/waves";
import { createWorld, resizeWorld, TICK_SEC, type World } from "./sim/world";
import { stepWorld, type SimInput } from "./sim/step";
import { createWaveSpawner, type Spawner } from "./sim/spawner";
import { WorldRenderer } from "./render/WorldRenderer";

const TICK_MS = TICK_SEC * 1000;
/**
 * Потолок шагов симуляции за кадр. Без него подвисший на секунду WebView
 * пытается «догнать» время шестьюдесятью шагами подряд, подвисает ещё сильнее
 * и никогда не догоняет.
 */
const MAX_STEPS_PER_FRAME = 5;

export interface MainSceneData {
  seed?: number;
  /** физических пикселей на игровую единицу — см. SimConfig.unitScale */
  unitScale?: number;
}

/**
 * Игровая сцена прототипа недели 1: перемещение персонажа, автоатака при
 * остановке, спавн волн из контента (docs/02-roadmap.md).
 *
 * Вся логика — в sim/, здесь только ввод, накопление времени и отрисовка.
 */
export class MainScene extends Phaser.Scene {
  private world!: World;
  private spawner!: Spawner;
  private worldRenderer!: WorldRenderer;
  private hud!: Phaser.GameObjects.Text;
  private keys!: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
  };
  private accumulatorMs = 0;
  private tick = 0;
  private unitScale = 1;

  constructor() {
    super("main");
  }

  create(data: MainSceneData): void {
    this.unitScale = data.unitScale ?? 1;

    this.world = createWorld({
      seed: data.seed ?? 1,
      enemies: ENEMIES,
      config: {
        width: this.scale.width,
        height: this.scale.height,
        unitScale: this.unitScale,
      },
    });
    this.spawner = createWaveSpawner(WAVES);
    this.worldRenderer = new WorldRenderer(this, this.world);

    this.cameras.main.setBackgroundColor("#0d0f14");
    this.hud = this.add
      .text(0, 0, "", {
        fontFamily: "monospace",
        // Размер в физических пикселях: канва создаётся в них же, иначе на
        // экране с высокой плотностью текст выходит мелким и мыльным.
        fontSize: `${Math.round(14 * this.unitScale)}px`,
        color: "#cfd6e4",
      })
      .setDepth(10);
    this.layout();

    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    });

    this.keys = {
      up: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };
  }

  update(_time: number, deltaMs: number): void {
    const input = this.readInput();

    // Ограничение сверху: после сворачивания приложения дельта прилетает
    // огромная, и без обрезки игрок «телепортируется» на возврате.
    this.accumulatorMs += Math.min(deltaMs, TICK_MS * MAX_STEPS_PER_FRAME);

    let steps = 0;
    while (this.accumulatorMs >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
      this.spawner.update(this.world, TICK_SEC);
      stepWorld(this.world, input);
      this.accumulatorMs -= TICK_MS;
      this.tick++;
      steps++;
    }

    this.worldRenderer.sync(this.accumulatorMs / TICK_MS);
    this.updateHud();
  }

  private handleResize(): void {
    resizeWorld(this.world, this.scale.width, this.scale.height);
    this.layout();
  }

  /** Раскладка пересчитывается от текущего размера канвы, а не от стартового. */
  private layout(): void {
    const margin = 12 * this.unitScale;
    this.hud.setPosition(margin, margin);
  }

  private readInput(): SimInput {
    const cursors = this.input.keyboard?.createCursorKeys();
    let moveX = 0;
    let moveY = 0;

    if (this.keys.left.isDown || cursors?.left.isDown) moveX -= 1;
    if (this.keys.right.isDown || cursors?.right.isDown) moveX += 1;
    if (this.keys.up.isDown || cursors?.up.isDown) moveY -= 1;
    if (this.keys.down.isDown || cursors?.down.isDown) moveY += 1;

    // Тач: тянемся к точке касания. Достаточно для прототипа — виртуальный
    // джойстик появится вместе с UI недели 2.
    const pointer = this.input.activePointer;
    if (moveX === 0 && moveY === 0 && pointer.isDown) {
      const dx = pointer.worldX - this.world.player.x;
      const dy = pointer.worldY - this.world.player.y;
      if (Math.hypot(dx, dy) > this.world.config.player.radius) {
        moveX = dx;
        moveY = dy;
      }
    }

    return { moveX, moveY };
  }

  private updateHud(): void {
    const stats = this.world.stats;
    this.hud.setText(
      [
        `Время: ${stats.elapsedSec.toFixed(1)} с`,
        `HP: ${this.world.player.hp.toFixed(0)} / ${this.world.player.maxHp}`,
        `Врагов на экране: ${this.world.enemies.aliveCount}`,
        `Убито: ${stats.enemiesKilled}`,
      ].join("\n"),
    );
  }
}
