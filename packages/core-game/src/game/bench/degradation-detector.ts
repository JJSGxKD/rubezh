/**
 * Живой детектор просадки для агрессивного прогона.
 *
 * В режиме `stress` нагрузка растёт до отказа, и досидеть до конца таймера
 * бессмысленно: как только устройство перестало справляться, дальше меряется
 * не производительность, а мучение. Детектор смотрит на кадры по ходу прогона
 * и говорит, когда пора останавливаться и фиксировать результат.
 *
 * Главная сложность — отличить настоящий отказ от одиночного фриза. Пауза
 * сборщика мусора, подгрузка текстуры, уведомление в шторке дают один плохой
 * кадр, и остановить прогон на нём значит записать случайное число как предел
 * устройства. Поэтому просадка засчитывается только когда она держится
 * несколько секунд подряд.
 *
 * Модуль не знает ни про Phaser, ни про DOM: он принимает время кадра и
 * проверяется тестами на синтетическом наборе.
 */

export interface DegradationOptions {
  /** длина окна наблюдения */
  windowSec: number;
  /** ниже этого FPS окно считается плохим */
  minAvgFps: number;
  /** и/или выше этого p95 времени кадра */
  maxP95FrameMs: number;
  /** сколько плохих окон подряд означают отказ, а не случайный фриз */
  consecutiveWindows: number;
  /**
   * FPS, ниже которого прогон останавливается немедленно, не дожидаясь серии.
   * Это уже не просадка, а обвал: продолжать нечего.
   */
  collapseFps: number;
  /** первые секунды не считаются: компиляция шейдеров и прогрев JIT */
  warmupSec: number;
}

export const DEFAULT_DEGRADATION: DegradationOptions = {
  windowSec: 1,
  minAvgFps: 50,
  maxP95FrameMs: 20,
  consecutiveWindows: 3,
  collapseFps: 20,
  warmupSec: 5,
};

/** Кадров в секунду с запасом — окно наблюдения короткое. */
const WINDOW_CAPACITY = 240;

export class DegradationDetector {
  private readonly options: DegradationOptions;
  private readonly window = new Float32Array(WINDOW_CAPACITY);
  private windowFrames = 0;
  private windowMs = 0;
  private elapsedMs = 0;
  private badStreak = 0;
  private triggered = false;

  constructor(options: Partial<DegradationOptions> = {}) {
    this.options = { ...DEFAULT_DEGRADATION, ...options };
  }

  /** Просадка подтверждена и прогон пора останавливать. */
  get isDegraded(): boolean {
    return this.triggered;
  }

  /** Сколько плохих окон подряд насчитано — для показа на экране. */
  get badWindows(): number {
    return this.badStreak;
  }

  /**
   * Принять кадр. Возвращает true в тот момент, когда просадка подтверждена.
   */
  observe(frameMs: number): boolean {
    if (this.triggered) return true;

    this.elapsedMs += frameMs;
    if (this.elapsedMs <= this.options.warmupSec * 1000) return false;

    if (this.windowFrames < WINDOW_CAPACITY) {
      this.window[this.windowFrames] = frameMs;
      this.windowFrames++;
    }
    this.windowMs += frameMs;

    if (this.windowMs < this.options.windowSec * 1000) return false;

    this.evaluateWindow();
    this.windowFrames = 0;
    this.windowMs = 0;

    return this.triggered;
  }

  private evaluateWindow(): void {
    const frames = this.window.subarray(0, this.windowFrames);
    if (frames.length === 0) return;

    const avgFps = frames.length / (this.windowMs / 1000);

    // Обвал ниже collapseFps — это не серия плохих окон, а конец: одного
    // такого окна достаточно, чтобы остановиться.
    if (avgFps < this.options.collapseFps) {
      this.triggered = true;
      this.badStreak = this.options.consecutiveWindows;
      return;
    }

    const p95 = percentile(frames, 0.95);
    const bad = avgFps < this.options.minAvgFps || p95 > this.options.maxP95FrameMs;

    if (!bad) {
      // Серия обрывается на первом же нормальном окне: просадка обязана быть
      // непрерывной, иначе это не отказ, а разовая помеха.
      this.badStreak = 0;
      return;
    }

    this.badStreak++;
    if (this.badStreak >= this.options.consecutiveWindows) this.triggered = true;
  }
}

/** Ближайший ранг: значение перцентиля реально встречалось среди кадров. */
function percentile(frames: Float32Array, fraction: number): number {
  const sorted = Float32Array.from(frames).sort();
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}
