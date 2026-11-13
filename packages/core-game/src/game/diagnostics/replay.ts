import type { DeviceClass, RunLoadout, RunMode, RunOutcome } from "@bh/shared-types";
import { CONTENT_HASH } from "../../content/hash";
import type { ContentSnapshot } from "../../content/snapshot";
import type { RunRecording, RunRecordingResult, RunReplayBlocker } from "../../run-api";
import { applyCardTool, isCardToolCommand } from "../progression/card-tools";
import { chooseUpgrade, isAwaitingChoice } from "../progression/levels";
import { buildRunResult } from "../run/run-result";
import { createRunWorld } from "../run-world";
import { checksumWorld } from "../sim/checksum";
import { applyContinue } from "../sim/continue";
import { settleCordonDeath } from "../sim/cordon";
import { settleStalkerDeath } from "../sim/stalker";
import { inputOfCode } from "../sim/input-code";
import { chooseBlessing, isAwaitingBlessing } from "../sim/secrets";
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

/**
 * Что повтору нужно от записи: подходят и полная запись диагностики, и запись для проверки
 * (`run-proof-v1`, tasks/T-0316) — она подмножество полной. Чего в записи для проверки нет,
 * здесь необязательное: исход забега (смерть видно по причине в итоге) и причина
 * неповторимости (у такой записи её нет — иначе её не отправили бы).
 */
export type ReplaySource = Pick<
  RunRecording,
  "runId" | "seed" | "mapId" | "difficultyId" | "startingWeaponId" | "contentHash" | "unitScale" | "input" | "choices" | "checkpoints" | "result"
> & {
  mode?: RunMode;
  continues?: number[];
  loadout?: RunLoadout;
  /** класс устройства отдельным полем, как у записи для проверки: набор в ней без него */
  deviceClass?: DeviceClass;
  outcome?: RunOutcome;
  replayBlocker?: RunReplayBlocker | null;
};

/** Выбор благословения капища идёт в лог выборов с этой приставкой (`MainScene.chooseBlessing`). */
const BLESSING_PREFIX = "blessing:";

/**
 * Сколько шагов повтор делает между остановками (`replaySteps`): десять секунд мира. Достаточно
 * редко, чтобы остановки не стоили заметного, и достаточно часто, чтобы воркер успевал отдавать
 * управление циклу событий и проверять предел времени.
 */
export const REPLAY_PART_STEPS = 600;

export interface ReplayOptions {
  /**
   * Контент, на котором шёл забег; без поля — боевой `CONTENT_SNAPSHOT`. Воркер подаёт сюда снимок
   * по хэшу записи (tasks/T-0318): забег на прошлой версии баланса повторяется на ней, а не на нынешней.
   * Сверять хэш снимка с хэшем записи должен вызывающий: повтор доверяет ему `contentHash`.
   */
  content?: ContentSnapshot;
}

export function replayRecording(recording: ReplaySource, contentHash: string = CONTENT_HASH, options: ReplayOptions = {}): ReplayOutcome {
  const parts = replaySteps(recording, contentHash, options);
  for (let part = parts.next(); ; part = parts.next()) {
    if (part.done === true) return part.value;
  }
}

/**
 * Тот же повтор, но по частям: между частями (`REPLAY_PART_STEPS` шагов) управление возвращается
 * вызывающему, и он решает — продолжать, отдать цикл событий или бросить (`return()` закрывает
 * повтор). Значение остановки — сколько шагов лога уже сделано. Цельный повтор — `replayRecording`.
 */
