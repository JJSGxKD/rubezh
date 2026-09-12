import Phaser from "phaser";
import { ENEMIES } from "../content/enemies";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../content/upgrades";
import { WAVES } from "../content/waves";
import { WEAPONS } from "../content/weapons";
import { chooseUpgrade, isAwaitingChoice } from "./progression/levels";
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

/** Клавиши выбора улучшения во временном экране. */
const CHOICE_KEYS = ["ONE", "TWO", "THREE"] as const;

/** Сколько игнорировать нажатия после появления экрана выбора. */
const CHOICE_GUARD_MS = 350;

export interface MainSceneData {
  seed?: number;
  /** физических пикселей на игровую единицу — см. SimConfig.unitScale */
  unitScale?: number;
  /** чем начинать забег; по умолчанию — первое стартовое оружие контента */
  startingWeaponId?: string;
}

/**
 * Игровая сцена: перемещение персонажа, оружие, волны врагов, опыт и выбор
 * улучшений (docs/26-stage2-plan.md, WP1–WP2).
 *
 * Вся логика — в sim/, здесь только ввод, накопление времени и отрисовка.
 */
export class MainScene extends Phaser.Scene {
  private world!: World;
  private spawner!: Spawner;
  private worldRenderer!: WorldRenderer;
  private hud!: Phaser.GameObjects.Text;
  /**
   * Временный экран выбора улучшения прямо на канве. Настоящий — React-оверлей
   * оболочки приложения (docs/27-design-system-and-app-shell.md §3), он
   * появится в WP5; до тех пор забег должен быть играбельным целиком.
   */
  private choiceOverlay!: Phaser.GameObjects.Text;
  private keys!: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
  };
  /**
   * Выбранный вариант улучшения. Ввод здесь событийный, а не опросом
   * состояния раз в кадр: короткий тап укладывается между кадрами и при
   * опросе просто теряется — на просевшем FPS это происходит постоянно.
   */
  private pendingChoice: number | null = null;
  /** когда показан экран выбора — для защиты от случайного тапа */
  private choiceShownAtMs = 0;
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
      weapons: WEAPONS,
      passives: PASSIVES,
      levelCurve: LEVEL_CURVE,
      loadoutLimits: LOADOUT_LIMITS,
      ...(data.startingWeaponId === undefined ? {} : { startingWeaponId: data.startingWeaponId }),
      config: {
        width: this.scale.width,
        height: this.scale.height,
        unitScale: this.unitScale,
      },
    });
    this.spawner = createWaveSpawner(WAVES);
    this.worldRenderer = new WorldRenderer(this, this.world);

    this.cameras.main.setBackgroundColor("#0d0f14");
    this.hud = this.add.text(0, 0, "", this.textStyle(14, "#cfd6e4")).setDepth(10);
    this.choiceOverlay = this.add
      .text(0, 0, "", { ...this.textStyle(16, "#ffe066"), backgroundColor: "#161a23" })
      .setDepth(20)
      .setVisible(false);
    this.layout();

    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    });

    const keyboard = this.input.keyboard!;
    this.keys = {
      up: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };

    CHOICE_KEYS.forEach((key, index) => {
      keyboard.on(`keydown-${key}`, () => {
        this.pendingChoice = index;
      });
    });

    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (!isAwaitingChoice(this.world)) return;
      const count = Math.max(1, this.world.progression.offers.length);
      const column = Math.floor((pointer.x / this.scale.width) * count);
      this.pendingChoice = Math.min(count - 1, Math.max(0, column));
    });
  }

  update(time: number, deltaMs: number): void {
    if (isAwaitingChoice(this.world)) {
      if (this.choiceShownAtMs === 0) this.choiceShownAtMs = time;
      this.applyPendingChoice(time);
      // Накопленное время сбрасывается: после выбора мир не должен
      // «догонять» пропущенные тики пачкой шагов.
      this.accumulatorMs = 0;
      this.worldRenderer.sync(0);
      this.renderChoiceOverlay();
      this.updateHud();
      return;
    }

    this.choiceShownAtMs = 0;
    this.pendingChoice = null;
    if (this.choiceOverlay.visible) this.choiceOverlay.setVisible(false);

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
      if (isAwaitingChoice(this.world)) break;
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
    this.choiceOverlay.setPosition(margin, this.scale.height / 3);
    this.choiceOverlay.setWordWrapWidth(this.scale.width - margin * 2);
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
    // джойстик появится вместе с оболочкой приложения (WP5).
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

  /**
   * Применить выбор, сделанный клавишей или тапом.
   *
   * Первые доли секунды после появления экрана нажатия игнорируются: палец в
   * этот момент ещё ведёт персонажа, и случайный тап выбрал бы улучшение за
   * игрока (docs/26-stage2-plan.md, WP2).
   */
  private applyPendingChoice(nowMs: number): void {
    const index = this.pendingChoice;
    if (index === null) return;

    this.pendingChoice = null;
    if (nowMs - this.choiceShownAtMs < CHOICE_GUARD_MS) return;

    const offers = this.world.progression.offers;
    chooseUpgrade(this.world, offers[Math.min(index, offers.length - 1)].id);
    this.choiceShownAtMs = 0;
  }

  private renderChoiceOverlay(): void {
    const offers = this.world.progression.offers;
    const lines = [`Уровень ${this.world.progression.level} — выбери улучшение:`];

    offers.forEach((offer, index) => {
      lines.push(`${index + 1}) ${offer.nameKey} — уровень ${offer.level}`);
    });
    lines.push("Клавиши 1-3 или тап по своей трети экрана");

    this.choiceOverlay.setText(lines.join("\n"));
    this.choiceOverlay.setVisible(true);
  }

  private updateHud(): void {
    const stats = this.world.stats;
    const progression = this.world.progression;
    const weapons = this.world.loadout.weapons
      .map((slot) => `${this.world.weaponTypes[slot.typeIndex].id} ${slot.level}`)
      .join(", ");

    this.hud.setText(
      [
        `Время: ${stats.elapsedSec.toFixed(1)} с`,
        `HP: ${this.world.player.hp.toFixed(0)} / ${this.world.playerStats.maxHp.toFixed(0)}`,
        `Уровень ${progression.level} | опыт ${progression.xp.toFixed(0)} / ${progression.xpToNext}`,
        `Оружие: ${weapons === "" ? "нет" : weapons}`,
        `Врагов на экране: ${this.world.enemies.aliveCount} | убито: ${stats.enemiesKilled}`,
      ].join("\n"),
    );
  }

  private textStyle(sizeUnits: number, color: string): Phaser.Types.GameObjects.Text.TextStyle {
    // Размер в физических пикселях: канва создаётся в них же, иначе на
    // экране с высокой плотностью текст выходит мелким и мыльным.
    return {
      fontFamily: "monospace",
      fontSize: `${Math.round(sizeUnits * this.unitScale)}px`,
      color,
    };
  }
}
