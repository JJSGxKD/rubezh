import { CONTENT_HASH } from "../../content/hash";
import type { RunRecording, RunRecordingResult } from "../../run-api";
import { chooseUpgrade, isAwaitingChoice } from "../progression/levels";
import { buildRunResult } from "../run/run-result";
import { createRunWorld } from "../run-world";
import { checksumWorld } from "../sim/checksum";
import { inputOfCode } from "../sim/input-code";
import { stepWorld, type SimInput } from "../sim/step";
import { TICK_SEC } from "../sim/world";
import { decodeInputLog, InputLogError } from "./input-log";

/**
 * Повтор забега по записи (docs/28-diagnostics.md §3.4): тот же мир, тот же
 * лог ввода, те же выборы — и сверка исхода с оригиналом.
 *
 * Цикл повторяет сцену забега шаг в шаг: директор спавна и шаг мира на каждый
 * код лога, выбор улучшения — на том тике, где он был сделан. Расхождение при
 * совпадающем контенте — дефект детерминизма, и он важнее исходного
 * баг-репорта.
 */

export type ReplayVerdict =
  /** исход совпал до свёртки мира */
  | "match"
  /** повтор дал другой забег */
  | "mismatch"
  /** запись честно помечена неповторимой */
  | "not_replayable"
  /** запись снята на другой версии контента — нужен тег той сборки */
  | "content_mismatch"
  /** запись битая: лог не читается или выборы не ложатся на забег */
  | "broken";

export interface ReplayOutcome {
  verdict: ReplayVerdict;
  /** что пошло не так — для человека */
  reason: string | null;
  /**
   * Где повтор впервые разошёлся с записью: минута, свёртка которой не
   * совпала, тик выбора, который не лёг на забег, или тик, где забег встал
   * раньше лога. `null` — не разошёлся или сравнить не с чем.
   */
  divergedAtTick: number | null;
  expected: RunRecordingResult;
  actual: RunRecordingResult | null;
}

export function replayRecording(recording: RunRecording, contentHash: string = CONTENT_HASH): ReplayOutcome {
  const expected = recording.result;
  const verdict = (value: ReplayVerdict, reason: string | null, actual: RunRecordingResult | null = null, divergedAtTick: number | null = null): ReplayOutcome => ({
    verdict: value,
    reason,
    divergedAtTick,
    expected,
    actual,
  });

  if (recording.replayBlocker !== null) return verdict("not_replayable", recording.replayBlocker);
  if (recording.contentHash !== contentHash) {
    return verdict("content_mismatch", `запись снята на контенте ${recording.contentHash}, сейчас ${contentHash}`);
  }

  let codes: Int16Array;
  try {
    codes = decodeInputLog(recording.input);
  } catch (error: unknown) {
    if (error instanceof InputLogError) return verdict("broken", error.message);
    throw error;
  }

  const { world, spawner } = createRunWorld({
    seed: recording.seed,
    mapId: recording.mapId,
    difficultyId: recording.difficultyId,
    ...(recording.startingWeaponId === "" ? {} : { startingWeaponId: recording.startingWeaponId }),
    unitScale: recording.unitScale,
  });

  const input: SimInput = { moveX: 0, moveY: 0 };
  let choiceIndex = 0;
  let checkpointIndex = 0;
  let divergedAtTick: number | null = null;

  const applyChoices = (): string | null => {
    while (choiceIndex < recording.choices.length && recording.choices[choiceIndex][0] === world.stats.tick) {
      const [tick, optionId] = recording.choices[choiceIndex++];
      if (!isAwaitingChoice(world) || !chooseUpgrade(world, optionId)) {
        return `выбор «${optionId}» на тике ${tick} не ложится на забег`;
      }
    }
    return null;
  };

  for (let step = 0; step < codes.length; step++) {
    const choiceProblem = applyChoices();
    if (choiceProblem !== null) return verdict("mismatch", choiceProblem, resultOf(), divergedAtTick ?? world.stats.tick);
    // Сцена не шагает ни после смерти, ни на выборе улучшения: лог, который
    // требует шага здесь, описывает уже другой забег.
    if (!world.player.alive || isAwaitingChoice(world)) {
      const reason = `на тике ${world.stats.tick} забег стоит, а в логе ещё ${codes.length - step} шагов`;
      return verdict("mismatch", reason, resultOf(), divergedAtTick ?? world.stats.tick);
    }
    spawner.update(world, TICK_SEC);
    stepWorld(world, inputOfCode(codes[step], input));
    checkCheckpoint();
  }
  const trailing = applyChoices();
  if (trailing !== null) return verdict("mismatch", trailing, resultOf(), divergedAtTick ?? world.stats.tick);
  if (choiceIndex < recording.choices.length) {
    return verdict("broken", `${recording.choices.length - choiceIndex} выборов после конца лога`, resultOf());
  }

  const actual = resultOf();
  const same =
    actual.ticks === expected.ticks &&
    actual.survivalSec === expected.survivalSec &&
    actual.level === expected.level &&
    actual.enemiesKilled === expected.enemiesKilled &&
    actual.deathCause === expected.deathCause &&
    actual.checksum === expected.checksum &&
    divergedAtTick === null;
  return same ? verdict("match", null, actual) : verdict("mismatch", "исход повтора другой", actual, divergedAtTick);

  function resultOf(): RunRecordingResult {
    return {
      ticks: world.stats.tick,
      survivalSec: world.stats.elapsedSec,
      level: world.progression.level,
      enemiesKilled: world.stats.enemiesKilled,
      deathCause: buildRunResult(world, {
        runId: recording.runId,
        seed: recording.seed,
        outcome: recording.outcome,
        startingWeaponId: recording.startingWeaponId,
        contentHash,
      }).deathCause,
      checksum: checksumWorld(world),
    };
  }

  function checkCheckpoint(): void {
    const next = recording.checkpoints[checkpointIndex];
    if (next === undefined || next[0] !== world.stats.tick) return;
    checkpointIndex++;
    if (divergedAtTick === null && checksumWorld(world) !== next[1]) divergedAtTick = next[0];
  }
}
