import type { RunTimelineBucket } from "../../run-api";
import { JANK_FRAME_MS, percentileOfSorted } from "./frame-stats";

/**
 * Таймлайн записи забега (docs/28-diagnostics.md §3.3): корзины по пять
 * секунд — по ним видно, в какой момент забега и на какой толпе начались
 * просадки и догоняние симуляции.
 *
 * Время корзины — время кадров, которым можно верить, а не секунды
 * симуляции: пауза и фон в таймлайн не попадают. Секунду забега корзина
 * несёт отдельно — тиком, чтобы сопоставить её с событиями.
 *
 * Буфер кадров корзины выделен заранее и сортируется на месте при закрытии
 * корзины — раз в пять секунд, а не в кадре.
 */

export const TIMELINE_BUCKET_SEC = 5;
/** Час забега. Дальше таймлайн не растёт: отчёт не должен пухнуть без предела. */
export const TIMELINE_MAX_BUCKETS = 720;
/** Пять секунд при 240 Гц; экран быстрее — корзина закроется раньше. */
const FRAMES_PER_BUCKET = 1200;

export interface TimelineFrame {
  frameMs: number;
  /** время шагов симуляции за кадр, мс */
  simMs: number;
  steps: number;
  /** время синхронизации рендера с миром, мс */
  renderMs: number;
  enemies: number;
  projectiles: number;
  /** тик симуляции после кадра */
  tick: number;
  /** отрезок таймлайна спавна */
  wave: number;
}

export class RunTimeline {
  private readonly frameMs = new Float32Array(FRAMES_PER_BUCKET);
  private readonly buckets: RunTimelineBucket[] = [];
  private overflowed = false;
  private startMs = 0;
  private elapsedMs = 0;
  private frames = 0;
  private simMsTotal = 0;
  private simMsMax = 0;
  private stepsTotal = 0;
  private maxSteps = 0;
  private catchUpFrames = 0;
  private renderMsTotal = 0;
  private enemiesTotal = 0;
  private projectilesTotal = 0;
  private maxObjects = 0;
  private lastTick = 0;
  private lastWave = 0;

  /** `heapMb` читается при закрытии корзины: объём кучи — только где браузер его отдаёт */
  constructor(private readonly heapMb: () => number | null = () => null) {}

  get truncated(): boolean {
    return this.overflowed;
  }

  frame(sample: TimelineFrame): void {
    if (this.overflowed) return;
    this.frameMs[this.frames++] = sample.frameMs;
    this.elapsedMs += sample.frameMs;
    this.simMsTotal += sample.simMs;
    if (sample.simMs > this.simMsMax) this.simMsMax = sample.simMs;
    this.stepsTotal += sample.steps;
    if (sample.steps > this.maxSteps) this.maxSteps = sample.steps;
    // Больше шага за кадр — устройство не успело, и игрок видит замедление
    // игры, а не падение FPS.
    if (sample.steps > 1) this.catchUpFrames++;
    this.renderMsTotal += sample.renderMs;
    this.enemiesTotal += sample.enemies;
    this.projectilesTotal += sample.projectiles;
    const objects = sample.enemies + sample.projectiles;
    if (objects > this.maxObjects) this.maxObjects = objects;
    this.lastTick = sample.tick;
    this.lastWave = sample.wave;

    if (this.elapsedMs >= TIMELINE_BUCKET_SEC * 1000 || this.frames >= FRAMES_PER_BUCKET) this.close();
  }

  /** Корзины вместе с недозаполненной последней. */
  finish(): RunTimelineBucket[] {
    if (this.frames > 0 && !this.overflowed) this.close();
    return this.buckets;
  }

  private close(): void {
    if (this.buckets.length >= TIMELINE_MAX_BUCKETS) {
      this.overflowed = true;
      return;
    }
    const frames = this.frames;
    const sorted = this.frameMs.subarray(0, frames).sort();
    let janks = 0;
    for (let i = frames - 1; i >= 0 && sorted[i] > JANK_FRAME_MS; i--) janks++;

    this.buckets.push({
      startSec: round(this.startMs / 1000, 2),
      tick: this.lastTick,
      wave: this.lastWave,
      frames,
      avgFps: round(this.elapsedMs > 0 ? (frames * 1000) / this.elapsedMs : 0, 1),
      p50FrameMs: round(percentileOfSorted(sorted, 0.5), 2),
      p95FrameMs: round(percentileOfSorted(sorted, 0.95), 2),
      p99FrameMs: round(percentileOfSorted(sorted, 0.99), 2),
      over33Ratio: round(janks / frames, 4),
      simMsAvg: round(this.stepsTotal > 0 ? this.simMsTotal / this.stepsTotal : 0, 3),
      simMsMax: round(this.simMsMax, 2),
      maxSteps: this.maxSteps,
      catchUpFrames: this.catchUpFrames,
      renderMsAvg: round(this.renderMsTotal / frames, 3),
      enemies: Math.round(this.enemiesTotal / frames),
      projectiles: Math.round(this.projectilesTotal / frames),
      maxObjects: this.maxObjects,
      heapMb: roundOrNull(this.heapMb(), 1),
    });

    this.startMs += this.elapsedMs;
    this.elapsedMs = 0;
    this.frames = 0;
    this.simMsTotal = 0;
    this.simMsMax = 0;
    this.stepsTotal = 0;
    this.maxSteps = 0;
    this.catchUpFrames = 0;
    this.renderMsTotal = 0;
    this.enemiesTotal = 0;
    this.projectilesTotal = 0;
    this.maxObjects = 0;
  }
}

function round(value: number, digits: number): number {
  const scale = digits === 1 ? 10 : digits === 2 ? 100 : digits === 3 ? 1000 : 10_000;
  return Math.round(value * scale) / scale;
}

function roundOrNull(value: number | null, digits: number): number | null {
  return value === null || !Number.isFinite(value) ? null : round(value, digits);
}
