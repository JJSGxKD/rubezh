import Phaser from "phaser";
import { ENEMIES } from "../content/enemies";
import { MAPS } from "../content/maps";
import { WEAPONS } from "../content/weapons";
import { createWorld, DEFAULT_SIM_CONFIG, TICK_SEC, type World } from "./sim/world";
import { stepWorld } from "./sim/step";
import {
  createConstantPopulationSpawner,
  createRampSpawner,
  rampTargetAt,
  type RampOptions,
  type Spawner,
} from "./sim/spawner";
import { RunCamera } from "./render/run-camera";
import { WorldRenderer } from "./render/WorldRenderer";
import { benchInput } from "./bench/autopilot";
import { FrameRecorder, type BenchReport, type BenchStopReason } from "./bench/metrics";
import { DegradationDetector } from "./bench/degradation-detector";
import { evaluateBench, type BenchVerdict } from "./bench/verdict";
import { sendBenchReport } from "./bench/sender";
import { createUuid } from "./uuid";
import { copyText, showReportOverlay } from "./bench/clipboard";
import {
  BENCH_DEFAULT_RAMP_CAP,
  BENCH_POPULATIONS,
  BENCH_RAMP_START,
  BENCH_STRESS,
} from "./bench/profiles";
import type { BenchSceneData, BenchSubmission } from "./bench/types";

const TICK_MS = TICK_SEC * 1000;

const MODE_LABELS: Record<BenchSceneData["mode"], string> = {
  ramp: "нарастающая нагрузка",
  fixed: "фиксированная нагрузка",
  stress: "агрессивный прогон до предела",
};

/**
 * Русская форма числительного. Строка «21 объектов» на экране выглядит как
 * недоделка, а этот текст видит вся команда после каждого прогона.
 */
