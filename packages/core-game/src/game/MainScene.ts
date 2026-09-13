import Phaser from "phaser";
import type { RunOutcome } from "@bh/shared-types";
import { ENEMIES } from "../content/enemies";
import { CONTENT_HASH } from "../content/hash";
import { DEFAULT_MAP_ID, findMap, MAPS } from "../content/maps";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../content/upgrades";
import { ENDLESS_CURVE, TIMELINE } from "../content/waves";
import { WEAPONS } from "../content/weapons";
import type { RunBus } from "../engine/run-bus";
import type { HudSnapshot, RunPauseReason } from "../run-api";
import { chooseUpgrade, isAwaitingChoice } from "./progression/levels";
import { createWorld, TICK_SEC, type World } from "./sim/world";
import { stepWorld, type SimInput } from "./sim/step";
import { createTimelineDirector } from "./sim/director";
import type { Spawner } from "./sim/spawner";
import { RunCamera } from "./render/run-camera";
import { WorldRenderer } from "./render/WorldRenderer";
import { Joystick } from "./joystick";
import { buildRunResult } from "./run/run-result";
import { createUuid } from "./uuid";

const TICK_MS = TICK_SEC * 1000;

/**
 * Потолок шагов симуляции за кадр. Без него подвисший на секунду WebView
 * пытается «догнать» время шестьюдесятью шагами подряд, подвисает ещё сильнее
 * и никогда не догоняет.
 */
const MAX_STEPS_PER_FRAME = 5;

/**
 * Как часто уходит снимок для HUD. Десять раз в секунду — правило
 * производительности оболочки (docs/27-design-system-and-app-shell.md §3.3):
 * чаще человек всё равно не читает, а React перерисовывается каждый раз.
 */
const HUD_INTERVAL_MS = 100;

/**
 * Состояние забега. Пока экран не «running», мир не делает ни одного шага:
 * пауза, выбор улучшения и смерть обязаны быть детерминированными — иначе
 * повтор забега по логу ввода разойдётся с оригиналом.
 */
type RunPhase = "running" | "choosing" | "paused" | "dead";

export interface MainSceneData {
  seed: number;
  /** физических пикселей на игровую единицу — см. SimConfig.unitScale */
  unitScale: number;
  mapId: string;
  /** чем начинать забег; по умолчанию — первое стартовое оружие контента */
  startingWeaponId?: string;
  /** шина событий наружу: экраны рисует оболочка, движок только сообщает */
  bus: RunBus;
}

/**
 * Сцена забега: мир, камера, джойстик и игровой цикл.
 *
 * Экранов здесь больше нет — пауза, выбор улучшения и смерть рисуются
 * React-оболочкой поверх остановленной канвы
 * (docs/27-design-system-and-app-shell.md §3.2). Сцена сообщает о событиях и
 * принимает команды, а что показать игроку, решает оболочка.
 */
export class MainScene extends Phaser.Scene {
  private sceneData!: MainSceneData;
  private world!: World;
  private spawner!: Spawner;
  private worldRenderer!: WorldRenderer;
  private runCamera!: RunCamera;
  private joystick!: Joystick;
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
  private hudTimerMs = 0;
  private reportedWave = -1;

  constructor() {
    super("main");
  }

