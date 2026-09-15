import Phaser from "phaser";
import { DROPS } from "../content/drops";
import { ENEMIES } from "../content/enemies";
import { MAPS } from "../content/maps";
import { PASSIVES } from "../content/upgrades";
import { WEAPONS } from "../content/weapons";
import { createWorld, DEFAULT_SIM_CONFIG, TICK_SEC, type World } from "./sim/world";
import { stepWorld } from "./sim/step";
import { createRampSpawner, rampTargetAt, type RampOptions, type Spawner } from "./sim/spawner";
import { RunCamera } from "./render/run-camera";
import { WorldRenderer } from "./render/WorldRenderer";
import { benchInput } from "./bench/autopilot";
import { FrameRecorder, type BenchStopReason } from "./bench/metrics";
import { FrameClock } from "./diagnostics/frame-clock";
import { watchVisibility } from "../engine/visibility";
import { DegradationDetector } from "./bench/degradation-detector";
import { evaluateBench } from "./bench/verdict";
import { createUuid } from "./uuid";
import { BENCH_RAMP_START, BENCH_STRESS } from "./bench/profiles";
import { BENCH_FULL_LOAD, equipFullLoadout, withEliteWaves } from "./bench/full-load";
import type { BenchSceneData } from "./bench/types";

const TICK_MS = TICK_SEC * 1000;
/** Как часто оболочка получает прогресс: чаще React не перерисовывает HUD (CLAUDE.md). */
const PROGRESS_INTERVAL_MS = 250;
const MAX_STEPS_PER_FRAME = 5;

const RAMP: RampOptions = {
  startPopulation: BENCH_RAMP_START,
  addPerSecond: BENCH_STRESS.addPerSecond,
  maxPopulation: BENCH_STRESS.cap,
};

/**
 * Сцена стресс-теста (docs/28-diagnostics.md §2.3).
 *
 * Отдельная сцена, а не режим MainScene: у прогона свои правила — нагрузка
 * растёт до предела устройства, автопилот вместо живого игрока и бессмертный
 * игрок. Иначе замер зависит от того, как человек играл и когда он умер, и
 * два прогона несравнимы.
 *
 * Своего интерфейса у сцены нет: прогресс и итог уходят в `listener`, а
 * рисует их оболочка поверх канвы.
 */
export class BenchScene extends Phaser.Scene {
  private sceneData!: BenchSceneData;
  private world!: World;
  private spawner!: Spawner;
  private worldRenderer!: WorldRenderer;
  private runCamera!: RunCamera;
  private recorder!: FrameRecorder;
  private detector!: DegradationDetector;
  private running = false;
  private accumulatorMs = 0;
  private tick = 0;
  private startedAt = "";
  private reportId = "";
  /** каким кадрам верить: фон и возврат из него в замер не попадают */
  private readonly clock = new FrameClock();
  private lastProgressAt = 0;

  constructor() {
    super("bench");
  }

  init(data: BenchSceneData): void {
    this.sceneData = data;
  }

  create(): void {
    const scale = this.sceneData.device.devicePixelRatio;

    this.world = createWorld({
      seed: this.sceneData.seed,
      enemies: ENEMIES,
      weapons: WEAPONS,
      passives: PASSIVES,
      drops: DROPS,
      // Карта та же, что в игре: радиус кольца спавна берётся от неё, а не от
      // размера канвы, — значит замеры двух устройств сравнимы по объёму мира,
      // а не только по числу врагов (WP4.3).
      map: MAPS[0],
      config: {
        unitScale: scale,
        // Сила игрока по ходу прогона не растёт — он уже на максимуме, — а
        // кристаллы и подборы остаются: в позднем забеге их сотни на экране.
        progressionEnabled: false,
        lootEnabled: true,
        // Пулы на тысячи: прогон обязан упереться в устройство, а не в размер массива.
        maxEnemies: BENCH_STRESS.maxEnemies,
        maxProjectiles: BENCH_STRESS.maxProjectiles,
        // Бессмертный игрок: прогон должен мерить установившуюся нагрузку.
        // Если игрок умирает на тридцатой секунде, дальше меряется мир без
        // выстрелов — то есть не тот мир, ради которого прогон затевался.
        player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 1_000_000 },
      },
    });
    equipFullLoadout(this.world);
    this.spawner = withEliteWaves(createRampSpawner(RAMP, BENCH_FULL_LOAD.weights), BENCH_FULL_LOAD);
    this.worldRenderer = new WorldRenderer(this, this.world);
    this.runCamera = new RunCamera(MAPS[0].camera, scale);
    this.runCamera.snapTo(this.world, this.scale.width, this.scale.height);
    this.recorder = new FrameRecorder();
    this.detector = new DegradationDetector();
    // Единственное обращение ко времени за весь стенд — метка старта для
    // отчёта. В симуляции часов нет и быть не может.
    this.startedAt = new Date().toISOString();
    this.reportId = createUuid();

