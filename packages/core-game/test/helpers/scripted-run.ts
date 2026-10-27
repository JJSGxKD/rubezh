import type { CordonRingDef, EndlessCurveDef, EnemyDef, EnemyPattern, MapDef, TimelineSegmentDef, UpgradeOption } from "@bh/shared-types";
import { ENEMIES } from "../../src/content/enemies";
import { ENDLESS_CURVE } from "../../src/content/waves";
import { DROPS } from "../../src/content/drops";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../../src/content/upgrades";
import { WEAPONS } from "../../src/content/weapons";
import { chooseUpgrade, isAwaitingChoice } from "../../src/game/progression/levels";
import { createWorld, DEFAULT_SIM_CONFIG, TICK_SEC, type World } from "../../src/game/sim/world";
import { createTimelineDirector } from "../../src/game/sim/director";
import type { Spawner } from "../../src/game/sim/spawner";
import { IDLE_INPUT, stepWorld, type SimInput } from "../../src/game/sim/step";
import { createConstantPopulationSpawner } from "../../src/game/sim/spawner";
import { benchInput } from "../../src/game/bench/autopilot";
import { checksumWorld } from "../../src/game/sim/checksum";

/**
 * Общая обвязка для прогонов симуляции в тестах. Сценарий ввода — функция от
 * номера тика, а не запись реального ввода: так один и тот же скрипт
 * воспроизводится где угодно (docs/17-testing-strategy.md §3.2).
 */
export interface ScriptedRunOptions {
  seed: number;
  ticks: number;
  population: number;
  /** бессмертный игрок для нагрузочных прогонов — см. комментарий ниже */
  immortalPlayer?: boolean;
  /**
   * Доли паттернов в популяции. По умолчанию — смесь стенда испытаний этапа 1
   * (рой, преследование, стрелок): на ней сравниваются сборки между собой.
   */
  weights?: Partial<Record<EnemyPattern, number>>;
  /** чем начинать забег; по умолчанию — первое стартовое оружие контента */
  startingWeaponId?: string;
  /**
   * Как отвечать на выбор улучшения. По умолчанию берётся первый вариант:
   * сценарий должен быть воспроизводимым, а не «как повезёт».
   */
  choose?: (offers: readonly UpgradeOption[], tick: number) => string;
}

/** Все паттерны сразу — нагрузка, которую создаёт игра, а не стенд этапа 1. */
export const ALL_PATTERNS_WEIGHTS: Record<EnemyPattern, number> = {
  swarm: 4,
  chase: 1,
  kite_and_shoot: 2,
  dash: 1,
  orbit: 2,
  exploder: 1,
  rush: 2,
  caster: 1,
  splitter: 1,
  // Одинокий страж в обычной популяции бессмыслен: он держит место в строю кольца.
  cordon: 0,
};

export interface ScriptedRunResult {
  world: World;
  /** свёртка состояния мира — точное сравнение двух прогонов одним числом */
  checksum: number;
}

export function runScripted(options: ScriptedRunOptions): ScriptedRunResult {
  const world = createWorld({
    seed: options.seed,
    enemies: ENEMIES,
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    drops: DROPS,
    ...(options.startingWeaponId === undefined
      ? {}
      : { startingWeaponId: options.startingWeaponId }),
    // Нагрузочный прогон меряет устойчивое состояние: если игрок умирает на
    // тридцатой секунде, дальше меряется мир без выстрелов — то есть не тот
    // мир, ради которого прогон затевался.
    config: options.immortalPlayer
      ? { player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 1_000_000 } }
      : undefined,
  });
  const spawner = createConstantPopulationSpawner(options.population, options.weights);

  const choose = options.choose ?? ((offers) => offers[0].id);

  for (let tick = 0; tick < options.ticks; tick++) {
    // Выбор улучшения делается до шага: пока он не сделан, мир стоит, и
    // цикл крутился бы вхолостую до конца сценария.
    if (isAwaitingChoice(world)) chooseUpgrade(world, choose(world.progression.offers, tick));

    spawner.update(world, 1 / 60);
    stepWorld(world, benchInput(tick));
  }

  return { world, checksum: checksumWorld(world) };
}

