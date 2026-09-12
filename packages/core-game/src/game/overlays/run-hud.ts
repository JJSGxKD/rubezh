import type Phaser from "phaser";
import type { World } from "../sim/world";
import { canvasTextStyle } from "./text-style";

/**
 * Временный HUD забега на канве: время выживания, здоровье, уровень, оружие,
 * враги и кнопка паузы.
 *
 * Настоящий HUD — React-слой над канвой с обновлением не чаще 10 Гц
 * (docs/27-design-system-and-app-shell.md §3.2), он появится в WP5. Здесь
 * текст перерисовывается каждый кадр — для временного экрана это дешевле, чем
 * заводить собственный таймер, который всё равно выбрасывать.
 */
export class RunHud {
  private readonly scene: Phaser.Scene;
  private readonly unitScale: number;
  private readonly text: Phaser.GameObjects.Text;
  private readonly pauseButton: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, unitScale: number, onPause: () => void) {
    this.scene = scene;
    this.unitScale = unitScale;

    this.text = scene.add.text(0, 0, "", canvasTextStyle(unitScale, 14, "#cfd6e4")).setDepth(10);
    this.pauseButton = scene.add
      .text(0, 0, "II", {
        ...canvasTextStyle(unitScale, 16, "#cfd6e4"),
        backgroundColor: "#161a23",
        padding: { x: 8 * unitScale, y: 4 * unitScale },
      })
      .setDepth(10)
      .setInteractive({ useHandCursor: true });
    this.pauseButton.on("pointerdown", onPause);
  }

  /**
   * HUD прячется целиком, когда открыт экран паузы, выбора или смерти: под
   * полупрозрачным затемнением он просвечивает и налезает на текст экрана. В
   * оболочке приложения он по той же причине размонтируется, а не прячется
   * стилем (docs/27-design-system-and-app-shell.md §3.3, правило 3).
   */
  setVisible(visible: boolean): void {
    this.text.setVisible(visible);
    this.pauseButton.setVisible(visible);
  }

  update(world: World): void {
    const stats = world.stats;
    const progression = world.progression;
    const weapons = world.loadout.weapons
      .map((slot) => `${world.weaponTypes[slot.typeIndex].id} ${slot.level}`)
      .join(", ");

    this.text.setText(
      [
        `Время: ${stats.elapsedSec.toFixed(1)} с`,
        `HP: ${world.player.hp.toFixed(0)} / ${world.playerStats.maxHp.toFixed(0)}`,
        `Уровень ${progression.level} | опыт ${progression.xp.toFixed(0)} / ${progression.xpToNext}`,
        `Оружие: ${weapons === "" ? "нет" : weapons}`,
        `Врагов на экране: ${world.enemies.aliveCount} | убито: ${stats.enemiesKilled}`,
      ].join("\n"),
    );
  }

  /** Раскладка пересчитывается от текущего размера канвы, а не от стартового. */
  layout(): void {
    const margin = 12 * this.unitScale;
    this.text.setPosition(margin, margin);
    this.pauseButton.setPosition(
      this.scene.scale.width - margin - this.pauseButton.width,
      margin,
    );
  }
}
