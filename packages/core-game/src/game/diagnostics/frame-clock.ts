/**
 * Каким кадрам верить (docs/28-diagnostics.md §3.1).
 *
 * Возврат из фона даёт один кадр длиной в секунды: детектор просадки видит в
 * нём обвал, а перцентили и минимальный FPS оказываются испорчены — на живом
 * прогоне этапа 1 результат пришлось выбросить. Поэтому кадры в фоне и первые
 * после возврата не записываются, а число прерываний идёт в отчёт.
 *
 * Время кадра — по сырым меткам `update(time)`, а не по второму аргументу:
 * Phaser его сглаживает и обрезает сверху, и фриз в цифре не появляется.
 *
 * Про DOM часы не знают: о сворачивании им сообщает сцена.
 */

/** Первые кадры после возврата ещё несут хвост простоя. */
const SKIP_AFTER_RESUME = 3;

export class FrameClock {
  private lastTimestamp = 0;
  private suspended = false;
  private skipFrames = 0;
  private interruptionCount = 0;

  /** сколько раз приложение уходило в фон */
  get interruptions(): number {
    return this.interruptionCount;
  }

  /**
   * Время кадра в миллисекундах или `null`, если кадру нельзя верить.
   * `deltaMs` нужен только для самого первого кадра, у которого нет прошлой метки.
   */
  frame(time: number, deltaMs: number): number | null {
    const frameMs = this.lastTimestamp === 0 ? deltaMs : time - this.lastTimestamp;
    this.lastTimestamp = time;
    if (this.suspended) return null;
    if (this.skipFrames > 0) {
      this.skipFrames--;
      return null;
    }
    return frameMs;
  }

  hide(): void {
    this.suspended = true;
  }

  show(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.skipFrames = SKIP_AFTER_RESUME;
    this.lastTimestamp = 0;
    this.interruptionCount++;
  }
}