    this.cameras.main.setBackgroundColor("#0d0f14");
    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    const stopWatching = watchVisibility(this.clock);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
      stopWatching();
    });

    this.running = true;
  }

  update(time: number, deltaMs: number): void {
    if (this.running) {
      const rawFrameMs = this.clock.frame(time, deltaMs);
      if (rawFrameMs !== null) {
        this.recorder.record(rawFrameMs, this.world.enemies.aliveCount, this.world.projectiles.aliveCount);

        this.accumulatorMs += Math.min(deltaMs, TICK_MS * MAX_STEPS_PER_FRAME);
        let steps = 0;
        while (this.accumulatorMs >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
          this.spawner.update(this.world, TICK_SEC);
          stepWorld(this.world, benchInput(this.tick));
          this.accumulatorMs -= TICK_MS;
          this.tick++;
          steps++;
        }

        this.checkStopConditions(rawFrameMs);
      } else {
        // Накопленное время сбрасывается: иначе после возврата из фона
        // симуляция рванёт догонять и выдаст всплеск, который тоже попадёт
        // в замер.
        this.accumulatorMs = 0;
      }
    }

    // Камера стенда — та же, что в игре: иначе замер шёл бы на картинке,
    // которой в забеге не бывает, и его нечем было бы подтвердить.
    this.runCamera.update(this.world, deltaMs / 1000);
    this.worldRenderer.applyCamera(this.runCamera.x, this.runCamera.y, this.runCamera.zoom);
    this.worldRenderer.sync(this.accumulatorMs / TICK_MS);
    this.emitProgress(time);
  }

  /** Остановить прогон из оболочки: отчёт собирается по уже снятым кадрам. */
  stopRun(): void {
    this.finish("manual");
  }

  private emitProgress(time: number): void {
    // Итоговый прогресс уходит всегда: иначе последняя цифра на экране
    // оболочки отстанет от отчёта на четверть секунды.
    if (this.running && time - this.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    if (!this.running && this.lastProgressAt < 0) return;
    this.lastProgressAt = this.running ? time : -1;

    const timeline = this.recorder.buildTimeline();
    const current = timeline[timeline.length - 1];
    const enemies = this.world.enemies.aliveCount;
    const projectiles = this.world.projectiles.aliveCount;
    this.sceneData.listener.progress({
      elapsedSec: this.recorder.elapsedSec,
      durationSec: BENCH_STRESS.durationSec,
      running: this.running,
      enemies,
      projectiles,
      gems: this.world.gems.aliveCount,
      objects: enemies + projectiles,
      targetEnemies: rampTargetAt(RAMP, this.world.stats.elapsedSec),
      fps: current === undefined ? null : current.avgFps,
      p95FrameMs: current === undefined ? null : current.p95FrameMs,
      badWindows: this.detector.badWindows,
      interruptions: this.clock.interruptions,
    });
  }

  private checkStopConditions(rawFrameMs: number): void {
    // Порядок проверок — по убыванию значимости результата. Остановка по
    // просадке это найденный предел устройства, остановка по потолку — упёрлись
    // в собственное ограничение стенда, а по таймеру — предел не найден.
    if (this.detector.observe(rawFrameMs)) {
      this.finish("degradation");
      return;
    }

    // Дальше потолка нагрузка не растёт, и держать прогон на месте
    // бессмысленно: это уже не поиск предела, а тепловой тест.
    // Останавливаемся и честно пишем, что упёрлись в стенд.
    if (this.world.enemies.aliveCount >= RAMP.maxPopulation) {
      this.finish("pool_exhausted");
      return;
    }

    if (this.recorder.elapsedSec >= BENCH_STRESS.durationSec) this.finish("duration");
  }

  private handleResize(): void {
    this.runCamera.resize(this.scale.width, this.scale.height);
  }

  private finish(reason: BenchStopReason): void {
    if (!this.running) return;
    this.running = false;

    const report = this.recorder.buildReport(
      {
        mode: "stress",
        targetPopulation: RAMP.maxPopulation,
        addPerSecond: RAMP.addPerSecond,
        seed: this.sceneData.seed,
        durationSec: BENCH_STRESS.durationSec,
        buildVersion: this.sceneData.buildVersion,
        canvasWidth: this.scale.width,
        canvasHeight: this.scale.height,
        devicePixelRatio: this.sceneData.device.devicePixelRatio,
        renderer: this.game.renderer.type === Phaser.WEBGL ? "WEBGL" : "CANVAS",
        loadout: "full",
      },
      this.sceneData.device,
      this.startedAt,
      reason,
      this.clock.interruptions,
    );

    // Отправку и показ итога ведёт оболочка: она знает игрока и сервер.
    this.sceneData.listener.finished({ reportId: this.reportId, report, verdict: evaluateBench(report) });
  }
}
