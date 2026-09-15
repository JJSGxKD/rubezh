import type { RunPerfSummary } from "../../run-api";
import { DISPLAY_HZ_SAMPLE_FRAMES, DISPLAY_HZ_SKIP_FRAMES, estimateDisplayHz, JANK_FRAME_MS } from "./frame-stats";

/**
 * Сводка производительности обычного забега — у всех игроков
 * (docs/28-diagnostics.md §3.2): отвечает на вопрос «на скольких устройствах
 * плохо», поэтому стоит байты и почти ничего в кадре.
 *
 * Забег бывает и часовым, поэтому кадры не копятся: время кадра ложится в
 * гистограмму с шагом четверть миллисекунды, и p95 считается по ней. Точность
 * — шаг гистограммы, для сводки этого хватает с запасом. Всё предвыделено: в
 * кадре не аллоцируется ничего.
 */

const BIN_MS = 0.25;
/** 250 мс — дальше кадр одинаково плох, последняя корзина копит все длиннее. */
const BINS = 1000;
/**
 * Первые секунды забега не входят в оценку: компилируются шейдеры и
 * догружаются текстуры, а игрок в это время ещё не играет.
 */
const WARMUP_MS = 2_000;

export interface RunPerfContext {
  renderer: "webgl" | "canvas";
  /** ограничение частоты отрисовки; `null` — рисуем со скоростью экрана */
  renderCapFps: number | null;
  dpr: number;
  canvasWidth: number;
  canvasHeight: number;
  interruptions: number;
}

export class RunPerfTracker {
  private readonly histogram = new Uint32Array(BINS);
  private readonly early = new Float32Array(DISPLAY_HZ_SKIP_FRAMES + DISPLAY_HZ_SAMPLE_FRAMES);
  private earlyCount = 0;
  private warmedUpMs = 0;
  private frames = 0;
  private totalMs = 0;
  private janks = 0;
  private peakObjects = 0;

  /** кадр, которому можно верить (`FrameClock`), и объекты на экране после него */
  frame(frameMs: number, objects: number): void {
    if (this.earlyCount < this.early.length) this.early[this.earlyCount++] = frameMs;
    if (objects > this.peakObjects) this.peakObjects = objects;
    if (this.warmedUpMs < WARMUP_MS) {
      this.warmedUpMs += frameMs;
      return;
    }

    this.frames++;
    this.totalMs += frameMs;
    if (frameMs > JANK_FRAME_MS) this.janks++;
    const bin = Math.floor(frameMs / BIN_MS);
    this.histogram[bin < BINS ? (bin < 0 ? 0 : bin) : BINS - 1]++;
  }

  summary(context: RunPerfContext): RunPerfSummary {
    return {
      frames: this.frames,
      durationSec: this.totalMs / 1000,
      avgFps: this.totalMs > 0 ? (this.frames * 1000) / this.totalMs : 0,
      p95FrameMs: this.percentile(0.95),
      over33Ratio: this.frames > 0 ? this.janks / this.frames : 0,
      peakObjects: this.peakObjects,
      displayHz: estimateDisplayHz(this.early.subarray(0, this.earlyCount)),
      ...context,
    };
  }

  /** Верхняя граница корзины, в которую попал ранг: значение не меньше настоящего. */
  private percentile(fraction: number): number {
    if (this.frames === 0) return 0;
    const rank = Math.ceil(fraction * this.frames);
    let seen = 0;
    for (let bin = 0; bin < BINS; bin++) {
      seen += this.histogram[bin];
      if (seen >= rank) return (bin + 1) * BIN_MS;
    }
    return BINS * BIN_MS;
  }
}