/** Свёртка мира живёт в исходниках: ею же сверяет запись забега (sim/checksum.ts). */
export { checksumWorld } from "../../src/game/sim/checksum";

/** Страж кольца для тестов: неубиваемый на глаз, медленный, бьёт касанием. */
export const GUARD: EnemyDef = { id: "guard", hp: 100000, speed: 40, damage: 5, xp: 1, threat: 1, pattern: "cordon" };

/** Рядовой враг для тестов кольца. */
export const RAT: EnemyDef = { id: "rat", hp: 10, speed: 60, damage: 1, xp: 1, threat: 1, pattern: "swarm" };

/** Кольцо тестов: сорок стражей встают на 200 и сжимаются до 80 за двадцать секунд. */
export const CORDON_RING: CordonRingDef = { radius: 200, minRadius: 80, shrinkPerSec: 6, lifeSec: 30 };

export interface CordonRunOptions {
  seed?: number;
  /** сколько стражей в кольце */
  count?: number;
  ring?: CordonRingDef;
  /** отрезки таймлайна вместо одного с кольцом */
  timeline?: TimelineSegmentDef[];
  maxEnemies?: number;
  map?: MapDef;
  /** здоровье игрока; по умолчанию его не убить */
  playerHp?: number;
  /** падает ли добыча с убитых; по умолчанию нет — тест смотрит на строй */
  loot?: boolean;
}

export interface CordonRun {
  world: World;
  director: Spawner;
}

/**
 * Забег с кольцом стражей: свои типы врагов вместо контента, игрок без оружия и
 * без прокачки — тест смотрит на строй, а не на бой. Кривая бесконечного режима
 * ушла далеко за время теста, чтобы директор не добавлял своих врагов.
 */
export function createCordonRun(options: CordonRunOptions = {}): CordonRun {
  const curve: EndlessCurveDef = { ...ENDLESS_CURVE, fromSec: 1_000_000, pool: ["rat"], events: [] };
  const timeline = options.timeline ?? [
    { fromSec: 0, spawns: [], events: [{ kind: "cordon" as const, enemy: "guard", count: options.count ?? 40, ring: options.ring ?? CORDON_RING }] },
  ];
  const world = createWorld({
    seed: options.seed ?? 1,
    enemies: [GUARD, RAT],
    ...(options.map === undefined ? {} : { map: options.map }),
    config: {
      progressionEnabled: false,
      ...(options.loot === true ? { lootEnabled: true } : {}),
      ...(options.maxEnemies === undefined ? {} : { maxEnemies: options.maxEnemies }),
      player: { ...DEFAULT_SIM_CONFIG.player, maxHp: options.playerHp ?? 1_000_000 },
    },
  });
  return { world, director: createTimelineDirector(timeline, curve) };
}

/** Один шаг забега: директор, потом мир. */
export function stepRun(run: CordonRun, input: SimInput = IDLE_INPUT): void {
  run.director.update(run.world, TICK_SEC);
  stepWorld(run.world, input);
}

/** Прокрутить забег `seconds` секунд; ввод — константа или функция от тика. */
export function advanceRun(run: CordonRun, seconds: number, input: SimInput | ((tick: number) => SimInput) = IDLE_INPUT): void {
  const ticks = Math.round(seconds / TICK_SEC);
  for (let k = 0; k < ticks; k++) stepRun(run, typeof input === "function" ? input(run.world.stats.tick) : input);
}

/** Индексы живых стражей кольца в пуле врагов. */
export function aliveGuards(world: World): number[] {
  const found: number[] = [];
  const guardType = world.enemyTypes.findIndex((type) => type.id === "guard");
  for (let i = 0; i < world.enemies.count; i++) {
    if (world.enemies.alive[i] === 1 && world.enemies.type[i] === guardType) found.push(i);
  }
  return found;
}

