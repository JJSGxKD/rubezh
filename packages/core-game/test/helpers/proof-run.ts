import type { DifficultyId, RunLoadout, UpgradeOption } from "@bh/shared-types";
import { CONTENT_HASH } from "../../src/content/hash";
import { openRunRecorder, type RunRecorder } from "../../src/game/diagnostics/run-recorder";
import { applyCardTool, isCardToolCommand } from "../../src/game/progression/card-tools";
import { chooseUpgrade, isAwaitingChoice } from "../../src/game/progression/levels";
import { captureWorld, restoreWorld } from "../../src/game/run/snapshot";
import { createRunWorld, type RunWorld } from "../../src/game/run-world";
import { applyContinue } from "../../src/game/sim/continue";
import { IDLE_CODE, inputOfCode, quantizeDirection } from "../../src/game/sim/input-code";
import { stepWorld, type SimInput } from "../../src/game/sim/step";
import { TICK_SEC, type World } from "../../src/game/sim/world";
import type { RunProof, RunProofDraft, RunRecording } from "../../src/run-api";
import { RunPerfTracker } from "../../src/game/diagnostics/run-perf";
import { buildRunResult } from "../../src/game/run/run-result";

/**
 * Забег «как в сцене», но без Phaser: тот же порядок шага, выбора, второго
 * шанса и записи, что в `MainScene`, и та же фабрика рекордера. Снимок прерванного
 * забега снимается и читается обратно через JSON — как через хранилище устройства.
 */
export interface ProofRunOptions {
  seed: number;
  maxTicks: number;
  difficultyId?: DifficultyId;
  unitScale?: number;
  /** сырое направление пальца на тике; `null` — палец не на экране */
  steer: (tick: number) => readonly [number, number] | null;
  choose?: (offers: readonly UpgradeOption[]) => string;
  continues?: boolean;
  loadout?: RunLoadout;
  /** без записи вовсе — для сравнения «с записью и без» */
  record?: boolean;
  /** рядом с проверкой писать и полную запись диагностики */
  full?: boolean;
  /** забег разработчика */
  dev?: boolean;
  /** потолок лога ввода, байт */
  inputLogBytes?: number;
  /** снять снимок на этом тике и продолжить из него новым миром, как после перезапуска приложения */
  snapshotAtTick?: number;
  /** снять снимок сразу после первого выбора улучшения, на том же тике */
  snapshotAfterChoice?: boolean;
  /** потерять запись для проверки в снимке — как снимок прошлой сборки */
  dropProofFromSnapshot?: boolean;
  /** подмена значения в снимке перед продолжением */
  tamperSnapshot?: (snapshot: { proof?: unknown }) => void;
}

export interface ProofRun {
  world: World;
  runWorld: RunWorld;
  recorder: RunRecorder | null;
  proof: RunProof | null;
  recording: RunRecording | null;
  /** тик, на котором был снят снимок; `null` — не снимали */
  snapshotTick: number | null;
  /** предложения улучшений в порядке выбора — чтобы подменять выбор настоящим вариантом */
  offers: { tick: number; ids: string[] }[];
}

const RUN_ID = "run-proof";

