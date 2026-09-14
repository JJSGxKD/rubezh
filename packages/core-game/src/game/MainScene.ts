import Phaser from "phaser";
import type { DifficultyId, RunOutcome } from "@bh/shared-types";
import { ENEMIES } from "../content/enemies";
import { CONTENT_HASH } from "../content/hash";
import { DEFAULT_MAP_ID, findMap, MAPS } from "../content/maps";
import { DEFAULT_DIFFICULTY_ID, findDifficulty } from "../content/difficulty";
import { DROPS } from "../content/drops";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../content/upgrades";
import { ENDLESS_CURVE, TIMELINE } from "../content/waves";
import { WEAPONS } from "../content/weapons";
import type { RunBus } from "../engine/run-bus";
import {
  RUN_SNAPSHOT_FORMAT,
  type HudSnapshot,
  type RunDevCommand,
  type RunDevOptions,
  type RunInspection,
  type RunPauseReason,
  type RunSnapshot,
} from "../run-api";
import { applyDevCommand } from "./run/dev-commands";
import { inspectWorld } from "./run/inspect";
import { chooseUpgrade, isAwaitingChoice } from "./progression/levels";
import { createWorld, hasActiveCheats, TICK_SEC, type World } from "./sim/world";
import { IDLE_INPUT, stepWorld, type SimInput } from "./sim/step";
import { createTimelineDirector } from "./sim/director";
import type { Spawner } from "./sim/spawner";
import { RunCamera } from "./render/run-camera";
import { buildRadarSnapshot } from "./radar";
import { WorldRenderer } from "./render/WorldRenderer";
import { Joystick } from "./joystick";
import { buildRunResult } from "./run/run-result";
import { captureWorld, restoreWorld, SnapshotError } from "./run/snapshot";
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

/** Окно технической сводки: четыре раза в секунду читается глазом и не дёргает React. */
const DEV_INFO_INTERVAL_MS = 250;

