import type { RunOutcome } from "@bh/shared-types";
import {
  RUN_RECORDING_SCHEMA,
  type RunPerfSummary,
  type RunProof,
  type RunProofDraft,
  type RunRecording,
  type RunRecordingEvent,
  type RunRecordingEventKind,
  type RunRecordingResult,
  type RunReplayBlocker,
} from "../../run-api";
import { isEmptyLoadout } from "../progression/run-loadout";
import { readProofDraft } from "../run/snapshot";
import { checksumWorld } from "../sim/checksum";
import { TICK_HZ, type World } from "../sim/world";
import { InputLogError, InputLogWriter, INPUT_LOG_MAX_BYTES } from "./input-log";
import { buildRunProof, type RunProofHeader } from "./run-proof";
import { RunTimeline, type TimelineFrame } from "./run-timeline";

/**
 * Запись забега (docs/28-diagnostics.md §3.3–§3.4) в двух режимах:
 *
 * - **`full`** — полная запись диагностики по переключателю: таймлайн, события, лог
 *   ввода и контрольные свёртки мира;
 * - **`proof`** — «только проверка», у каждого забега: лог ввода, выборы, продолжения и
 *   свёртки — всё, что задаёт исход, и ничего лишнего. Кадров и событий нет, поэтому
 *   сцена не засекает время симуляции и рендера ради записи.
 *
 * Время сюда приносит сцена — сама запись часов не читает и headless работает так же,
 * как в браузере. Запись мир не трогает: она только читает его.
 */

/** Раз в минуту забега: повтор скажет, в какой минуте разошёлся с оригиналом. */
export const CHECKPOINT_TICKS = 60 * TICK_HZ;
/** Часовой забег даёт сотни событий; тысячи — уже поломка, отчёт не должен пухнуть. */
export const MAX_RECORDED_EVENTS = 4000;

export interface RunRecordingHeader extends RunProofHeader {
  reportId: string;
  startedAt: string;
}

export interface RecorderOptions {
  /** объём JS-кучи, где браузер его отдаёт */
  heapMb?: () => number | null;
  inputLogBytes?: number;
  /** `full` по умолчанию; `proof` пишет только запись для проверки, и шапке не нужны `reportId` и `startedAt` */
  mode?: "full" | "proof";
  /** запись для проверки до снимка: продолженный забег дописывает её, а не начинает новую */
  resume?: RunProofDraft;
}

export class RunRecorder {
  private readonly input: InputLogWriter;
  private readonly timeline: RunTimeline | null;
  private readonly events: RunRecordingEvent[] = [];
  private readonly choices: [number, string][];
  private readonly continues: number[];
  private readonly checkpoints: [number, number][];
  private eventsTruncated = false;

  constructor(header: RunRecordingHeader, options?: Omit<RecorderOptions, "mode"> & { mode?: "full" });
  constructor(header: RunProofHeader, options: RecorderOptions & { mode: "proof" });
  constructor(
    private readonly header: RunProofHeader | RunRecordingHeader,
    options: RecorderOptions = {},
  ) {
    const bytes = options.inputLogBytes ?? INPUT_LOG_MAX_BYTES;
    const resume = options.resume;
    this.input = resume === undefined ? new InputLogWriter(bytes) : InputLogWriter.restore(resume.input, bytes);
    this.choices = resume === undefined ? [] : resume.choices.map(([tick, optionId]) => [tick, optionId]);
    this.continues = resume === undefined ? [] : [...resume.continues];
    this.checkpoints = resume === undefined ? [] : resume.checkpoints.map(([tick, checksum]) => [tick, checksum]);
    this.timeline = (options.mode ?? "full") === "full" ? new RunTimeline(options.heapMb) : null;
  }

  /** Идёт полная запись: сцене стоит засекать время симуляции и рендера. */
  get full(): boolean {
    return this.timeline !== null;
  }

  /** Почему забег не повторить; `null` — повторяется. */
  get blocker(): Exclude<RunReplayBlocker, "proof_overflow"> | null {
    return this.header.replayBlocker ?? (this.input.truncated ? "input_overflow" : null);
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
    if (this.timeline === null) return;
    if (this.events.length >= MAX_RECORDED_EVENTS) {
      this.eventsTruncated = true;
      return;
    }
    this.events.push([tick, kind, value]);
  }

  frame(sample: TimelineFrame): void {
    this.timeline?.frame(sample);
  }

  /**
   * Запись для проверки на момент снимка прерванного забега: она ложится в снимок и
   * продолжается после него. К свёрткам добавляется свёртка в тике снимка — повтор от
   * зерна сверит с ней продолженный мир. `null` — забег не повторить, и снимку записи не
   * нести: продолжив, он честно скажет `resumed`.
   */
  draft(world: World): RunProofDraft | null {
    if (this.blocker !== null) return null;
    const tick = world.stats.tick;
    const checkpoints: [number, number][] = this.checkpoints.map(([at, checksum]) => [at, checksum]);
    if (checkpoints[checkpoints.length - 1]?.[0] !== tick) checkpoints.push([tick, checksumWorld(world)]);
    return {
      unitScale: this.header.unitScale,
      startingWeaponId: this.header.startingWeaponId,
      input: this.input.snapshot(),
      choices: this.choices.map(([at, optionId]) => [at, optionId]),
      continues: [...this.continues],
      checkpoints,
    };
  }