function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${count} ${many}`;
  if (mod10 === 1) return `${count} ${one}`;
  if (mod10 >= 2 && mod10 <= 4) return `${count} ${few}`;
  return `${count} ${many}`;
}

const STOP_LABELS: Record<BenchStopReason, string> = {
  duration: "по таймеру, предел не найден",
  degradation: "по подтверждённой просадке",
  pool_exhausted: "упёрлись в размер пула стенда",
  manual: "вручную",
};
const MAX_STEPS_PER_FRAME = 5;

/**
 * Стресс-стенд для FPS-испытаний (docs/25-week1-fps-trials.md).
 *
 * Отдельная сцена, а не режим MainScene: у прогона свои правила — заданная
 * извне нагрузка, автопилот вместо живого игрока и бессмертный игрок. Иначе
 * замер зависит от того, как человек играл и когда он умер, и два прогона
 * несравнимы.
 */
export class BenchScene extends Phaser.Scene {
  private sceneData!: BenchSceneData;
  private world!: World;
  private spawner!: Spawner;
  private worldRenderer!: WorldRenderer;
  private runCamera!: RunCamera;
  private recorder!: FrameRecorder;
  /** живёт только в агрессивном режиме — в остальных прогон идёт до конца */
  private detector: DegradationDetector | null = null;
  private hud!: Phaser.GameObjects.Text;
  private summary!: Phaser.GameObjects.Text;
  private buttons: Phaser.GameObjects.Text[] = [];
  private running = false;
  private accumulatorMs = 0;
  private tick = 0;
  private lastTimestamp = 0;
  private startedAt = "";
  private reportId = "";
  private report: BenchReport | null = null;
  private verdict: BenchVerdict | null = null;
  private sendStatus = "";
  private stopReason: BenchStopReason = "duration";
  /** приложение свёрнуто: кадры в этот момент к производительности отношения не имеют */
  private suspended = false;
  /** сколько кадров пропустить после возврата из фона */
  private skipFrames = 0;
  private interruptions = 0;
  private visibilityHandler: (() => void) | null = null;

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
      // Оружие стенду нужно — без атаки меряется мир без снарядов; а вот
      // прокачка выключена: растущая сила игрока по ходу прогона меняет
      // нагрузку, и два замера перестают быть сравнимыми.
      weapons: WEAPONS,
      // Карта та же, что в игре: радиус кольца спавна теперь берётся от неё, а
      // не от размера канвы, — значит замеры двух устройств наконец сравнимы
      // по объёму мира, а не только по числу врагов (WP4.3).
      map: MAPS[0],
      config: {
        unitScale: scale,
        progressionEnabled: false,
        // В агрессивном режиме пулы на тысячи: прогон обязан упереться в
        // устройство, а не в размер массива.
        ...(this.sceneData.mode === "stress"
          ? { maxEnemies: BENCH_STRESS.maxEnemies, maxProjectiles: BENCH_STRESS.maxProjectiles }
          : {}),
        // Бессмертный игрок: прогон должен мерить установившуюся нагрузку.
        // Если игрок умирает на тридцатой секунде, дальше меряется мир без
        // выстрелов — то есть не тот мир, ради которого прогон затевался.
        player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 1_000_000 },
      },
    });
    this.spawner = this.createSpawner();
    this.worldRenderer = new WorldRenderer(this, this.world);
    this.runCamera = new RunCamera(MAPS[0].camera, scale);
    this.runCamera.snapTo(this.world, this.scale.width, this.scale.height);
    this.recorder = new FrameRecorder();
    this.detector = this.sceneData.mode === "stress" ? new DegradationDetector() : null;
    // Единственное обращение ко времени за весь стенд — метка старта для
    // отчёта. В симуляции часов нет и быть не может.
    this.startedAt = new Date().toISOString();
    this.reportId = createUuid();

    this.cameras.main.setBackgroundColor("#0d0f14");
    this.hud = this.add.text(0, 0, "", this.textStyle(16, "#cfd6e4")).setDepth(10);
    this.summary = this.add.text(0, 0, "", this.textStyle(14, "#ffe066")).setDepth(10);
    this.buildControls();
    this.layout();

    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.watchVisibility();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
      if (this.visibilityHandler !== null) {
        document.removeEventListener("visibilitychange", this.visibilityHandler);
      }
    });

    this.running = true;
  }

  update(time: number, deltaMs: number): void {
    if (this.running) {
      // Второй аргумент update() Phaser сглаживает и обрезает сверху — по нему
      // фризы не видны вовсе, а именно они решают вопрос играбельности.
      // Меряем по сырым меткам времени кадра.
      const rawFrameMs = this.lastTimestamp === 0 ? deltaMs : time - this.lastTimestamp;
      this.lastTimestamp = time;

      if (this.isFrameTrustworthy()) {
        this.recorder.record(
          rawFrameMs,
          this.world.enemies.aliveCount,
          this.world.projectiles.aliveCount,
        );

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
    this.updateHud();
  }

  /**
   * Кадр годится для замера, только если приложение на экране.
   *
   * Возврат из фона даёт один кадр длиной в секунды: детектор видит в нём
   * обвал и останавливает прогон, а перцентили и минимальный FPS оказываются
   * испорчены. Это уже случалось на живом прогоне — результат пришлось
   * выбросить. Поэтому кадры в фоне и первые кадры после возврата не
   * записываются вовсе.
   */
  private isFrameTrustworthy(): boolean {
    if (this.suspended) return false;
    if (this.skipFrames > 0) {
      this.skipFrames--;
      return false;
    }
    return true;
  }

  private checkStopConditions(rawFrameMs: number): void {
    // Порядок проверок — по убыванию значимости результата. Остановка по
    // просадке это найденный предел устройства, остановка по потолку — упёрлись
    // в собственное ограничение стенда, а по таймеру — предел не найден.
    if (this.detector?.observe(rawFrameMs) === true) {
      this.finish("degradation");
      return;
    }

    // В агрессивном режиме дальше потолка нагрузка не растёт, и держать
    // прогон на месте бессмысленно: это уже не поиск предела, а тепловой
    // тест. Останавливаемся и честно пишем, что упёрлись в стенд.
    if (
      this.sceneData.mode === "stress" &&
      this.world.enemies.aliveCount >= this.rampOptions().maxPopulation
    ) {
      this.finish("pool_exhausted");
      return;
    }

    if (this.recorder.elapsedSec >= this.durationSec) this.finish("duration");
  }

  private watchVisibility(): void {
    if (typeof document === "undefined") return;

    this.visibilityHandler = (): void => {
      if (document.hidden) {
        this.suspended = true;
        return;
      }
      this.suspended = false;
      // Первые кадры после возврата ещё содержат хвост простоя, поэтому
      // пропускаем не один, а несколько.
      this.skipFrames = 3;
      this.lastTimestamp = 0;
      this.interruptions++;
    };

    document.addEventListener("visibilitychange", this.visibilityHandler);
  }

  private createSpawner(): Spawner {
    if (this.sceneData.mode === "fixed") {
      return createConstantPopulationSpawner(this.sceneData.population);
    }
    if (this.sceneData.mode === "stress") {
      return createRampSpawner(this.rampOptions(), BENCH_STRESS.weights);
    }
    return createRampSpawner(this.rampOptions());
  }

  private rampOptions(): RampOptions {
    if (this.sceneData.mode === "stress") {
      return {
        startPopulation: BENCH_RAMP_START,
        addPerSecond: BENCH_STRESS.addPerSecond,
        maxPopulation: BENCH_STRESS.cap,
      };
    }

    return {
      startPopulation: BENCH_RAMP_START,
      addPerSecond: this.sceneData.addPerSecond,
      // Потолок ниже стартовой популяции означал бы, что нагрузка не растёт
      // вовсе — а именно так и вышло, когда режим переключали кнопкой после
      // фиксированного профиля на сотню.
      maxPopulation: Math.max(this.sceneData.population, BENCH_RAMP_START * 2),
    };
  }

  private get durationSec(): number {
    return this.sceneData.mode === "stress"
      ? BENCH_STRESS.durationSec
      : this.sceneData.durationSec;
  }

  private finish(reason: BenchStopReason): void {
    if (!this.running) return;
    this.running = false;
    this.stopReason = reason;

    this.report = this.recorder.buildReport(
      {
        mode: this.sceneData.mode,
        targetPopulation: this.rampOptions().maxPopulation,
        addPerSecond: this.sceneData.mode === "fixed" ? null : this.rampOptions().addPerSecond,
        seed: this.sceneData.seed,
        durationSec: this.durationSec,
        buildVersion: this.sceneData.buildVersion,
        canvasWidth: this.scale.width,
        canvasHeight: this.scale.height,
        devicePixelRatio: this.sceneData.device.devicePixelRatio,
        renderer: this.game.renderer.type === Phaser.WEBGL ? "WEBGL" : "CANVAS",
      },
      this.sceneData.device,
      this.startedAt,
      this.stopReason,
      this.interruptions,
    );
    this.verdict = evaluateBench(this.report);

    this.renderSummary();
    // Отправляем сами: человек с телефоном в руках не должен копировать
    // JSON руками — на это уходит время и часть отчётов теряется.
    void this.submit();
  }

  private async submit(): Promise<void> {
    const submission = this.submission();
    if (submission === null) return;

    if (this.sceneData.ingest === null) {
      this.sendStatus = "Приёмник отчётов не настроен";
      this.renderSummary();
      return;
    }

    this.sendStatus = "Отправляю отчёт…";
    this.renderSummary();

    const result = await sendBenchReport(this.sceneData.ingest, submission);
    this.sendStatus = result.message;
    this.renderSummary();
  }

  private submission(): BenchSubmission | null {
    if (this.report === null || this.verdict === null) return null;
    return { reportId: this.reportId, report: this.report, verdict: this.verdict };
  }

  private renderSummary(): void {
    if (this.report === null || this.verdict === null) return;

    const totals = this.report.totals;
    const breaking = this.verdict.breakingPoint;
    const isStress = this.sceneData.mode === "stress";

    const lines = isStress
      ? [
          `ПРЕДЕЛ: ${plural(Math.round(totals.peakObjects), "объект", "объекта", "объектов")}`,
          `— врагов ${Math.round(totals.peakLoad)}, снарядов ${Math.round(totals.peakProjectiles)}`,
          `Остановлен: ${STOP_LABELS[this.report.stoppedBy]}`,
        ]
      : [
          `ВЕРДИКТ: ${this.verdict.level.toUpperCase()}`,
          `Держит нагрузку: ${plural(this.verdict.sustainedLoad, "враг", "врага", "врагов")}`,
          `Остановлен: ${STOP_LABELS[this.report.stoppedBy]}`,
        ];

    lines.push(
      breaking === null
        ? "Порог не пробит до конца прогона"
        : `Просадка на ${breaking.load.toFixed(0)} врагах (${breaking.atSec.toFixed(0)} с): FPS ${breaking.avgFps.toFixed(1)}, p95 ${breaking.p95FrameMs.toFixed(1)} мс`,
      `Экран ${totals.displayHz} Гц | средний FPS ${totals.avgFps.toFixed(1)}, минимальный ${totals.minFps.toFixed(1)}`,
      `p95 ${totals.p95FrameMs.toFixed(1)} мс, кадров > 33 мс: ${(totals.over33Ratio * 100).toFixed(2)}%`,
      `Деградация к концу: ${(totals.degradationRatio * 100).toFixed(1)}%`,
      ...(isStress ? [] : this.verdict.failures),
      // Прерывания показываются всегда, когда были: без этой строки цифры
      // выглядят достоверными, а они испорчены.
      this.report.interruptions > 0
        ? `Прогон прерывался ${this.report.interruptions} раз — сворачивание приложения`
        : "",
      this.sendStatus,
    );

    this.summary.setText(lines.filter((line) => line !== "").join("\n"));
    this.layout();
  }

  private updateHud(): void {
    const elapsed = this.recorder.elapsedSec;
    const timeline = this.recorder.buildTimeline();
    const current = timeline[timeline.length - 1];
    const enemies = this.world.enemies.aliveCount;
    const projectiles = this.world.projectiles.aliveCount;
    const target =
      this.sceneData.mode === "fixed"
        ? this.sceneData.population
        : rampTargetAt(this.rampOptions(), this.world.stats.elapsedSec);

    const targetLabel =
      this.sceneData.mode === "fixed"
        ? `${target}`
        : `${target} (потолок ${this.rampOptions().maxPopulation}, +${this.rampOptions().addPerSecond}/с)`;

    const lines = [
      `Режим: ${MODE_LABELS[this.sceneData.mode]} | seed ${this.sceneData.seed}`,
      `Прогон: ${elapsed.toFixed(1)} / ${this.durationSec} с${this.running ? "" : " — завершён"}`,
      `Врагов: ${enemies} из ${targetLabel}`,
      `Снарядов: ${projectiles} | объектов всего: ${enemies + projectiles}`,
      `Сейчас: FPS ${current ? current.avgFps.toFixed(1) : "—"}, p95 ${current ? current.p95FrameMs.toFixed(1) : "—"} мс`,
    ];

    // Счётчик плохих окон показывается прямо на экране: видно, что стенд
    // засёк просадку и вот-вот остановится, а не завис.
    if (this.detector !== null && this.detector.badWindows > 0 && this.running) {
      lines.push(`Просадка: ${this.detector.badWindows} с подряд`);
    }

    this.hud.setText(lines.join("\n"));
  }

  private buildControls(): void {
    // Каждая кнопка задаёт режим И нагрузку. Раньше «Ramp» меняла только
    // режим, наследуя популяцию от предыдущего профиля: после нажатия «100»
    // нарастающий прогон упирался в потолок 100 и переставал нарастать.
    this.addButton("Ramp", () =>
      this.restart({ mode: "ramp", population: BENCH_DEFAULT_RAMP_CAP }),
    );
    for (const population of BENCH_POPULATIONS) {
      this.addButton(`${population}`, () => this.restart({ mode: "fixed", population }));
    }
    this.addButton("Стресс", () => this.restart({ mode: "stress" }));
    this.addButton("Стоп", () => this.finish("manual"));
    this.addButton("Отправить", () => void this.submit());
    this.addButton("JSON", () => this.copyReport());
  }

  private addButton(label: string, onClick: () => void): void {
    const scale = this.sceneData.device.devicePixelRatio;
    const button = this.add
      .text(0, 0, label, {
        ...this.textStyle(16, "#0d0f14"),
        backgroundColor: "#6ee7a8",
        padding: { x: 10 * scale, y: 6 * scale },
      })
      .setDepth(10)
      .setInteractive({ useHandCursor: true });

    button.on("pointerdown", onClick);
    this.buttons.push(button);
  }

  private textStyle(sizeUnits: number, color: string): Phaser.Types.GameObjects.Text.TextStyle {
    // Размер шрифта в физических пикселях: канва создаётся в них же, иначе
    // на телефоне с высокой плотностью текст выходит мелким и мыльным.
    return {
      fontFamily: "monospace",
      fontSize: `${Math.round(sizeUnits * this.sceneData.device.devicePixelRatio)}px`,
      color,
    };
  }

  private handleResize(): void {
    this.runCamera.resize(this.scale.width, this.scale.height);
    this.layout();
  }

  /**
   * Раскладка пересчитывается от текущего размера канвы, а не запоминается
   * при создании: иначе после поворота экрана или изменения окна кнопки
   * остаются за краем и стенд становится неуправляемым.
   */
  private layout(): void {
    const scale = this.sceneData.device.devicePixelRatio;
    const margin = 12 * scale;
    const gap = 8 * scale;

    this.hud.setPosition(margin, margin);

    // Кнопки переносятся на следующий ряд, когда не помещаются по ширине:
    // на узком экране телефона в один ряд они не влезают.
    const rows: Phaser.GameObjects.Text[][] = [[]];
    let x = margin;
    for (const button of this.buttons) {
      const row = rows[rows.length - 1];
      if (row.length > 0 && x + button.width > this.scale.width - margin) {
        rows.push([button]);
        x = margin + button.width + gap;
        continue;
      }
      row.push(button);
      x += button.width + gap;
    }

    const rowHeight = this.buttons.length > 0 ? this.buttons[0].height + gap : 0;
    const buttonsTop = this.scale.height - margin - rows.length * rowHeight + gap;

    let top = buttonsTop;
    for (const row of rows) {
      let rowX = margin;
      for (const button of row) {
        button.setPosition(rowX, top);
        rowX += button.width + gap;
      }
      top += rowHeight;
    }

    this.summary.setWordWrapWidth(this.scale.width - margin * 2);
    this.summary.setPosition(margin, buttonsTop - gap - this.summary.height);
  }

  private restart(overrides: Partial<BenchSceneData>): void {
    this.scene.restart({ ...this.sceneData, ...overrides });
  }

  /**
   * Запасной путь на случай, когда приёмник недоступен: отчёт уходит в буфер
   * обмена, а если и он закрыт — показывается поверх канвы, чтобы
   * трёхминутный прогон не пропал впустую.
   */
  private copyReport(): void {
    if (this.report === null) this.finish("manual");
    const submission = this.submission();
    if (submission === null) return;

    const json = JSON.stringify(submission, null, 2);

    void copyText(json).then((result) => {
      this.sendStatus = result.message;
      this.renderSummary();
      if (!result.ok) showReportOverlay(json);
    });
  }
}
