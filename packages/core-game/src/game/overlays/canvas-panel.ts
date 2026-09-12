import Phaser from "phaser";
import { canvasTextStyle } from "./text-style";

/**
 * Временный экран поверх остановленной канвы: выбор улучшения, пауза, смерть.
 *
 * Настоящие экраны — React-оверлеи оболочки приложения
 * (docs/27-design-system-and-app-shell.md §3.2), они появятся в WP5. До тех пор
 * забег обязан быть играбельным целиком: без экрана смерти и паузы его нельзя
 * ни закончить, ни начать заново.
 *
 * Панель живёт в `game/overlays/*`, а не в сцене: сцена и без того держит цикл,
 * ввод и рендер, а три экрана с кнопками — это ещё две сотни строк.
 */
export interface PanelAction {
  label: string;
  onSelect(): void;
}

/**
 * Сколько панель не принимает нажатия после появления.
 *
 * Палец в этот момент ещё ведёт персонажа: без задержки тап по джойстику
 * выбирает улучшение за игрока и мгновенно закрывает экран смерти
 * (docs/26-stage2-plan.md, WP2).
 */
const GUARD_MS = 350;

const DEPTH = 20;

export class CanvasPanel {
  private readonly scene: Phaser.Scene;
  private readonly unitScale: number;
  private readonly backdrop: Phaser.GameObjects.Rectangle;
  private readonly body: Phaser.GameObjects.Text;
  private buttons: Phaser.GameObjects.Text[] = [];
  private shownAtMs = 0;
  private actions: PanelAction[] = [];

  constructor(scene: Phaser.Scene, unitScale: number) {
    this.scene = scene;
    this.unitScale = unitScale;

    // Затемнение вместо размытия: `backdrop-filter` поверх канвы на бюджетном
    // Android стоит дороже всего мира забега (docs/27 §3.3, правило 4).
    this.backdrop = scene.add
      .rectangle(0, 0, scene.scale.width, scene.scale.height, 0x0d0f14, 0.82)
      .setOrigin(0, 0)
      .setDepth(DEPTH)
      .setVisible(false);

    this.body = scene.add
      .text(0, 0, "", canvasTextStyle(this.unitScale, 15, "#e7ecf5"))
      .setDepth(DEPTH + 1)
      .setVisible(false);
  }

  get visible(): boolean {
    return this.backdrop.visible;
  }

  show(lines: readonly string[], actions: readonly PanelAction[]): void {
    this.clearButtons();
    this.actions = [...actions];
    this.shownAtMs = this.scene.time.now;

    this.body.setText(lines.join("\n"));
    this.actions.forEach((action, index) => {
      this.buttons.push(this.createButton(`${index + 1}. ${action.label}`, index));
    });

    this.backdrop.setVisible(true);
    this.body.setVisible(true);
    this.layout();
  }

  /** Перерисовать текст, не сбрасывая задержку и не пересоздавая кнопки. */
  setLines(lines: readonly string[]): void {
    this.body.setText(lines.join("\n"));
    this.layout();
  }

  hide(): void {
    this.clearButtons();
    this.actions = [];
    this.backdrop.setVisible(false);
    this.body.setVisible(false);
  }

  /** Выбор с клавиатуры: цифры 1-9 повторяют кнопки по порядку. */
  select(index: number): void {
    if (!this.visible || index < 0 || index >= this.actions.length) return;
    if (this.scene.time.now - this.shownAtMs < GUARD_MS) return;

    this.actions[index].onSelect();
  }

  layout(): void {
    if (!this.visible) return;

    const margin = 16 * this.unitScale;
    const gap = 10 * this.unitScale;
    const width = this.scene.scale.width;

    this.backdrop.setSize(width, this.scene.scale.height);
    this.body.setWordWrapWidth(width - margin * 2);
    this.body.setPosition(margin, margin * 2);

    // Кнопки — колонкой снизу вверх: на узком экране телефона ряд из четырёх
    // кнопок не помещается, а колонка читается при любой ширине.
    let top = this.scene.scale.height - margin;
    for (let i = this.buttons.length - 1; i >= 0; i--) {
      const button = this.buttons[i];
      top -= button.height;
      button.setPosition(margin, top);
      top -= gap;
    }
  }

  destroy(): void {
    this.clearButtons();
    this.backdrop.destroy();
    this.body.destroy();
  }

  private createButton(label: string, index: number): Phaser.GameObjects.Text {
    const padding = 10 * this.unitScale;
    const button = this.scene.add
      .text(0, 0, label, {
        ...canvasTextStyle(this.unitScale, 16, "#0d0f14"),
        backgroundColor: "#6ee7a8",
        padding: { x: padding, y: padding * 0.6 },
      })
      .setDepth(DEPTH + 1)
      .setInteractive({ useHandCursor: true });

    button.on("pointerdown", () => this.select(index));
    return button;
  }

  private clearButtons(): void {
    for (const button of this.buttons) button.destroy();
    this.buttons = [];
  }
}
