import Phaser from "phaser";
import type { KeyValueStorage, RunOutcome, RunResult } from "@bh/shared-types";
import { ENEMIES } from "../content/enemies";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../content/upgrades";
import { WAVES } from "../content/waves";
import { WEAPONS } from "../content/weapons";
import { chooseUpgrade, isAwaitingChoice } from "./progression/levels";
import { createWorld, resizeWorld, TICK_SEC, type World } from "./sim/world";
import { stepWorld, type SimInput } from "./sim/step";
import { createWaveSpawner, type Spawner } from "./sim/spawner";
import { WorldRenderer } from "./render/WorldRenderer";
import { CanvasPanel, type PanelAction } from "./overlays/canvas-panel";
import { RunHud } from "./overlays/run-hud";
import {
  choiceScreenLines,
  deathScreenLines,
  offerLabel,
  pauseScreenLines,
  surrenderScreenLines,
} from "./overlays/run-screens";
import { submitRunResult, type RecordUpdate } from "./run/records";
import { buildRunResult } from "./run/run-result";
import { createUuid } from "./uuid";

const TICK_MS = TICK_SEC * 1000;
/**
 * Потолок шагов симуляции за кадр. Без него подвисший на секунду WebView
 * пытается «догнать» время шестьюдесятью шагами подряд, подвисает ещё сильнее
 * и никогда не догоняет.
 */
const MAX_STEPS_PER_FRAME = 5;

/** Клавиши выбора на временных экранах: цифры повторяют кнопки по порядку. */
const CHOICE_KEYS = ["ONE", "TWO", "THREE", "FOUR"] as const;

/** Ответ кнопок, за которыми пока нет экрана: молчащая кнопка — это баг. */
const SHELL_STUB_NOTE = "Появится вместе с оболочкой приложения";

export type RunPauseReason = "manual" | "app_inactive";

export interface RunPauseInfo {
  reason: RunPauseReason;
  elapsedSec: number;
}

/**
 * Состояние забега. Пока экран не «running», мир не делает ни одного шага:
 * пауза, выбор улучшения и смерть обязаны быть детерминированными — иначе
 * повтор забега по логу ввода разойдётся с оригиналом.
 */
type RunPhase = "running" | "choosing" | "paused" | "surrender" | "dead";

export interface MainSceneData {
  seed?: number;
  /** физических пикселей на игровую единицу — см. SimConfig.unitScale */
  unitScale?: number;
  /** чем начинать забег; по умолчанию — первое стартовое оружие контента */
  startingWeaponId?: string;
  /** режим диагностики: на экране смерти видны seed и runId */
  diagnostics?: boolean;
  /** хранилище устройства под локальный рекорд; без него рекорд не переживёт запуск */
  storage?: KeyValueStorage;
  /** итог забега для аналитики — отправляет оболочка, движок только считает */
  onRunEnd?: (result: RunResult) => void;
  onRunPaused?: (info: RunPauseInfo) => void;
}

/**
 * Игровая сцена: перемещение персонажа, оружие, волны врагов, опыт, выбор
 * улучшений, пауза и итог забега (docs/26-stage2-plan.md, WP1–WP3).
 *
 * Вся логика — в sim/, здесь только ввод, накопление времени и отрисовка.
 */