  create(data: MainSceneData): void {
    this.sceneData = data;
    this.seed = data.seed;
    this.runId = createUuid();
    this.accumulatorMs = 0;
    this.hudTimerMs = 0;
    this.reportedWave = -1;
    this.phase = "running";

    const map = findMap(data.mapId) ?? findMap(DEFAULT_MAP_ID) ?? MAPS[0];
    this.world = createWorld({
      seed: this.seed,
      enemies: ENEMIES,
      weapons: WEAPONS,
      passives: PASSIVES,
      levelCurve: LEVEL_CURVE,
      loadoutLimits: LOADOUT_LIMITS,
      map,
      ...(data.startingWeaponId === undefined ? {} : { startingWeaponId: data.startingWeaponId }),
      config: { unitScale: data.unitScale },
    });
    this.spawner = createTimelineDirector(TIMELINE, ENDLESS_CURVE);
    this.worldRenderer = new WorldRenderer(this, this.world);
    this.runCamera = new RunCamera(map.camera, data.unitScale);
    this.runCamera.snapTo(this.world, this.scale.width, this.scale.height);
    this.syncCamera();

    this.cameras.main.setBackgroundColor("#0d0f14");
    this.joystick = new Joystick(this, data.unitScale);
    this.bindKeyboard();

    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    });

    this.emitHud();
    this.reportWave();
  }

  update(_time: number, deltaMs: number): void {
    if (this.phase !== "running") {
      // Мир стоит: накопитель сбрасывается, чтобы после возврата не прилетела
      // пачка «догоняющих» шагов, и рисуется последнее состояние без
      // интерполяции. Камера применяется заново — иначе поворот экрана на
      // паузе сдвинул бы мир относительно канвы.
      this.accumulatorMs = 0;
      this.syncCamera();
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

    // Камера живёт в реальном времени кадра, а не в тиках симуляции: она к
    // исходу забега отношения не имеет и на детерминизм не влияет.
    this.runCamera.update(this.world, deltaMs / 1000);
    this.syncCamera();
    this.worldRenderer.sync(this.accumulatorMs / TICK_MS);
    this.reportWave();

    this.hudTimerMs += deltaMs;
    if (this.hudTimerMs >= HUD_INTERVAL_MS) {
      this.hudTimerMs = 0;
      this.emitHud();
    }

    if (!this.world.player.alive) {
      this.finishRun("died");
      return;
    }
    if (isAwaitingChoice(this.world)) this.enterChoice();
  }

  // --- Команды оболочки -----------------------------------------------------

  pauseRun(reason: RunPauseReason): void {
    if (this.phase !== "running") return;
    this.phase = "paused";
    this.joystick.setVisible(false);
    this.emitHud();
    this.sceneData.bus.emit("paused", { reason, elapsedSec: this.world.stats.elapsedSec });
  }

  resumeRun(): void {
    if (this.phase !== "paused") return;
    this.phase = "running";
    this.sceneData.bus.emit("resumed", { elapsedSec: this.world.stats.elapsedSec });
  }

  abandonRun(): void {
    if (this.phase === "dead") return;
    this.finishRun("abandoned");
  }

  /**
   * Применить выбор игрока. Неизвестный вариант игнорируется: выбор приходит
   * снаружи — из интерфейса или из лога ввода при повторе забега, — и
   * доверять ему нельзя.
   */
  applyChoice(optionId: string): void {
    if (this.phase !== "choosing") return;
    if (!chooseUpgrade(this.world, optionId)) return;

    this.emitHud();
    // Уровней могло накопиться несколько: пока очередь не пуста, мир стоит и
    // оболочка получает следующий выбор.
    if (isAwaitingChoice(this.world)) {
      this.emitLevelUp();
      return;
    }

    this.phase = "running";
    // О возврате в забег сообщаем событием, а не оставляем оболочке гадать.
    // Раньше она сама переводила себя в «бежим» сразу после команды выбора —
    // и затирала уже пришедший следующий выбор из очереди: экран пропадал, а
    // мир оставался стоять.
    this.sceneData.bus.emit("resumed", { elapsedSec: this.world.stats.elapsedSec });
  }

  restartRun(seed: number): void {
    this.scene.restart({ ...this.sceneData, seed });
  }

  // --- Внутреннее -----------------------------------------------------------

  private enterChoice(): void {
    if (this.phase === "choosing") return;
    this.phase = "choosing";
    this.joystick.setVisible(false);
    this.emitLevelUp();
  }

  private emitLevelUp(): void {
    const progression = this.world.progression;
    this.sceneData.bus.emit("levelUp", {
      level: progression.level,
      options: [...progression.offers],
      // Сколько уровней ещё ждёт выбора: игрок должен понимать, что экран
      // откроется снова, а не гадать (docs/26-stage2-plan.md, WP2).
      queued: Math.max(0, progression.pendingLevelUps - 1),
    });
  }

  private finishRun(outcome: RunOutcome): void {
    if (this.phase === "dead") return;
    this.phase = "dead";
    this.joystick.setVisible(false);

    const result = buildRunResult(this.world, {
      runId: this.runId,
      seed: this.seed,
      outcome,
      startingWeaponId: this.startingWeaponId(),
      contentHash: CONTENT_HASH,
    });

    this.emitHud();
    // Локальный рекорд и аналитику ведёт оболочка: движок не знает ни о сети,
    // ни о хранилище устройства (docs/27-design-system-and-app-shell.md §3.1).
    this.sceneData.bus.emit(outcome === "died" ? "finished" : "abandoned", result);
  }

  private emitHud(): void {
    const world = this.world;
    const snapshot: HudSnapshot = {
      survivalSec: world.stats.elapsedSec,
      hp: world.player.hp,
      maxHp: world.playerStats.maxHp,
      level: world.progression.level,
      xp: world.progression.xp,
      xpToNext: world.progression.xpToNext,
      wave: world.difficulty.segment,
      enemiesAlive: world.enemies.aliveCount,
      enemiesKilled: world.stats.enemiesKilled,
      weapons: world.loadout.weapons.map((slot) => ({
        id: world.weaponTypes[slot.typeIndex].id,
        level: slot.level,
      })),
      passives: world.loadout.passives.map((slot) => ({
        id: world.passiveTypes[slot.typeIndex].id,
        level: slot.level,
      })),
    };
    this.sceneData.bus.emit("hud", snapshot);
  }

  /** Новый отрезок таймлайна — событие `wave_reached` для аналитики. */
  private reportWave(): void {
    const wave = this.world.difficulty.segment;
    if (wave === this.reportedWave) return;
    this.reportedWave = wave;
    this.sceneData.bus.emit("waveReached", { index: wave, elapsedSec: this.world.stats.elapsedSec });
  }

  private syncCamera(): void {
    this.worldRenderer.applyCamera(this.runCamera.x, this.runCamera.y, this.runCamera.zoom);
  }

  /**
   * Поворот экрана и изменение окна. Мир не трогаем вовсе — он бесконечен и о
   * размере канвы не знает; пересчитывается только камера, и объём видимого
   * мира при этом остаётся тем же (docs/27-design-system-and-app-shell.md §5.3).
   */
  private handleResize(): void {
    this.runCamera.resize(this.scale.width, this.scale.height);
    this.syncCamera();
  }

  private bindKeyboard(): void {
    // Клавиатура — для отладки на десктопе; на устройстве играют джойстиком.
    const keyboard = this.input.keyboard;
    if (keyboard === null || keyboard === undefined) return;

    this.keys = {
      up: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };
  }

  private readInput(): SimInput {
    // Палец главнее клавиатуры: если джойстик активен, клавиши не мешают.
    if (this.joystick.active) return this.joystick.input;

    const cursors = this.input.keyboard?.createCursorKeys();
    let moveX = 0;
    let moveY = 0;

    if (this.keys?.left.isDown === true || cursors?.left.isDown === true) moveX -= 1;
    if (this.keys?.right.isDown === true || cursors?.right.isDown === true) moveX += 1;
    if (this.keys?.up.isDown === true || cursors?.up.isDown === true) moveY -= 1;
    if (this.keys?.down.isDown === true || cursors?.down.isDown === true) moveY += 1;

    return { moveX, moveY };
  }

  private startingWeaponId(): string {
    const first = this.world.loadout.weapons[0];
    return first === undefined ? "" : this.world.weaponTypes[first.typeIndex].id;
  }
}