/** Сколько тиков за раз можно прошагать на паузе — десять секунд забега. */
const MAX_DEV_STEP_TICKS = 600;

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
  difficultyId: DifficultyId;
  /** чем начинать забег; по умолчанию — первое стартовое оружие контента */
  startingWeaponId?: string;
  /** шина событий наружу: экраны рисует оболочка, движок только сообщает */
  bus: RunBus;
  /** продолжить забег из снимка вместо нового */
  resume?: RunSnapshot;
  /** забег разработчика; без поля команды разработчика не работают */
  dev?: RunDevOptions;
  /** FPS тестировщика — техническая сводка идёт и без режима разработчика */
  fpsOverlay?: boolean;
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
  /** сцена собрана целиком; до этого команды и кадры её не трогают */
  private ready = false;
  /** в забеге включали читы — пометка не снимается до конца забега */
  private cheatsUsed = false;
  private devWindow = { elapsedMs: 0, frames: 0, simMs: 0, steps: 0 };

  constructor() {
    super("main");
  }

  create(data: MainSceneData): void {
    this.sceneData = data;
    const resume = data.resume;
    this.seed = resume?.seed ?? data.seed;
    this.runId = resume?.runId ?? createUuid();
    this.accumulatorMs = 0;
    this.hudTimerMs = 0;
    this.reportedWave = -1;
    this.phase = "running";
    this.ready = false;
    this.cheatsUsed = resume?.cheats === true;
    this.devWindow = { elapsedMs: 0, frames: 0, simMs: 0, steps: 0 };

    const mapId = resume?.mapId ?? data.mapId;
    const difficulty = findDifficulty(resume?.difficultyId ?? data.difficultyId) ?? findDifficulty(DEFAULT_DIFFICULTY_ID);
    const startingWeaponId = resume?.startingWeaponId ?? data.startingWeaponId;
    const map = findMap(mapId) ?? findMap(DEFAULT_MAP_ID) ?? MAPS[0];
    this.world = createWorld({
      seed: this.seed,
      enemies: ENEMIES,
      weapons: WEAPONS,
      passives: PASSIVES,
      levelCurve: LEVEL_CURVE,
      loadoutLimits: LOADOUT_LIMITS,
      drops: DROPS,
      map,
      ...(difficulty === undefined ? {} : { difficulty }),
      ...(startingWeaponId === undefined ? {} : { startingWeaponId }),
      config: { unitScale: data.unitScale },
    });
    this.spawner = createTimelineDirector(TIMELINE, ENDLESS_CURVE);

    // Снимок переносится до рендера и камеры: они строятся уже по
    // продолженному миру, и первый кадр не показывает пустое начало забега.
    if (resume !== undefined && !this.restore(resume)) return;

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

    this.applyDev(data.dev);
    this.ready = true;
    if (resume === undefined) for (const command of data.dev?.start ?? []) this.devCommand(command);
    this.emitHud();
    this.reportWave();
    if (resume !== undefined) this.enterRestored();
  }

  update(_time: number, deltaMs: number): void {
    // Снимок не прочитался: сцена так и не собралась, об ошибке уже сообщено.
    if (!this.ready) return;
    if (this.phase !== "running") {
      // Мир стоит: накопитель сбрасывается, чтобы после возврата не прилетела
      // пачка «догоняющих» шагов, и рисуется последнее состояние без
      // интерполяции. Камера применяется заново — иначе поворот экрана на
      // паузе сдвинул бы мир относительно канвы.
      this.accumulatorMs = 0;
      this.syncCamera();
      this.worldRenderer.sync(0);
      this.trackDevInfo(deltaMs, 0, 0);
      return;
    }

    const input = this.readInput();
    const dev = this.sceneData.dev;

    // Ограничение сверху: после сворачивания приложения дельта прилетает
    // огромная, и без обрезки игрок «телепортируется» на возврате. Скорость
    // времени разработчика умножает реальное время, а не шаг: симуляция
    // по-прежнему идёт фиксированными тиками.
    this.accumulatorMs += Math.min(deltaMs * (dev?.timeScale ?? 1), TICK_MS * MAX_STEPS_PER_FRAME);

    const measure = this.wantsDevInfo();
    const simStartedAt = measure ? performance.now() : 0;
    let steps = 0;
    while (this.accumulatorMs >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
      this.step(input);
      this.accumulatorMs -= TICK_MS;
      steps++;
      if (!this.world.player.alive || isAwaitingChoice(this.world)) break;
    }
    this.trackDevInfo(deltaMs, measure ? performance.now() - simStartedAt : 0, steps);

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
    // Переведи она себя в «бежим» сама, сразу после команды выбора, — затёрла
    // бы уже пришедший следующий выбор из очереди: экран пропадает, а мир
    // остаётся стоять.
    this.sceneData.bus.emit("resumed", { elapsedSec: this.world.stats.elapsedSec });
  }

  restartRun(seed: number): void {
    // «Ещё раз» — новый забег, а не повтор продолженного.
    const next: MainSceneData = { ...this.sceneData, seed };
    delete next.resume;
    this.scene.restart(next);
  }

  /**
   * Настройки режима разработчика на ходу. Забег, начатый без режима, так и
   * остаётся обычным: включить читы посреди честного забега нельзя.
   */
  setDev(options: RunDevOptions): void {
    if (this.sceneData.dev === undefined) return;
    this.sceneData.dev = options;
    if (this.ready) this.applyDev(options);
  }

  /** Разовое действие разработчика — между кадрами, то есть на границе тика. */
  devCommand(command: RunDevCommand): void {
    if (!this.ready || this.sceneData.dev === undefined || this.phase === "dead") return;

    if (command.kind === "stepTicks") {
      this.stepOnPause(command.ticks);
      return;
    }

    const outcome = applyDevCommand(this.world, command);
    if (!outcome.applied) return;
    if (outcome.cheat) this.cheatsUsed = true;
    this.worldRenderer.sync(0);
    this.emitHud();
    this.reportWave();
    if (isAwaitingChoice(this.world)) this.enterChoice();
  }

  /** Характеристики забега для листа «Характеристики». */
  inspect(): RunInspection | null {
    return this.ready ? inspectWorld(this.world) : null;
  }

  /**
   * Снимок для продолжения забега. Мёртвый забег продолжать нечего, а на
   * выборе улучшения снимок годится: варианты сохраняются вместе с миром.
   */
  captureSnapshot(): RunSnapshot | null {
    if (!this.ready || this.phase === "dead") return null;
    const world = this.world;
    return {
      format: RUN_SNAPSHOT_FORMAT,
      contentHash: CONTENT_HASH,
      runId: this.runId,
      seed: this.seed,
      mapId: world.mapId,
      difficultyId: world.difficultyLevel.id,
      startingWeaponId: this.startingWeaponId(),
      summary: {
        survivalSec: world.stats.elapsedSec,
        level: world.progression.level,
        weapons: this.slotsOf("weapons"),
        passives: this.slotsOf("passives"),
      },
      world: captureWorld(world, this.spawner),
      ...(this.cheatsUsed ? { cheats: true } : {}),
    };
  }

  // --- Внутреннее -----------------------------------------------------------

  /** Один тик: директор спавна и шаг мира. Пауза спавна разработчика — пропуск директора. */
  private step(input: SimInput): void {
    if (this.sceneData.dev?.cheats.spawnPaused !== true) this.spawner.update(this.world, TICK_SEC);
    stepWorld(this.world, input);
  }

  private applyDev(options: RunDevOptions | undefined): void {
    if (options === undefined) return;
    const world = this.world;
    world.cheats.godMode = options.cheats.godMode;
    world.cheats.oneHitKill = options.cheats.oneHitKill;
    world.cheats.damageMul = options.cheats.damageMul;
    world.cheats.moveSpeedMul = options.cheats.moveSpeedMul;
    world.cheats.freezeEnemies = options.cheats.freezeEnemies;
    // Замедление времени — тоже преимущество: на четверти скорости от толпы
    // уворачивается кто угодно. Пауза спавна — тем более.
    if (hasActiveCheats(world.cheats) || options.cheats.spawnPaused || options.timeScale !== 1) {
      this.cheatsUsed = true;
    }
    this.worldRenderer.setDevVisuals(options.visuals);
  }

  /** Шаги на паузе: разглядеть телеграф или столкновение потиково. */
  private stepOnPause(ticks: number): void {
    if (this.phase !== "paused") return;
    const count = Math.max(1, Math.min(MAX_DEV_STEP_TICKS, Math.round(ticks)));
    for (let i = 0; i < count; i++) {
      this.step(IDLE_INPUT);
      if (!this.world.player.alive || isAwaitingChoice(this.world)) break;
    }
    this.worldRenderer.sync(1);
    this.emitHud();
    this.reportWave();
    if (!this.world.player.alive) {
      this.finishRun("died");
      return;
    }
    if (isAwaitingChoice(this.world)) this.enterChoice();
  }

  private wantsDevInfo(): boolean {
    return this.sceneData.fpsOverlay === true || this.sceneData.dev?.visuals.techInfo === true;
  }

  private trackDevInfo(deltaMs: number, simMs: number, steps: number): void {
    if (!this.wantsDevInfo()) return;
    const window = this.devWindow;
    window.elapsedMs += deltaMs;
    window.frames++;
    window.simMs += simMs;
    window.steps += steps;
    if (window.elapsedMs < DEV_INFO_INTERVAL_MS) return;

    const world = this.world;
    const scale = world.config.unitScale;
    this.sceneData.bus.emit("devInfo", {
      fps: (window.frames * 1000) / window.elapsedMs,
      frameMs: window.elapsedMs / window.frames,
      simMs: window.steps > 0 ? window.simMs / window.steps : 0,
      stepsPerFrame: window.steps / window.frames,
      tick: world.stats.tick,
      elapsedSec: world.stats.elapsedSec,
      seed: this.seed,
      enemies: world.enemies.aliveCount,
      projectiles: world.projectiles.aliveCount,
      gems: world.gems.aliveCount,
      pickups: countAlive(world.pickups.alive),
      segment: world.difficulty.segment,
      hpMul: world.difficulty.hpMul,
      damageMul: world.difficulty.damageMul,
      maxAlive: world.difficulty.maxAlive,
      zoom: this.runCamera.zoom / scale,
      playerX: world.player.x / scale,
      playerY: world.player.y / scale,
      timeScale: this.sceneData.dev?.timeScale ?? 1,
      cheats: this.cheatsUsed,
    });
    this.devWindow = { elapsedMs: 0, frames: 0, simMs: 0, steps: 0 };
  }

  /**
   * Перенести снимок в только что созданный мир. Снимок с другим контентом
   * или форматом не продолжается: оболочка это проверяет и сама, здесь —
   * последний рубеж, чтобы чужие числа не попали в мир.
   */
  private restore(snapshot: RunSnapshot): boolean {
    try {
      if (snapshot.format !== RUN_SNAPSHOT_FORMAT) {
        throw new SnapshotError(`формат ${snapshot.format}, ожидался ${RUN_SNAPSHOT_FORMAT}`);
      }
      if (snapshot.contentHash !== CONTENT_HASH) {
        throw new SnapshotError("снят на другой версии контента");
      }
      restoreWorld(this.world, this.spawner, snapshot.world);
      return true;
    } catch (error: unknown) {
      this.phase = "dead";
      this.sceneData.bus.emit("error", { message: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /**
   * Продолженный забег не бежит сразу: игрок только что открыл приложение, и
   * враги не должны нападать, пока он ищет палец для джойстика.
   */
  private enterRestored(): void {
    if (isAwaitingChoice(this.world)) {
      this.enterChoice();
      return;
    }
    this.pauseRun("restored");
  }

  private slotsOf(kind: "weapons" | "passives"): { id: string; level: number }[] {
    const world = this.world;
    return kind === "weapons"
      ? world.loadout.weapons.map((slot) => ({ id: world.weaponTypes[slot.typeIndex].id, level: slot.level }))
      : world.loadout.passives.map((slot) => ({ id: world.passiveTypes[slot.typeIndex].id, level: slot.level }));
  }

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
      cheats: this.cheatsUsed,
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
      weapons: this.slotsOf("weapons"),
      passives: this.slotsOf("passives"),
      distance: world.stats.distance,
      radar: buildRadarSnapshot(world),
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

function countAlive(alive: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < alive.length; i++) count += alive[i];
  return count;
}