export function runWithProof(options: ProofRunOptions): ProofRun {
  const unitScale = options.unitScale ?? 2;
  const difficultyId = options.difficultyId ?? "normal";
  const worldOptions = {
    seed: options.seed,
    mapId: "",
    difficultyId,
    unitScale,
    ...(options.loadout === undefined ? {} : { loadout: options.loadout }),
  };
  let runWorld = createRunWorld(worldOptions);
  const startingWeaponId = (world: World): string => world.weaponTypes[world.loadout.weapons[0].typeIndex].id;
  const open = (world: World, resume?: { proof?: unknown }): RunRecorder =>
    openRunRecorder({
      world,
      runId: RUN_ID,
      seed: options.seed,
      contentHash: CONTENT_HASH,
      startingWeaponId: startingWeaponId(world),
      unitScale,
      ...(options.dev === true ? { dev: true } : {}),
      ...(resume === undefined ? {} : { resume }),
      ...(options.full === true ? { full: { reportId: "00000000-0000-4000-8000-000000000003", startedAt: "2026-10-26T10:00:00.000Z" } } : {}),
      ...(options.inputLogBytes === undefined ? {} : { inputLogBytes: options.inputLogBytes }),
    });
  let recorder: RunRecorder | null = options.record === false ? null : open(runWorld.world);

  const choose = options.choose ?? ((offers) => offers[0].id);
  const input: SimInput = { moveX: 0, moveY: 0 };
  const perf = new RunPerfTracker();
  const offersLog: ProofRun["offers"] = [];
  let code = IDLE_CODE;
  let snapshotTick: number | null = null;

  /** Снимок мира и записи, прочитанные обратно, и новый мир на их месте. */
  const interrupt = (): void => {
    const { world, spawner } = runWorld;
    const worldSnapshot: unknown = JSON.parse(JSON.stringify(captureWorld(world, spawner)));
    const draft = recorder?.draft(world) ?? null;
    const saved: { proof?: unknown } = JSON.parse(JSON.stringify(draft === null || options.dropProofFromSnapshot === true ? {} : { proof: draft satisfies RunProofDraft }));
    options.tamperSnapshot?.(saved);
    snapshotTick = world.stats.tick;

    runWorld = createRunWorld(worldOptions);
    restoreWorld(runWorld.world, runWorld.spawner, worldSnapshot);
    // Сцена после перезапуска начинает с покоя: код прошлого кадра не помнит.
    code = IDLE_CODE;
    if (recorder !== null) recorder = open(runWorld.world, saved);
  };

  while (runWorld.world.stats.tick < options.maxTicks) {
    const { world, spawner } = runWorld;
    if (options.snapshotAtTick !== undefined && snapshotTick === null && world.stats.tick >= options.snapshotAtTick) {
      interrupt();
      continue;
    }
    if (!world.player.alive) {
      if (options.continues !== true || !applyContinue(world)) break;
      recorder?.continued(world.stats.tick);
      continue;
    }
    if (isAwaitingChoice(world)) {
      offersLog.push({ tick: world.stats.tick, ids: world.progression.offers.map((offer) => offer.id) });
      const optionId = choose(world.progression.offers);
      // Действие с карточками (`~reroll`, `~skip`, `~banish:…`) — тоже выбор в логе.
      if (isCardToolCommand(optionId)) {
        if (applyCardTool(world, optionId) === null) throw new Error(`команда «${optionId}» не применилась: тест ошибся в сценарии`);
      } else if (!chooseUpgrade(world, optionId)) {
        throw new Error(`выбор «${optionId}» не применился: тест ошибся в сценарии`);
      }
      recorder?.choice(world.stats.tick, optionId);
      if (options.snapshotAfterChoice === true && snapshotTick === null) interrupt();
      continue;
    }
    const direction = options.steer(world.stats.tick);
    code = quantizeDirection(direction?.[0] ?? 0, direction?.[1] ?? 0, code);
    spawner.update(world, TICK_SEC);
    stepWorld(world, inputOfCode(code, input));
    recorder?.stepped(code, world);
    const frameMs = 1000 / 60;
    perf.frame(frameMs, world.enemies.aliveCount + world.projectiles.aliveCount);
    recorder?.frame({
      frameMs,
      simMs: 0.4,
      steps: 1,
      renderMs: 1.2,
      enemies: world.enemies.aliveCount,
      projectiles: world.projectiles.aliveCount,
      tick: world.stats.tick,
      wave: world.difficulty.segment,
    });
  }

  const { world } = runWorld;
  const outcome = world.player.alive ? "abandoned" : "died";
  const deathCause = buildRunResult(world, { runId: RUN_ID, seed: options.seed, outcome, startingWeaponId: "", contentHash: CONTENT_HASH }).deathCause;
  // Через JSON, как по сети: повтор получает то, что пришло на сервер.
  const wire = <T>(value: T | null): T | null => (value === null ? null : (JSON.parse(JSON.stringify(value)) as T));
  const proof = wire(recorder?.proof(world, deathCause) ?? null);
  const summary = perf.summary({ renderer: "webgl", renderCapFps: null, dpr: unitScale, canvasWidth: 780, canvasHeight: 1688, interruptions: 0 });
  const recording = options.full === true && recorder !== null ? wire(recorder.finish(world, outcome, deathCause, summary, null)) : null;
  return { world, runWorld, recorder, proof, recording, snapshotTick, offers: offersLog };
}
