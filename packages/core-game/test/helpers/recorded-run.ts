import type { DifficultyId, UpgradeOption } from "@bh/shared-types";
import { CONTENT_HASH } from "../../src/content/hash";
import { RunPerfTracker } from "../../src/game/diagnostics/run-perf";
import { RunRecorder } from "../../src/game/diagnostics/run-recorder";
import { chooseUpgrade, isAwaitingChoice } from "../../src/game/progression/levels";
import { buildRunResult } from "../../src/game/run/run-result";
import { createRunWorld } from "../../src/game/run-world";
import { IDLE_CODE, inputOfCode, quantizeDirection } from "../../src/game/sim/input-code";
import { applyContinue } from "../../src/game/sim/continue";
import { stepWorld, type SimInput } from "../../src/game/sim/step";
import { TICK_SEC } from "../../src/game/sim/world";
import type { RunRecording } from "../../src/run-api";

/**
 * Забег «как в сцене», но без Phaser: тот же порядок шага, квантования,
 * выбора улучшения и записи, что в `MainScene`. Запись из него обязана
 * повторяться `replayRecording` так же, как запись с телефона.
 */
export interface RecordedRunOptions {
  seed: number;
  maxTicks: number;
  difficultyId?: DifficultyId;
  unitScale?: number;
  /** сырое направление пальца на тике; `null` — палец не на экране */
  steer: (tick: number) => readonly [number, number] | null;
  choose?: (offers: readonly UpgradeOption[]) => string;
  /** брать второй шанс при смерти, пока он есть, — как сцена по команде оболочки */
  continues?: boolean;
}

export function recordHeadlessRun(options: RecordedRunOptions): RunRecording {
  const unitScale = options.unitScale ?? 2;
  const { world, spawner } = createRunWorld({
    seed: options.seed,
    mapId: "",
    difficultyId: options.difficultyId ?? "normal",
    unitScale,
  });
  const recorder = new RunRecorder({
    reportId: "00000000-0000-4000-8000-000000000001",
    runId: "run-headless",
    startedAt: "2026-09-16T10:00:00.000Z",
    seed: options.seed,
    mapId: world.mapId,
    difficultyId: world.difficultyLevel.id,
    startingWeaponId: world.weaponTypes[world.loadout.weapons[0].typeIndex].id,
    contentHash: CONTENT_HASH,
    unitScale,
    replayBlocker: null,
  });
  const choose = options.choose ?? ((offers) => offers[0].id);
  const input: SimInput = { moveX: 0, moveY: 0 };
  const perf = new RunPerfTracker();
  let code = IDLE_CODE;

  recorder.event(0, "wave", world.difficulty.segment);
  while (world.stats.tick < options.maxTicks) {
    if (!world.player.alive) {
      if (options.continues !== true || !applyContinue(world)) break;
      recorder.continued(world.stats.tick);
      continue;
    }
    if (isAwaitingChoice(world)) {
      const optionId = choose(world.progression.offers);
      chooseUpgrade(world, optionId);
      recorder.choice(world.stats.tick, optionId);
      continue;
    }
    const direction = options.steer(world.stats.tick);
    code = quantizeDirection(direction?.[0] ?? 0, direction?.[1] ?? 0, code);
    spawner.update(world, TICK_SEC);
    stepWorld(world, inputOfCode(code, input));
    recorder.stepped(code, world);
    const frameMs = 1000 / 60;
    perf.frame(frameMs, world.enemies.aliveCount + world.projectiles.aliveCount);
    recorder.frame({
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

  const outcome = world.player.alive ? "abandoned" : "died";
  const deathCause = buildRunResult(world, {
    runId: "run-headless",
    seed: options.seed,
    outcome,
    startingWeaponId: "",
    contentHash: CONTENT_HASH,
  }).deathCause;
  const summary = perf.summary({ renderer: "webgl", renderCapFps: null, dpr: unitScale, canvasWidth: 780, canvasHeight: 1688, interruptions: 0 });
  // Через JSON, как по сети: повтор получает то, что пришло на сервер.
  return JSON.parse(JSON.stringify(recorder.finish(world, outcome, deathCause, summary, null))) as RunRecording;
}

/** Палец ведёт персонажа по кругу вокруг толпы — оборот за `periodTicks`. */
export function circling(periodTicks: number): (tick: number) => readonly [number, number] {
  return (tick) => {
    const angle = (tick / periodTicks) * Math.PI * 2;
    return [Math.cos(angle), Math.sin(angle)];
  };
}