export class MainScene extends Phaser.Scene {
  private sceneData: MainSceneData = {};
  private world!: World;
  private spawner!: Spawner;
  private worldRenderer!: WorldRenderer;
  private hud!: RunHud;
  private panel!: CanvasPanel;
  private keys!: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
  };
  private phase: RunPhase = "running";
  private runId = "";
  private seed = 1;
  private accumulatorMs = 0;
  private unitScale = 1;
  /** ответ нажатой кнопки-заглушки — показывается на том же экране */
  private note = "";
  /** перерисовка открытого экрана: тексты меняются, кнопки и задержка — нет */
  private renderScreen: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;

  constructor() {
    super("main");
  }

  create(data: MainSceneData): void {
    this.sceneData = data;
    this.unitScale = data.unitScale ?? 1;
    this.seed = data.seed ?? 1;
    this.runId = createUuid();
    this.accumulatorMs = 0;
    this.note = "";
    this.renderScreen = null;

    this.world = createWorld({
      seed: this.seed,
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
    this.hud = new RunHud(this, this.unitScale, () => this.pauseRun("manual"));
    this.panel = new CanvasPanel(this, this.unitScale);
    this.setPhase("running");
    this.layout();

    this.bindInput();
    this.watchVisibility();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
  }

  update(_time: number, deltaMs: number): void {
    if (this.phase !== "running") {
      // Мир стоит: накопитель сбрасывается, чтобы после возврата не прилетела
      // пачка «догоняющих» шагов, и рисуется последнее состояние без интерполяции.
      this.accumulatorMs = 0;
      this.worldRenderer.sync(0);
      return;
    }

    const input = this.readInput();

    // Ограничение сверху: после сворачивания приложения дельта прилетает
    // огромная, и без обрезки игрок «телепортируется» на возврате.
    this.accumulatorMs += Math.min(deltaMs, TICK_MS * MAX_STEPS_PER_FRAME);

    let steps = 0;
    while (this.accumulatorMs >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
      this.spawner.update(this.world, TICK_SEC);
      stepWorld(this.world, input);
      this.accumulatorMs -= TICK_MS;
      steps++;
      if (!this.world.player.alive || isAwaitingChoice(this.world)) break;
    }

    this.worldRenderer.sync(this.accumulatorMs / TICK_MS);
    this.hud.update(this.world);

    if (!this.world.player.alive) {
      this.finishRun("died");
      return;
    }
    if (isAwaitingChoice(this.world)) this.showChoice();
  }

  /**
   * Смена состояния забега. HUD прячется вместе с ней: над открытым экраном
   * он просвечивает сквозь затемнение и налезает на текст.
   */
  private setPhase(phase: RunPhase): void {
    this.phase = phase;
    this.hud.setVisible(phase === "running");
  }

  private bindInput(): void {
    const keyboard = this.input.keyboard!;
    this.keys = {
      up: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };

    // Ввод на экранах событийный, а не опросом раз в кадр: короткий тап
    // укладывается между кадрами и при опросе просто теряется — на просевшем
    // FPS это происходит постоянно.
    CHOICE_KEYS.forEach((key, index) => {
      keyboard.on(`keydown-${key}`, () => this.panel.select(index));
    });
    keyboard.on("keydown-ESC", () => this.togglePause());
    keyboard.on("keydown-P", () => this.togglePause());
  }

  /**
   * Автопауза при сворачивании. Игрок, которому позвонили, не должен вернуться
   * к экрану смерти: пока приложение в фоне, кадры не идут, а враги — идут.
   *
   * Сигнал — только `visibilitychange`, не потеря фокуса окном: во встроенном
   * WebView фокус уходит от касания по чужому элементу и от клавиатуры, и
   * забег вставал бы на паузу посреди игры. Тем же признаком стенд испытаний
   * отбрасывает кадры фона (docs/28-diagnostics.md §3.1).
   */
  private watchVisibility(): void {
    if (typeof document === "undefined") return;

    this.visibilityHandler = (): void => {
      if (document.hidden) this.pauseRun("app_inactive");
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);
  }

  private teardown(): void {
    this.scale.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    if (this.visibilityHandler !== null && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    this.panel.destroy();
  }

  private handleResize(): void {
    resizeWorld(this.world, this.scale.width, this.scale.height);
    this.layout();
  }

  private layout(): void {
    this.hud.layout();
    this.panel.layout();
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

  private showChoice(): void {
    this.setPhase("choosing");
    this.renderScreen = null;
    const actions: PanelAction[] = this.world.progression.offers.map((offer) => ({
      label: offerLabel(offer),
      onSelect: () => {
        chooseUpgrade(this.world, offer.id);
        this.setPhase("running");
        this.panel.hide();
      },
    }));

    this.panel.show(
      choiceScreenLines(this.world.progression.level, this.world.progression.pendingLevelUps - 1),
      actions,
    );
  }

  private togglePause(): void {
    if (this.phase === "paused") {
      this.resumeRun();
      return;
    }
    this.pauseRun("manual");
  }

  private pauseRun(reason: RunPauseReason): void {
    if (this.phase !== "running") return;
    this.note = "";
    this.showPause();
    this.sceneData.onRunPaused?.({ reason, elapsedSec: this.world.stats.elapsedSec });
  }

  private showPause(): void {
    this.setPhase("paused");
    const elapsedSec = this.world.stats.elapsedSec;
    this.renderScreen = (): void => this.panel.setLines(pauseScreenLines(elapsedSec, this.note));

    this.panel.show(pauseScreenLines(elapsedSec, this.note), [
      { label: "Продолжить", onSelect: () => this.resumeRun() },
      { label: "Звук и вибрация", onSelect: () => this.showStubNote() },
      { label: "Сдаться", onSelect: () => this.askSurrender() },
    ]);
  }

  private resumeRun(): void {
    this.setPhase("running");
    this.renderScreen = null;
    this.panel.hide();
  }

  /** Сдача — с подтверждением: случайный тап не должен обнулять забег. */
  private askSurrender(): void {
    this.setPhase("surrender");
    this.renderScreen = null;
    this.panel.show(surrenderScreenLines(this.world.stats.elapsedSec), [
      { label: "Да, сдаться", onSelect: () => this.finishRun("abandoned") },
      { label: "Нет, вернуться", onSelect: () => this.showPause() },
    ]);
  }

  private finishRun(outcome: RunOutcome): void {
    if (this.phase === "dead") return;
    this.setPhase("dead");
    this.note = "";

    const result = buildRunResult(this.world, {
      runId: this.runId,
      seed: this.seed,
      outcome,
      startingWeaponId: this.startingWeaponId(),
    });
    const record = submitRunResult(this.sceneData.storage, result);

    this.showDeath(result, record);
    // Аналитику шлёт оболочка: движок не знает ни о сети, ни о событиях
    // (docs/27-design-system-and-app-shell.md §3.1).
    this.sceneData.onRunEnd?.(result);
  }

  private showDeath(result: RunResult, record: RecordUpdate): void {
    const lines = (): string[] =>
      deathScreenLines({
        result,
        record,
        diagnostics: this.sceneData.diagnostics === true,
        note: this.note,
      });
    this.renderScreen = (): void => this.panel.setLines(lines());

    this.panel.show(lines(), [
      { label: "Ещё раз", onSelect: () => this.restartRun() },
      { label: "В меню", onSelect: () => this.showStubNote() },
      { label: "Поделиться", onSelect: () => this.showStubNote() },
    ]);
  }

  /** Кнопка без экрана обязана отвечать: молчащая кнопка читается как баг. */
  private showStubNote(): void {
    this.note = SHELL_STUB_NOTE;
    this.renderScreen?.();
  }

  /**
   * «Ещё раз» — новая сцена в уже загруженном движке: Phaser не пересоздаётся,
   * ассеты не перечитываются, от смерти до нового забега остаётся один тап
   * (docs/26-stage2-plan.md, WP3).
   *
   * Seed новый, стартовое оружие то же. `Math.random` здесь допустим: сцена не
   * часть симуляции, а сам seed попадает в итог забега и в отчёт диагностики,
   * так что забег остаётся воспроизводимым.
   */
  private restartRun(): void {
    const seed = Math.floor(Math.random() * 0x7fffffff) + 1;
    this.scene.restart({ ...this.sceneData, seed });
  }

  private startingWeaponId(): string {
    const first = this.world.loadout.weapons[0];
    return first === undefined ? "" : this.world.weaponTypes[first.typeIndex].id;
  }
}