  /**
   * Запись для проверки по итогу забега. `null` — повторить забег нельзя (`blocker`), и
   * отправлять нечего. Пока забег идёт, не вызывается: закрывает лог ввода.
   */
  proof(world: World, deathCause: string | null): RunProof | null {
    if (this.blocker !== null) return null;
    return buildRunProof(
      this.header,
      { input: this.input.finish(), choices: this.choices, continues: this.continues, checkpoints: this.checkpoints },
      resultOf(world, deathCause),
    );
  }

  finish(world: World, outcome: RunOutcome, deathCause: string | null, perf: RunPerfSummary, gpu: string | null): RunRecording {
    const header = this.header;
    const timeline = this.timeline;
    if (timeline === null || !("reportId" in header)) throw new Error("полная запись не велась: рекордер работает только на проверку");
    const input = this.input.finish();
    return {
      schema: RUN_RECORDING_SCHEMA,
      ...header,
      outcome,
      replayBlocker: this.blocker,
      result: resultOf(world, deathCause),
      gpu,
      perf,
      timeline: timeline.finish(),
      timelineTruncated: timeline.truncated,
      events: this.events,
      eventsTruncated: this.eventsTruncated,
      input,
      choices: this.choices,
      continues: this.continues,
      checkpoints: this.checkpoints,
    };
  }
}

function resultOf(world: World, deathCause: string | null): RunRecordingResult {
  return {
    ticks: world.stats.tick,
    survivalSec: world.stats.elapsedSec,
    level: world.progression.level,
    enemiesKilled: world.stats.enemiesKilled,
    deathCause,
    checksum: checksumWorld(world),
  };
}

export interface OpenRecorderOptions {
  world: World;
  runId: string;
  seed: number;
  contentHash: string;
  startingWeaponId: string;
  unitScale: number;
  /** забег разработчика: читы и команды в лог не пишутся */
  dev?: boolean;
  /**
   * Снимок, из которого забег продолжен. Его запись для проверки берётся, только если она
   * читается и описывает именно этот мир: снимок прошлой сборки, битая запись, запись про
   * другое число шагов или считанная в других пикселях — забег не повторить, причина `resumed`.
   */
  resume?: { proof?: unknown };
  /** полная запись диагностики; без поля рекордер пишет только запись для проверки */
  full?: { reportId: string; startedAt: string; heapMb?: () => number | null };
  /** потолок лога ввода, байт; по умолчанию — `INPUT_LOG_MAX_BYTES` */
  inputLogBytes?: number;
}

/**
 * Рекордер забега для сцены. Одна точка, где шапка собирается из мира, а запись из снимка
 * принимается или отвергается: сцена и тесты открывают рекордер одним и тем же путём.
 *
 * Нет записи в снимке — рекордер начинает с этого тика, и забег честно не повторить с
 * начала: причина `resumed`, как у снимков прошлой сборки.
 */
export function openRunRecorder(options: OpenRecorderOptions): RunRecorder {
  const { world } = options;
  const draft = options.resume === undefined ? null : readProofDraft(options.resume.proof);
  // Запись описывает именно этот мир: столько же шагов и тот же масштаб пикселей.
  const matching = draft !== null && draft.unitScale === options.unitScale && draft.input.ticks === world.stats.tick ? draft : null;

  const open = (resume: RunProofDraft | null): RunRecorder => {
    const header: RunProofHeader = {
      runId: options.runId,
      seed: options.seed,
      mapId: world.mapId,
      difficultyId: world.difficultyLevel.id,
      // Стартовое оружие продолженного забега — из записи: слот мира мог уйти в эволюцию.
      startingWeaponId: resume?.startingWeaponId ?? options.startingWeaponId,
      ...(world.mode === "endless" ? {} : { mode: world.mode }),
      ...(world.modifierIds.length === 0 ? {} : { modifierIds: [...world.modifierIds] }),
      contentHash: options.contentHash,
      unitScale: options.unitScale,
      // Продолженный без записи не повторить с начала, а в забеге разработчика читы и
      // команды в лог не пишутся.
      replayBlocker: options.dev === true ? "dev" : options.resume !== undefined && resume === null ? "resumed" : null,
      ...(isEmptyLoadout(world.runLoadout) ? {} : { loadout: world.runLoadout }),
    };
    const common = {
      ...(options.inputLogBytes === undefined ? {} : { inputLogBytes: options.inputLogBytes }),
      ...(resume === null ? {} : { resume }),
    };
    if (options.full === undefined) return new RunRecorder(header, { ...common, mode: "proof" });
    const { reportId, startedAt, heapMb } = options.full;
    return new RunRecorder({ ...header, reportId, startedAt }, { ...common, ...(heapMb === undefined ? {} : { heapMb }) });
  };

  if (matching === null) return open(null);
  try {
    return open(matching);
  } catch (error: unknown) {
    // Лог не лёг в потолок писателя: продолжать нечем, запись начинается заново.
    if (error instanceof InputLogError) return open(null);
    throw error;
  }
}
