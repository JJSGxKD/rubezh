import Phaser from "phaser";
import type { RunOutcome } from "@bh/shared-types";
import type { RunDiagnostics, RunRecordingEventKind } from "../run-api";
import { FrameClock } from "../game/diagnostics/frame-clock";
import { RunPerfTracker } from "../game/diagnostics/run-perf";
import { RunRecorder, type RunRecordingHeader } from "../game/diagnostics/run-recorder";
import type { World } from "../game/sim/world";
import { watchVisibility } from "./visibility";

/**
 * Замеры забега на стороне браузера (docs/28-diagnostics.md §3): часы кадров,
 * сводка производительности у всех и полная запись — у тех, кто её включил.
 *
 * Всё, что читает браузер — сворачивание, видеоадаптер, объём кучи, — живёт
 * здесь, а подсчёт — в `game/diagnostics/*`, который проверяется headless.
 * Сцена только сообщает, что случилось.
 */

export interface RunProbeOptions {
  game: Phaser.Game;
  unitScale: number;
  renderCapFps: number | null;
  /** заголовок полной записи; `null` — записи нет, только сводка */
  recording: RunRecordingHeader | null;
}

export class RunProbe {
  private readonly clock = new FrameClock();
  private readonly perf = new RunPerfTracker();
  private readonly recorder: RunRecorder | null;
  private readonly stopWatching: () => void;
  private frameMs: number | null = null;

  constructor(private readonly options: RunProbeOptions) {
    this.recorder = options.recording === null ? null : new RunRecorder(options.recording, { heapMb: usedHeapMb });
    this.stopWatching = watchVisibility(this.clock);
  }

  /** Запись идёт: сцене стоит засекать время симуляции и рендера. */
  get recording(): boolean {
    return this.recorder !== null;
  }

  /** Начало кадра. Часы идут и на паузе: иначе первый кадр после неё принёс бы всю паузу. */
  beginFrame(time: number, deltaMs: number): void {
    this.frameMs = this.clock.frame(time, deltaMs);
  }

  /** Кадр забега, в котором мир жил. На паузе и на выборе не вызывается. */
  endFrame(world: World, simMs: number, steps: number, renderMs: number): void {
    const frameMs = this.frameMs;
    if (frameMs === null) return;
    const enemies = world.enemies.aliveCount;
    const projectiles = world.projectiles.aliveCount;
    this.perf.frame(frameMs, enemies + projectiles);
    this.recorder?.frame({
      frameMs,
      simMs,
      steps,
      renderMs,
      enemies,
      projectiles,
      tick: world.stats.tick,
      wave: world.difficulty.segment,
    });
  }

  stepped(code: number, world: World): void {
    this.recorder?.stepped(code, world);
  }

  choice(world: World, optionId: string): void {
    this.recorder?.choice(world.stats.tick, optionId);
  }

  event(world: World, kind: RunRecordingEventKind, value: string | number | null = null): void {
    this.recorder?.event(world.stats.tick, kind, value);
  }

  finish(world: World, outcome: RunOutcome, deathCause: string | null, canvasWidth: number, canvasHeight: number): RunDiagnostics {
    const renderer = this.options.game.renderer;
    const perf = this.perf.summary({
      renderer: renderer.type === Phaser.WEBGL ? "webgl" : "canvas",
      renderCapFps: this.options.renderCapFps,
      dpr: this.options.unitScale,
      canvasWidth,
      canvasHeight,
      interruptions: this.clock.interruptions,
    });
    return {
      perf,
      recording: this.recorder?.finish(world, outcome, deathCause, perf, gpuOf(renderer)) ?? null,
    };
  }

  destroy(): void {
    this.stopWatching();
  }
}

/**
 * Строка видеоадаптера. Это элемент отпечатка браузера, поэтому она живёт
 * только в записи забега у тех, кто её включил, а не в событиях
 * (docs/28-diagnostics.md §8).
 */
function gpuOf(renderer: Phaser.Game["renderer"]): string | null {
  if (!(renderer instanceof Phaser.Renderer.WebGL.WebGLRenderer)) return null;
  const gl = renderer.gl;
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  if (info === null) return null;
  const value: unknown = gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
  return typeof value === "string" ? value.slice(0, 128) : null;
}

/** Объём JS-кучи — только Chromium отдаёт его, остальные браузеры молчат. */
function usedHeapMb(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  const used = memory?.usedJSHeapSize;
  return typeof used === "number" && used > 0 ? used / (1024 * 1024) : null;
}
