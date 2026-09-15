import {
  average,
  estimateDisplayHz,
  maximum,
  maximumSum,
  ratioOver,
  summarizeFrames,
  type FrameStats,
} from "../diagnostics/frame-stats";

/**
 * Буфер кадров стресс-теста (docs/28-diagnostics.md §2.3). Статистика кадров
 * общая с обычным забегом — `diagnostics/frame-stats.ts`.
 *
 * Вместе с каждым кадром пишется текущая нагрузка — число живых врагов.
 * Это то, что превращает замер из «тянет / не тянет» в ответ на вопрос
 * «до какой нагрузки тянет», а его уже можно сравнивать между устройствами.
 *
 * Модуль не знает про Phaser и DOM: его можно прогнать в тестах на
 * синтетическом наборе кадров и проверить, что метрики считаются как задумано.
 */

export type { FrameStats } from "../diagnostics/frame-stats";

/** Схема отчёта. Меняется формат — растёт версия, старые прогоны остаются читаемыми. */
export const BENCH_REPORT_SCHEMA = "rubezh.bench.v4";

/** 60 кадров/с × 10 минут — с запасом на самый долгий прогон протокола. */
const DEFAULT_CAPACITY = 36_000;
/** Окно для поиска теплового троттлинга. */
const DEFAULT_WINDOW_SEC = 30;
/** Корзина таймлайна: достаточно мелкая, чтобы поймать момент перелома. */
const DEFAULT_BUCKET_SEC = 5;

/**
 * Режим прогона. Остался один — `stress`: рост нагрузки до отказа, стенд
 * останавливается сам, как только просадка подтверждена. Режимы этапа 1
 * (`ramp`, `fixed`) удалены за ненадобностью, поле в отчёте осталось, чтобы
 * формат не менялся.
 */
export type BenchMode = "stress";

/** Почему прогон закончился — главная строка отчёта. */
export type BenchStopReason =
  | "duration"
  | "degradation"
  | "pool_exhausted"
  | "manual";

export interface WindowSample extends FrameStats {
  index: number;
  startSec: number;
  avgLoad: number;
  maxLoad: number;
  avgProjectiles: number;
}

export interface TimelineBucket extends FrameStats {
  index: number;
  startSec: number;
  /** средняя нагрузка в корзине — врагов на экране */
  load: number;
  /** снарядов на экране: вторая ось нагрузки, растёт вместе с числом стрелков */
  projectiles: number;
}

export interface BenchTotals extends FrameStats {
  /** доля кадров дольше 20 мс — просадка ниже 50 FPS */
  over20Ratio: number;
  /** падение среднего FPS последнего окна относительно первого, доля */
  degradationRatio: number;
  /**
   * Частота обновления экрана, оценённая по медиане первых секунд прогона.
   *
   * Браузер её не сообщает, а знать надо: на 120-герцовом экране игра рисует
   * вдвое больше кадров в секунду, и «60 FPS» там означает вдвое худший
   * результат, чем на 60-герцовом. Без этой цифры отчёты с разных устройств
   * несопоставимы.
   */
  displayHz: number;
  /** максимальная достигнутая нагрузка */
  peakLoad: number;
  peakProjectiles: number;
  /**
   * Пик суммарного числа объектов — врагов и снарядов вместе.
   *
   * Именно эта цифра отвечает на вопрос «сколько объектов тянет движок»:
   * снаряд стоит рендеру и коллизиям столько же, сколько враг, и считать
   * только врагов значит занижать нагрузку.
   */
  peakObjects: number;
}

export interface BenchProfile {
  mode: BenchMode;
  /** потолок роста нагрузки */
  targetPopulation: number;
  /** прирост нагрузки в секунду */
  addPerSecond: number;
  seed: number;
  durationSec: number;
  buildVersion: string;
  canvasWidth: number;
  canvasHeight: number;
  devicePixelRatio: number;
  renderer: string;
  /** с чем игрок идёт в прогон — от этого зависят снаряды, эффекты и кристаллы */
  loadout: BenchLoadout;
}

/**
 * `full` — поздний забег: всё оружие и пассивки на максимуме, элиты,
 * кристаллы и подборы (`bench/full-load.ts`). Стартовое оружие этапа 1 ушло
 * вместе с его режимами.
 */
export type BenchLoadout = "full";

export interface BenchDevice {
  userAgent: string;
  platform: string;
  hardwareConcurrency: number;
  deviceMemoryGb: number | null;
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
  /** из launch params Telegram: android / ios / tdesktop / weba и версия Bot API */
  telegramPlatform: string | null;
  telegramVersion: string | null;
  telegramUserId: string | null;
  telegramLanguage: string | null;
  telegramIsPremium: boolean | null;
  telegramFullscreen: boolean | null;
}

export interface BenchReport {
  schema: typeof BENCH_REPORT_SCHEMA;
  /** UTC — сервер и логи живут в UTC (CLAUDE.md, «Окружение команды») */
  startedAt: string;
  stoppedBy: BenchStopReason;
  /**
   * Сколько раз приложение сворачивали во время прогона. Больше нуля —
   * к цифрам нужно относиться с подозрением: возврат из фона даёт кадр
   * длиной в секунды, и он портит перцентили.
   */
  interruptions: number;
  profile: BenchProfile;
  device: BenchDevice;
  totals: BenchTotals;
  windows: WindowSample[];
  timeline: TimelineBucket[];
}

