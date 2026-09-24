import type { DifficultyId, RunOutcome } from "@bh/shared-types";
import {
  RUN_RECORDING_SCHEMA,
  type RunPerfSummary,
  type RunRecording,
  type RunRecordingEvent,
  type RunRecordingEventKind,
  type RunRecordingResult,
  type RunReplayBlocker,
} from "../../run-api";
import { checksumWorld } from "../sim/checksum";
import { TICK_HZ, type World } from "../sim/world";
import { InputLogWriter, INPUT_LOG_MAX_BYTES } from "./input-log";
import { RunTimeline, type TimelineFrame } from "./run-timeline";

/**
 * Полная запись забега (docs/28-diagnostics.md §3.3): таймлайн, события, лог
 * ввода и контрольные свёртки мира. Время сюда приносит сцена — сама запись
 * часов не читает и headless работает так же, как в браузере.
 */

/** Раз в минуту забега: повтор скажет, в какой минуте разошёлся с оригиналом. */
export const CHECKPOINT_TICKS = 60 * TICK_HZ;
/** Часовой забег даёт сотни событий; тысячи — уже поломка, отчёт не должен пухнуть. */
export const MAX_RECORDED_EVENTS = 4000;

export interface RunRecordingHeader {
  reportId: string;
  runId: string;
  startedAt: string;
  seed: number;
  mapId: string;
  difficultyId: DifficultyId;
  startingWeaponId: string;
  contentHash: string;
  unitScale: number;
  replayBlocker: Exclude<RunReplayBlocker, "input_overflow"> | null;
}

export interface RecorderOptions {
  /** объём JS-кучи, где браузер его отдаёт */
  heapMb?: () => number | null;
  inputLogBytes?: number;
}

export class RunRecorder {
  private readonly input: InputLogWriter;
  private readonly timeline: RunTimeline;
  private readonly events: RunRecordingEvent[] = [];
  private readonly choices: [number, string][] = [];
  private readonly continues: number[] = [];
  private readonly checkpoints: [number, number][] = [];
  private eventsTruncated = false;

  constructor(
    private readonly header: RunRecordingHeader,
    options: RecorderOptions = {},
  ) {
    this.input = new InputLogWriter(options.inputLogBytes ?? INPUT_LOG_MAX_BYTES);
    this.timeline = new RunTimeline(options.heapMb);
  }

  /** Шаг симуляции сделан с этим кодом ввода. Вызывается после `stepWorld`. */
  stepped(code: number, world: World): void {
    this.input.push(code);
    if (world.stats.tick % CHECKPOINT_TICKS === 0) this.checkpoints.push([world.stats.tick, checksumWorld(world)]);
  }

  continued(tick: number): void {
    this.continues.push(tick);
    this.event(tick, "continue");
  }

  choice(tick: number, optionId: string): void {
    this.choices.push([tick, optionId]);
    this.event(tick, "choice", optionId);
  }

  event(tick: number, kind: RunRecordingEventKind, value: string | number | null = null): void {
    if (this.events.length >= MAX_RECORDED_EVENTS) {
      this.eventsTruncated = true;
      return;
    }
    this.events.push([tick, kind, value]);
  }

  frame(sample: TimelineFrame): void {
    this.timeline.frame(sample);
  }

  finish(world: World, outcome: RunOutcome, deathCause: string | null, perf: RunPerfSummary, gpu: string | null): RunRecording {
    const input = this.input.finish();
    const result: RunRecordingResult = {
      ticks: world.stats.tick,
      survivalSec: world.stats.elapsedSec,
      level: world.progression.level,
      enemiesKilled: world.stats.enemiesKilled,
      deathCause,
      checksum: checksumWorld(world),
    };
    return {
      schema: RUN_RECORDING_SCHEMA,
      ...this.header,
      outcome,
      replayBlocker: this.header.replayBlocker ?? (input.truncated ? "input_overflow" : null),
      result,
      gpu,
      perf,
      timeline: this.timeline.finish(),
      timelineTruncated: this.timeline.truncated,
      events: this.events,
      eventsTruncated: this.eventsTruncated,
      input,
      choices: this.choices,
      continues: this.continues,
      checkpoints: this.checkpoints,
    };
  }
}
