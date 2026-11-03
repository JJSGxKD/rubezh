import type { UpgradeOption } from "@bh/shared-types";
import { ENEMIES } from "../../src/content/enemies";
import { RUBEZH } from "../../src/content/rubezh";
import { createBot } from "../../src/game/balance/bot";
import { chooseUpgrade, isAwaitingChoice } from "../../src/game/progression/levels";
import { isPrologueWon } from "../../src/game/run/prologue";
import { createRunWorld, type RunWorld, type RunWorldOptions } from "../../src/game/run-world";
import { IDLE_INPUT, stepWorld, type SimInput } from "../../src/game/sim/step";
import { SIM_EVENT } from "../../src/game/sim/events";
import { TICK_HZ, TICK_SEC, type World } from "../../src/game/sim/world";

/**
 * Пролог для тестов: мир собран так же, как в сцене (`createRunWorld` с режимом
 * `prologue`), цикл — как у сцены и повтора: директор спавна, шаг мира, выбор
 * улучшения на месте. Сцена Phaser в тесте не поднимается.
 */
export function createPrologueRun(seed = 1, patch: Partial<RunWorldOptions> = {}): RunWorld {
  return createRunWorld({ seed, mapId: "", difficultyId: "hard", unitScale: 1, mode: "prologue", ...patch });
}

/** Ввод, зависящий только от тика: бот держит внутреннее состояние, снимок его не несёт. */
const DIRECTIONS: readonly SimInput[] = [
  { moveX: 1, moveY: 0 },
  { moveX: 1, moveY: 1 },
  { moveX: 0, moveY: 1 },
  { moveX: -1, moveY: 1 },
  { moveX: -1, moveY: 0 },
  { moveX: -1, moveY: -1 },
  { moveX: 0, moveY: -1 },
  { moveX: 1, moveY: -1 },
];

export function scriptedInput(world: World): SimInput {
  return DIRECTIONS[Math.floor(world.stats.tick / 90) % DIRECTIONS.length];
}

export interface StepOptions {
  input?: (world: World) => SimInput;
  /** какой вариант взять на выборе; по умолчанию первый */
  choose?: (offers: readonly UpgradeOption[]) => string;
  /** прервать прогон, когда условие выполнено (после шага) */
  until?: (world: World) => boolean;
}

/**
 * Идёт `ticks` тиков (выбор улучшения тиков не тратит). Возвращает все
 * предложения, которые увидел игрок, — тест «Советуем» читает их.
 */
export function stepRun(run: RunWorld, ticks: number, options: StepOptions = {}): UpgradeOption[][] {
  const { world, spawner } = run;
  const seen: UpgradeOption[][] = [];
  const choose = options.choose ?? ((offers) => offers[0].id);
  const input = options.input ?? (() => IDLE_INPUT);
  let done = 0;
  while (done < ticks) {
    if (isAwaitingChoice(world)) {
      seen.push([...world.progression.offers]);
      chooseUpgrade(world, choose(world.progression.offers));
      continue;
    }
    spawner.update(world, TICK_SEC);
    stepWorld(world, input(world));
    done++;
    if (options.until?.(world) === true) break;
  }
  return seen;
}

export function stepSeconds(run: RunWorld, sec: number, options: StepOptions = {}): UpgradeOption[][] {
  return stepRun(run, Math.round(sec * TICK_HZ), options);
}

/** Сколько раз оберег сработал по буферу событий (в тестах буфер не успевает переполниться). */
export function wardEvents(world: World): number {
  const events = world.events;
  let count = 0;
  for (let seq = Math.max(0, events.written - events.kind.length); seq < events.written; seq++) {
    if (events.kind[seq % events.kind.length] === SIM_EVENT.ward) count++;
  }
  return count;
}

/** Индексы живых стражей рубежа. */
export function liveGuards(world: World): number[] {
  const typeIndex = world.enemyTypes.findIndex((type) => type.id === RUBEZH.guard);
  const found: number[] = [];
  for (let i = 0; i < world.enemies.count; i++) {
    if (world.enemies.alive[i] === 1 && world.enemies.type[i] === typeIndex) found.push(i);
  }
  return found;
}

export function guardDef() {
  const def = ENEMIES.find((enemy) => enemy.id === RUBEZH.guard);
  if (def === undefined) throw new Error("В контенте нет стража рубежа");
  return def;
}

export interface BotPrologue {
  seed: number;
  world: World;
  won: boolean;
  /** секунда победы; 0 — не победил */
  endSec: number;
  /** секунда прихода стража; 0 — не приходил */
  guardSpawnSec: number;
  /** сколько секунд страж прожил; 0 — не пал */
  guardLifeSec: number;
  /** секунда выпадения первого сундука; 0 — сундука не было */
  firstChestSec: number;
}

/**
 * Пролог уклоняющимся ботом калибровки. Аварийный потолок — `maxSec`: забег
 * обязан кончиться победой, а не висеть, пока бот не умрёт (он и не умрёт — оберег).
 */
export function playPrologueWithBot(seed: number, maxSec = 400): BotPrologue {
  const run = createPrologueRun(seed);
  const { world, spawner } = run;
  const bot = createBot("dodging");
  const maxTicks = Math.round(maxSec * TICK_HZ);
  let guardSpawnSec = 0;
  let firstChestSec = 0;
  let tick = 0;
  while (tick < maxTicks && world.player.alive && !isPrologueWon(world)) {
    if (isAwaitingChoice(world)) {
      chooseUpgrade(world, bot.choose(world.progression.offers));
      continue;
    }
    spawner.update(world, TICK_SEC);
    stepWorld(world, bot.input(world));
    tick++;
    if (guardSpawnSec === 0 && world.rubezh.phase !== "pending") guardSpawnSec = world.stats.elapsedSec;
    if (firstChestSec === 0 && world.chests.founds.length > 0) firstChestSec = world.chests.founds[0].elapsedSec;
  }
  const won = isPrologueWon(world);
  const endSec = won ? (world.rubezh.clearedSec ?? 0) : 0;
  return {
    seed,
    world,
    won,
    endSec,
    guardSpawnSec,
    guardLifeSec: won && guardSpawnSec > 0 ? endSec - guardSpawnSec : 0,
    firstChestSec,
  };
}