/**
 * Кольцевой буфер отключён намеренно: прогон конечен, а потеря начала прогона
 * убила бы главную метрику — деградацию от троттлинга. Если кадры кончились,
 * запись останавливается, и это видно по числу кадров в отчёте.
 */
export class FrameRecorder {
  private readonly frameMs: Float32Array;
  private readonly loads: Float32Array;
  private readonly projectileLoads: Float32Array;
  private readonly windowSec: number;
  private readonly bucketSec: number;
  private frames = 0;
  private overflowed = false;
  private totalMs = 0;

  constructor(
    windowSec = DEFAULT_WINDOW_SEC,
    bucketSec = DEFAULT_BUCKET_SEC,
    capacity = DEFAULT_CAPACITY,
  ) {
    this.windowSec = windowSec;
    this.bucketSec = bucketSec;
    this.frameMs = new Float32Array(capacity);
    this.loads = new Float32Array(capacity);
    this.projectileLoads = new Float32Array(capacity);
  }

  record(frameMs: number, load = 0, projectiles = 0): void {
    if (this.frames >= this.frameMs.length) {
      this.overflowed = true;
      return;
    }
    this.frameMs[this.frames] = frameMs;
    this.loads[this.frames] = load;
    this.projectileLoads[this.frames] = projectiles;
    this.frames++;
    this.totalMs += frameMs;
  }

  get frameCount(): number {
    return this.frames;
  }

  get isOverflowed(): boolean {
    return this.overflowed;
  }

  get elapsedSec(): number {
    return this.totalMs / 1000;
  }

  reset(): void {
    this.frames = 0;
    this.overflowed = false;
    this.totalMs = 0;
  }

  /**
   * Разбивка по окнам — детектор теплового троттлинга: бюджетный Android
   * держит 60 FPS полторы минуты, а потом уходит вниз. Средним по прогону
   * этого не видно.
   */
  buildWindows(): WindowSample[] {
    return this.split(this.windowSec).map((slice, index) => ({
      index,
      startSec: slice.startSec,
      ...summarizeFrames(this.frameMs.subarray(slice.from, slice.to)),
      avgLoad: average(this.loads.subarray(slice.from, slice.to)),
      maxLoad: maximum(this.loads.subarray(slice.from, slice.to)),
      avgProjectiles: average(this.projectileLoads.subarray(slice.from, slice.to)),
    }));
  }

  /**
   * Таймлайн: короткие корзины, по которым видно, на какой именно нагрузке
   * начинается просадка.
   */
  buildTimeline(): TimelineBucket[] {
    return this.split(this.bucketSec).map((slice, index) => ({
      index,
      startSec: slice.startSec,
      ...summarizeFrames(this.frameMs.subarray(slice.from, slice.to)),
      load: average(this.loads.subarray(slice.from, slice.to)),
      projectiles: average(this.projectileLoads.subarray(slice.from, slice.to)),
    }));
  }

  buildReport(
    profile: BenchProfile,
    device: BenchDevice,
    startedAt: string,
    stoppedBy: BenchStopReason,
    interruptions = 0,
  ): BenchReport {
    const frames = this.frameMs.subarray(0, this.frames);
    const loads = this.loads.subarray(0, this.frames);
    const projectiles = this.projectileLoads.subarray(0, this.frames);
    const windows = this.buildWindows();

    return {
      schema: BENCH_REPORT_SCHEMA,
      startedAt,
      stoppedBy,
      interruptions,
      profile,
      device,
      totals: {
        ...summarizeFrames(frames),
        over20Ratio: ratioOver(frames, 20),
        degradationRatio: degradation(windows),
        displayHz: estimateDisplayHz(frames),
        peakLoad: maximum(loads),
        peakProjectiles: maximum(projectiles),
        // Пик суммы, а не сумма пиков: враги и снаряды выходят на максимум
        // в разные моменты, и складывать их максимумы значит завышать.
        peakObjects: maximumSum(loads, projectiles),
      },
      windows,
      timeline: this.buildTimeline(),
    };
  }

  /** Границы срезов по заданной длительности. Общая часть окон и таймлайна. */
  private split(sliceSec: number): { from: number; to: number; startSec: number }[] {
    const sliceMs = sliceSec * 1000;
    const slices: { from: number; to: number; startSec: number }[] = [];

    let cursor = 0;
    let elapsedMs = 0;
    while (cursor < this.frames) {
      let end = cursor;
      let sliceDurationMs = 0;
      while (end < this.frames && sliceDurationMs < sliceMs) {
        sliceDurationMs += this.frameMs[end];
        end++;
      }
      slices.push({ from: cursor, to: end, startSec: elapsedMs / 1000 });
      elapsedMs += sliceDurationMs;
      cursor = end;
    }

    return slices;
  }
}

function degradation(windows: WindowSample[]): number {
  if (windows.length < 2) return 0;
  const first = windows[0].avgFps;
  const last = windows[windows.length - 1].avgFps;
  if (first <= 0) return 0;
  return Math.max(0, (first - last) / first);
}
