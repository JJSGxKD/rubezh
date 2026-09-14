/**
 * Сбор метрик кадра для FPS-испытаний (docs/25-week1-fps-trials.md).
 *
 * Почему не `game.loop.actualFps` и не второй аргумент `update()`: первое —
 * сглаженное среднее, второе Phaser сглаживает по истории и обрезает сверху,
 * чтобы логика не «прыгала» после подвисания. В обоих случаях фриз, ради
 * поиска которого всё затевалось, в цифре не появляется. Поэтому стенд пишет
 * сырое время каждого кадра и считает по нему перцентили.
 *
 * Вместе с каждым кадром пишется текущая нагрузка — число живых врагов.
 * Это то, что превращает замер из «тянет / не тянет» в ответ на вопрос
 * «до какой нагрузки тянет», а его уже можно сравнивать между устройствами.
 *
 * Модуль не знает про Phaser и DOM: его можно прогнать в тестах на
 * синтетическом наборе кадров и проверить, что метрики считаются как задумано.
 */

/** Схема отчёта. Меняется формат — растёт версия, старые прогоны остаются читаемыми. */
export const BENCH_REPORT_SCHEMA = "rubezh.bench.v4";

/** 60 кадров/с × 10 минут — с запасом на самый долгий прогон протокола. */
const DEFAULT_CAPACITY = 36_000;
/** Окно для поиска теплового троттлинга. */
const DEFAULT_WINDOW_SEC = 30;
/** Корзина таймлайна: достаточно мелкая, чтобы поймать момент перелома. */
const DEFAULT_BUCKET_SEC = 5;

/**
 * Режим прогона.
 *
 * `fixed` — постоянная популяция, для сравнения двух сборок на одном числе.
 * `ramp` — плавный рост, ищет рабочий запас на трёхминутном прогоне.
 * `stress` — агрессивный рост до отказа, ищет предел устройства и
 * останавливается сам, как только просадка подтверждена.
 */
export type BenchMode = "ramp" | "fixed" | "stress";

/** Почему прогон закончился. Для `stress` это главная строка отчёта. */
export type BenchStopReason =
  | "duration"
  | "degradation"
  | "pool_exhausted"
  | "manual";

export interface FrameStats {
  frames: number;
  durationSec: number;
  avgFps: number;
  /** FPS по самому долгому кадру — сколько было в худший момент */
  minFps: number;
  p50FrameMs: number;
  p95FrameMs: number;
  p99FrameMs: number;
  /** доля кадров дольше 33 мс — заметные глазу рывки */
  over33Ratio: number;
}

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
  /** для fixed — целевая популяция; для ramp — потолок роста */
  targetPopulation: number;
  /** прирост нагрузки в секунду, только для ramp */
  addPerSecond: number | null;
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
 * `starting` — стартовое оружие без кристаллов и подборов, профиль замеров
 * этапа 1; `full` — поздний забег: всё оружие и пассивки на максимуме, элиты,
 * кристаллы и подборы (`bench/full-load.ts`).
 */
export type BenchLoadout = "starting" | "full";

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
      ...summarize(this.frameMs.subarray(slice.from, slice.to)),
      avgLoad: average(this.loads.subarray(slice.from, slice.to)),
      maxLoad: maximum(this.loads.subarray(slice.from, slice.to)),
      avgProjectiles: average(this.projectileLoads.subarray(slice.from, slice.to)),
    }));
  }

  /**
   * Таймлайн: короткие корзины, по которым видно, на какой именно нагрузке
   * начинается просадка. Ради этого вопроса режим ramp и существует.
   */
  buildTimeline(): TimelineBucket[] {
    return this.split(this.bucketSec).map((slice, index) => ({
      index,
      startSec: slice.startSec,
      ...summarize(this.frameMs.subarray(slice.from, slice.to)),
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
        ...summarize(frames),
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

function summarize(frames: Float32Array): FrameStats {
  if (frames.length === 0) {
    return {
      frames: 0,
      durationSec: 0,
      avgFps: 0,
      minFps: 0,
      p50FrameMs: 0,
      p95FrameMs: 0,
      p99FrameMs: 0,
      over33Ratio: 0,
    };
  }

  let totalMs = 0;
  let worstFrameMs = 0;
  for (let i = 0; i < frames.length; i++) {
    totalMs += frames[i];
    if (frames[i] > worstFrameMs) worstFrameMs = frames[i];
  }

  const sorted = Float32Array.from(frames).sort();

  return {
    frames: frames.length,
    durationSec: totalMs / 1000,
    avgFps: frames.length / (totalMs / 1000),
    minFps: worstFrameMs > 0 ? 1000 / worstFrameMs : 0,
    p50FrameMs: percentile(sorted, 0.5),
    p95FrameMs: percentile(sorted, 0.95),
    p99FrameMs: percentile(sorted, 0.99),
    over33Ratio: ratioOver(frames, 33),
  };
}

/** Ближайший ранг: без интерполяции — значение перцентиля реально встречалось. */
function percentile(sorted: Float32Array, fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

function ratioOver(frames: Float32Array, thresholdMs: number): number {
  if (frames.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i] > thresholdMs) count++;
  }
  return count / frames.length;
}

function average(values: Float32Array): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i];
  return total / values.length;
}

/**
 * Частота экрана берётся из начала прогона: там нагрузка ещё минимальна, и
 * время кадра упирается в вертикальную синхронизацию, а не в отрисовку.
 * Медиана, а не среднее — чтобы один долгий кадр на старте не сбивал оценку.
 */
function estimateDisplayHz(frames: Float32Array): number {
  if (frames.length === 0) return 0;

  // Первые три секунды при 60 Гц — около 180 кадров; берём с запасом и
  // пропускаем самое начало, где ещё идёт компиляция шейдеров.
  const from = Math.min(30, frames.length - 1);
  const to = Math.min(from + 240, frames.length);
  const sample = Float32Array.from(frames.subarray(from, to)).sort();
  const median = sample[Math.floor(sample.length / 2)];

  return median > 0 ? Math.round(1000 / median) : 0;
}

function maximumSum(first: Float32Array, second: Float32Array): number {
  let best = 0;
  for (let i = 0; i < first.length; i++) {
    const sum = first[i] + second[i];
    if (sum > best) best = sum;
  }
  return best;
}

function maximum(values: Float32Array): number {
  let best = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] > best) best = values[i];
  }
  return best;
}

function degradation(windows: WindowSample[]): number {
  if (windows.length < 2) return 0;
  const first = windows[0].avgFps;
  const last = windows[windows.length - 1].avgFps;
  if (first <= 0) return 0;
  return Math.max(0, (first - last) / first);
}