export function* replaySteps(recording: ReplaySource, contentHash: string = CONTENT_HASH, options: ReplayOptions = {}): Generator<number, ReplayOutcome, undefined> {
  const expected = recording.result;
  const verdict = (value: ReplayVerdict, reason: string | null, actual: RunRecordingResult | null = null, divergedAtTick: number | null = null): ReplayOutcome => ({
    verdict: value,
    reason,
    divergedAtTick,
    expected,
    actual,
  });

  if (recording.replayBlocker !== undefined && recording.replayBlocker !== null) return verdict("not_replayable", recording.replayBlocker);
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

  const loadout = replayLoadout(recording);
  const { world, spawner } = createRunWorld({
    seed: recording.seed,
    mapId: recording.mapId,
    difficultyId: recording.difficultyId,
    ...(recording.mode === undefined ? {} : { mode: recording.mode }),
    ...(recording.startingWeaponId === "" ? {} : { startingWeaponId: recording.startingWeaponId }),
    unitScale: recording.unitScale,
    ...(loadout === undefined ? {} : { loadout }),
    ...(options.content === undefined ? {} : { content: options.content }),
  });
  // Капище в живом забеге ждёт игрока (`pauseOnChest`), и выбор лежит в логе; без таких выборов
  // оно берёт первое предложение, как у ботов и стенда, — и мир один и тот же.
  const manualBlessing = recording.choices.some(([, optionId]) => optionId.startsWith(BLESSING_PREFIX));
  world.secrets.manualBlessing = manualBlessing;

  const input: SimInput = { moveX: 0, moveY: 0 };
  let choiceIndex = 0;
  const continues = recording.continues ?? [];
  let continueIndex = 0;
  let checkpointIndex = 0;
  let divergedAtTick: number | null = null;
  /**
   * Свёртки текущего тика, не совпавшие со свёрткой после шага. Команды тика (выбор,
   * второй шанс) мир меняют, а снимок прерванного забега снимается и после них, поэтому
   * свёртка «этого тика» — это состояние после шага или после любой из команд; не
   * совпавшая ни с одним — расхождение (`settleCheckpoints`).
   */
  let awaiting: [tick: number, checksum: number][] = [];

  const applyChoices = (): string | null => {
    while (choiceIndex < recording.choices.length && recording.choices[choiceIndex][0] === world.stats.tick) {
      const [tick, optionId] = recording.choices[choiceIndex++];
      // Переброс, пропуск и изгнание идут в лог теми же выборами с условными id, благословение — с приставкой.
      const applied = optionId.startsWith(BLESSING_PREFIX)
        ? chooseBlessing(world, optionId.slice(BLESSING_PREFIX.length))
        : isAwaitingChoice(world) && (isCardToolCommand(optionId) ? applyCardTool(world, optionId) !== null : chooseUpgrade(world, optionId));
      if (!applied) return `выбор «${optionId}» на тике ${tick} не ложится на забег`;
      matchCheckpoints();
    }
    return null;
  };

  /** Второй шанс — там же, где его применила сцена: на тике смерти. */
  const applyContinues = (): string | null => {
    while (continueIndex < continues.length && continues[continueIndex] === world.stats.tick) {
      const tick = continues[continueIndex++];
      if (!applyContinue(world)) return `второй шанс на тике ${tick} не ложится на забег`;
      matchCheckpoints();
    }
    return null;
  };

  for (let step = 0; step < codes.length; step++) {
    const continueProblem = applyContinues();
    if (continueProblem !== null) return verdict("mismatch", continueProblem, resultOf(), divergedAtTick ?? world.stats.tick);
    const choiceProblem = applyChoices();
    if (choiceProblem !== null) return verdict("mismatch", choiceProblem, resultOf(), divergedAtTick ?? world.stats.tick);
    // Сцена не шагает ни после смерти, ни на выборе улучшения или благословения: лог,
    // который требует шага здесь, описывает уже другой забег.
    if (!world.player.alive || isAwaitingChoice(world) || isAwaitingBlessing(world)) {
      const reason = `на тике ${world.stats.tick} забег стоит, а в логе ещё ${codes.length - step} шагов`;
      return verdict("mismatch", reason, resultOf(), divergedAtTick ?? world.stats.tick);
    }
    settleCheckpoints();
    spawner.update(world, TICK_SEC);
    stepWorld(world, inputOfCode(codes[step], input));
    checkCheckpoint();
    // Как в сцене: смерть закрывает кольцо стражей после шага и после свёртки тика.
    settleCordonDeath(world);
    settleStalkerDeath(world);
    if ((step + 1) % REPLAY_PART_STEPS === 0) yield step + 1;
  }
  const trailing = applyChoices();
  if (trailing !== null) return verdict("mismatch", trailing, resultOf(), divergedAtTick ?? world.stats.tick);
  settleCheckpoints();
  if (choiceIndex < recording.choices.length) {
    return verdict("broken", `${recording.choices.length - choiceIndex} выборов после конца лога`, resultOf());
  }
  if (continueIndex < continues.length) {
    return verdict("broken", `${continues.length - continueIndex} продолжений после конца лога`, resultOf());
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
        // Запись для проверки исхода не несёт: смерть видна по причине в итоге.
        outcome: recording.outcome ?? (expected.deathCause === null ? "abandoned" : "died"),
        startingWeaponId: recording.startingWeaponId,
        contentHash,
      }).deathCause,
      checksum: checksumWorld(world),
    };
  }

  /** Свёртки этого тика после шага: совпавшие сняты, остальные ждут команд тика. */
  function checkCheckpoint(): void {
    while (checkpointIndex < recording.checkpoints.length && recording.checkpoints[checkpointIndex][0] <= world.stats.tick) {
      const [tick, checksum] = recording.checkpoints[checkpointIndex++];
      // Свёртка раньше текущего тика не встала в порядок: запись не по порядку тиков — расхождение.
      if (tick < world.stats.tick) divergedAtTick ??= tick;
      else if (checksumWorld(world) !== checksum) awaiting.push([tick, checksum]);
    }
  }

  /** Ожидающие свёртки сверяются с миром после очередной команды тика. */
  function matchCheckpoints(): void {
    if (awaiting.length === 0) return;
    const checksum = checksumWorld(world);
    awaiting = awaiting.filter(([, expectedChecksum]) => expectedChecksum !== checksum);
  }

  /** Команды тика кончились: не совпавшая ни с одним состоянием свёртка — расхождение. */
  function settleCheckpoints(): void {
    if (awaiting.length > 0) divergedAtTick ??= awaiting[0][0];
    awaiting = [];
  }
}

/**
 * Набор забега для мира повтора. Запись для проверки держит класс устройства отдельным
 * полем, а набор — без него (так его разбирает приёмник): возвращаем класс в набор, иначе
 * повтор слабого устройства шёл бы с потолком врагов обычного.
 */
export function replayLoadout(recording: ReplaySource): RunLoadout | undefined {
  const light = recording.deviceClass === "light";
  if (recording.loadout === undefined && !light) return undefined;
  const base = recording.loadout ?? { modifiers: {}, boosts: [] };
  return light ? { ...base, deviceClass: "light" } : base;
}
