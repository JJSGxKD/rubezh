import type { DifficultyId, RunHuntEntry, RunLoadout, RunRubezh } from "@bh/shared-types";
import { DEFAULT_DIFFICULTY_ID } from "../../content/difficulty";
import { RUBEZH } from "../../content/rubezh";
import { CONTENT_SNAPSHOT, type ContentSnapshot } from "../../content/snapshot";
import { buildScore } from "../run/hunt-log";
import { applyCardTool, isCardToolCommand } from "../progression/card-tools";
import { chooseUpgrade, isAwaitingChoice } from "../progression/levels";
import { cardToolsAt, unlocksAt, weaponsOpenAt } from "../progression/unlocks";
import { createTimelineDirector } from "../sim/director";
import { buildScoreOf } from "../sim/player-power";
import { isPressureActive } from "../sim/pressure";
import { describeRubezh } from "../sim/rubezh";
import { stepWorld } from "../sim/step";
import { DEFAULT_SIM_CONFIG } from "../sim/create-world";
import { createWorld, TICK_SEC } from "../sim/world";
import { createBot, type BotSkill, type DodgingBotOptions } from "./bot";
import { isBuildComplete } from "./build-complete";
import { createStrongBot, type StrongStance } from "./strong-bot";

/**
 * Прогон забега ботом на боевом контенте — вход калибровки баланса
 * (docs/26-stage2-plan.md, WP4.6).
 *
 * В отличие от тестов симуляции, которые гоняются на фикстурах, здесь взят
 * именно игровой контент: смысл в том, чтобы померить текущие числа, а не
 * поведение движка.
 */

/** Аварийный потолок: забег обязан кончиться, даже если бот неуязвим. */
const DEFAULT_MAX_SEC = 900;

export interface BalanceRunOptions {
  seed: number;
  skill: BotSkill;
  /**
   * уровень сложности; по умолчанию — «Сложная»: главный бой, коридоры
   * калибровки заданы для неё; обучающая «Лёгкая» меряется отдельно
   */
  difficultyId?: DifficultyId;
  /** чем начинать забег; по умолчанию — первое открытое оружие контента */
  startingWeaponId?: string;
  /**
   * Уровень аккаунта: открытое оружие, навыки и слоты — как в забеге
   * (docs/35-stage4-plan.md §3.13). Не задан — открыто всё: на этом наборе
   * заданы коридоры калибровки.
   */
  accountLevel?: number;
  /**
   * Набор забега — снаряжение, бусты, уровень аккаунта и класс устройства
   * (профили силы калибровки, `POWER_PROFILES`). Уровень аккаунта набора
   * открывает оружие и навыки вместо `accountLevel` и включает подстройку под
   * силу. Без набора бот идёт ровно как раньше.
   */
  loadout?: RunLoadout;
  /**
   * Подстройка под силу (Р131): по умолчанию включена, но работает, только если
   * у набора есть уровень аккаунта. `false` — строка «без подстройки»: набор
   * по-прежнему действует, а давление остаётся единой сложностью.
   */
  pressure?: boolean;
  maxSec?: number;
  /**
   * Зонд давления: игрок почти неуязвим, и бот идёт до `maxSec`, а не до
   * смерти — так видно, сколько урона несёт поздний бой, до которого
   * настоящий бот не доживает.
   */
  immortalPlayer?: boolean;
  /**
   * Бессмертие движка (`world.cheats.godMode`): урон по игроку не отнимает
   * здоровья, и бот идёт до `maxSec`, не умирая. Им меряется сборка набора
   * (T-0193): на «Сложной» обычный бот гибнет раньше, чем соберёт его.
   */
  godMode?: boolean;
  /** прогон кончается, когда набор собран; `buildCompleteSec` — эта секунда */
  stopOnBuild?: boolean;
  /**
   * Стойка сильного бота (`skill: "strong"`): бегает всегда или стоит с 180-й
   * секунды. Для остальных ботов не читается; по умолчанию — «бегает».
   */
  stance?: StrongStance;
  /** параметры уклоняющегося бота для замера по сетке; не заданы — `DODGING_BOT_DEFAULTS` */
  bot?: Partial<DodgingBotOptions>;
  /**
   * Контент прогона; без поля — боевой `CONTENT_SNAPSHOT`. Песочница редактора
   * баланса гоняет бота на черновике (docs/19-content-admin.md §3). Коридоры
   * отчёта лежат в `content.balanceTargets`.
   */
  content?: ContentSnapshot;
}

export interface BalanceRunResult {
  seed: number;
  skill: BotSkill;
  startingWeaponId: string;
  survivalSec: number;
  level: number;
  /** отрезок таймлайна, до которого дожил — «волна» в аналитике */
  wave: number;
  enemiesKilled: number;
  xpCollected: number;
  peakEnemies: number;
  /** секунда, на которой бот взял второй уровень; 0 — не взял вовсе */
  firstLevelUpSec: number;
  /** сколько сундуков выпало за забег */
  chestsFound: number;
  /** сколько сундуков бот открыл за забег */
  chestsOpened: number;
  /** сколько слотов оружия к концу забега заняли эволюции */
  evolutions: number;
  /** секунда, на которой набор собран целиком (`isBuildComplete`); 0 — не собран за прогон */
  buildCompleteSec: number;
  /** сколько выборов уровня сделано к секунде сборки, а без сборки — за весь прогон */
  buildPicks: number;
  /**
   * рубеж: пришёл ли страж и взят ли он — доли забегов бота в коридорах калибровки.
   * Прогон отдаёт его всегда; необязательное, чтобы фикстуры воркера не знали о рубеже
   */
  rubezh?: RunRubezh;
  /** забег упёрся в аварийный потолок, а не кончился смертью или сборкой набора */
  timedOut: boolean;
  /** урон, полученный за каждую полную минуту забега; неполная последняя в массив не входит */
  damageTakenByMinute: number[];
  /** сила игрока в очках на старте; 0 — подстройки не было */
  startPower: number;
  /** уровень давления на старте; 1 — подстройки не было */
  startPressure: number;
  /** уровень давления на последнем пересчёте; 1 — подстройки не было */
  endPressure: number;
  /** доля собранного набора (`buildScoreOf`) на каждой полной минуте — вход расписания сборки */
  buildScoreByMinute: number[];
  /** убийств с начала забега на каждой полной минуте — вход таблицы ожидаемого (T-0291) */
  killsByMinute: number[];
  /** сколько записей журнала охоты было на каждой полной минуте: срез `huntLog` до минуты */
  huntLogCountByMinute: number[];
  /** оценка сборки итога (`buildScore` из журнала охоты, не доля `buildScoreOf`) на каждой полной минуте */
  buildPointsByMinute: number[];
  /** журнал охоты за весь прогон: убитые элиты и боссы с ценностью и временем жизни */
  huntLog: RunHuntEntry[];
}

export function simulateBalanceRun(options: BalanceRunOptions): BalanceRunResult {
  const content = options.content ?? CONTENT_SNAPSHOT;
  const difficulty = content.difficulties.find((level) => level.id === (options.difficultyId ?? DEFAULT_DIFFICULTY_ID));
  const accountLevel = options.loadout?.accountLevel ?? options.accountLevel;
  const open = accountLevel === undefined ? null : unlocksAt(content.accountUnlocks, accountLevel);
  const world = createWorld({
    seed: options.seed,
    enemies: content.enemies,
    stages: content.stages,
    weapons: open === null ? content.weapons : weaponsOpenAt(content.weapons, open),
    passives: open === null ? content.passives : content.passives.filter((passive) => open.passives.has(passive.id)),
    levelCurve: content.levelCurve,
    loadoutLimits: open?.limits ?? content.loadoutLimits,
    drops: content.drops,
    chests: content.chests,
    secrets: content.secrets,
    ...(options.pressure === false ? {} : { pressure: content.pressure }),
    boosts: content.boosts,
    maxBoostsPerRun: content.maxBoostsPerRun,
    ...(options.loadout === undefined ? {} : { loadout: options.loadout }),
    // Переброс и изгнание даёт уровень аккаунта, как в забеге (`run-world.ts`); пользуется ими
    // только сильный бот, остальные боты заряды не тратят, и их забеги от этого не меняются.
    ...(accountLevel === undefined ? {} : { cardTools: cardToolsAt(content.cardToolUnlocks, accountLevel) }),
    rubezh: RUBEZH,
    limits: content.limits,
    timeline: content.timeline,
    endlessCurve: content.endlessCurve,
    map: content.maps[0],
    ...(difficulty === undefined ? {} : { difficulty }),
    ...(options.startingWeaponId === undefined
      ? {}
      : { startingWeaponId: options.startingWeaponId }),
    // Здоровье на миллион, как в нагрузочных прогонах: игрок не умирает, но
    // каждое попадание по-прежнему считается в `damageTaken`.
    ...(options.immortalPlayer === true
      ? { config: { player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 1_000_000 } } }
      : {}),
  });
  if (options.godMode === true) world.cheats.godMode = true;
  const director = createTimelineDirector(content.timeline, content.endlessCurve);
  const bot = options.skill === "strong" ? createStrongBot({ stance: options.stance ?? "kite" }) : createBot(options.skill, options.bot);
  const maxTicks = Math.round((options.maxSec ?? DEFAULT_MAX_SEC) / TICK_SEC);

  const damageTakenByMinute: number[] = [];
  const buildScoreByMinute: number[] = [];
  const killsByMinute: number[] = [];
  const huntLogCountByMinute: number[] = [];
  const buildPointsByMinute: number[] = [];
  let damageAtMinuteStart = 0;
  let firstLevelUpSec = 0;
  let buildCompleteSec = 0;
  let picks = 0;
  let buildPicks = 0;
  let tick = 0;
  while (tick < maxTicks && world.player.alive) {
    // Выбор делается до шага: пока он не сделан, мир стоит, и цикл крутился бы
    // вхолостую до конца прогона.
    if (isAwaitingChoice(world)) {
      if (firstLevelUpSec === 0) firstLevelUpSec = world.stats.elapsedSec;
      const choice = bot.choose(world.progression.offers, world);
      // Переброс и изгнание выбора не закрывают: мир ждёт дальше, а заряды конечны.
      if (isCardToolCommand(choice) && applyCardTool(world, choice) !== null) {
        continue;
      }
      if (isCardToolCommand(choice)) {
        // Команда не сработала (заряда нет): первая карточка, иначе мир ждал бы вечно.
        chooseUpgrade(world, world.progression.offers[0].id);
        picks++;
      } else {
        chooseUpgrade(world, choice);
        picks++;
      }
      continue;
    }

    director.update(world, TICK_SEC);
    stepWorld(world, bot.input(world));
    tick++;

    // Раз в тик, пока набор не собран: слотов немного, а секунда сборки нужна
    // точная. Сундук тоже улучшает набор, поэтому смотрим после шага, а не
    // после выбора карточки.
    if (buildCompleteSec === 0 && isBuildComplete(world)) {
      buildCompleteSec = world.stats.elapsedSec;
      buildPicks = picks;
      if (options.stopOnBuild === true) break;
    }

    // Минута закрывается, когда забег её прошёл целиком: урон считается по
    // границам, а не по таймеру внутри мира.
    if (Math.floor(world.stats.elapsedSec / 60) > damageTakenByMinute.length) {
      damageTakenByMinute.push(world.stats.damageTaken - damageAtMinuteStart);
      damageAtMinuteStart = world.stats.damageTaken;
      buildScoreByMinute.push(buildScoreOf(world));
      killsByMinute.push(world.stats.enemiesKilled);
      huntLogCountByMinute.push(world.hunt.log.length);
      buildPointsByMinute.push(buildScore(world));
    }
  }

  const pressured = isPressureActive(world);
  return {
    seed: options.seed,
    skill: options.skill,
    startingWeaponId: startingWeaponOf(world),
    survivalSec: world.stats.elapsedSec,
    level: world.progression.level,
    wave: world.difficulty.segment,
    enemiesKilled: world.stats.enemiesKilled,
    xpCollected: world.stats.xpCollected,
    peakEnemies: world.stats.peakEnemies,
    firstLevelUpSec,
    chestsFound: world.stats.chestsFound,
    chestsOpened: world.stats.chestsOpened,
    evolutions: world.loadout.weapons.filter((slot) => world.weaponTypes[slot.typeIndex]?.evolvedFrom !== undefined).length,
    buildCompleteSec,
    buildPicks: buildCompleteSec === 0 ? picks : buildPicks,
    rubezh: describeRubezh(world),
    timedOut: world.player.alive && !(options.stopOnBuild === true && buildCompleteSec > 0),
    damageTakenByMinute,
    startPower: pressured ? world.difficulty.startPower : 0,
    startPressure: pressured ? world.difficulty.startPressure : 1,
    endPressure: pressured ? world.difficulty.pressureLevel : 1,
    buildScoreByMinute,
    killsByMinute,
    huntLogCountByMinute,
    buildPointsByMinute,
    huntLog: world.hunt.log.map((entry) => ({ ...entry })),
  };
}

function startingWeaponOf(world: { loadout: { weapons: { typeIndex: number }[] }; weaponTypes: { id: string }[] }): string {
  const first = world.loadout.weapons[0];
  return first === undefined ? "" : world.weaponTypes[first.typeIndex].id;
}

/** Квантиль по уже отсортированному набору; линейная интерполяция не нужна. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[index];
}

export interface BalanceSummary {
  runs: number;
  medianSurvivalSec: number;
  p10SurvivalSec: number;
  p90SurvivalSec: number;
  /** доля забегов, оборвавшихся до минуты, — «умер, не поняв, во что играет» */
  deathsBeforeMinuteRatio: number;
  medianLevel: number;
  medianWave: number;
  medianFirstLevelUpSec: number;
  /** медиана открытых сундуков за забег */
  medianChestsOpened: number;
  /** медиана слотов оружия, занятых эволюциями к концу забега */
  medianEvolutions: number;
  /** медиана секунды сборки набора по тем прогонам, где он собран; 0 — не собрал никто */
  medianBuildCompleteSec: number;
  /** доля прогонов, где набор собран */
  buildCompleteRatio: number;
  timedOut: number;
}

export function summarizeRuns(results: readonly BalanceRunResult[]): BalanceSummary {
  const survival = results.map((run) => run.survivalSec).sort((a, b) => a - b);
  const levels = results.map((run) => run.level).sort((a, b) => a - b);
  const waves = results.map((run) => run.wave).sort((a, b) => a - b);
  const firstLevelUps = results.map((run) => run.firstLevelUpSec).sort((a, b) => a - b);
  const chests = results.map((run) => run.chestsOpened).sort((a, b) => a - b);
  const evolutions = results.map((run) => run.evolutions).sort((a, b) => a - b);
  const builds = results.filter((run) => run.buildCompleteSec > 0).map((run) => run.buildCompleteSec).sort((a, b) => a - b);

  return {
    runs: results.length,
    medianSurvivalSec: quantile(survival, 0.5),
    p10SurvivalSec: quantile(survival, 0.1),
    p90SurvivalSec: quantile(survival, 0.9),
    deathsBeforeMinuteRatio:
      results.length === 0
        ? 0
        : results.filter((run) => run.survivalSec < 60).length / results.length,
    medianLevel: quantile(levels, 0.5),
    medianWave: quantile(waves, 0.5),
    medianFirstLevelUpSec: quantile(firstLevelUps, 0.5),
    medianChestsOpened: quantile(chests, 0.5),
    medianEvolutions: quantile(evolutions, 0.5),
    medianBuildCompleteSec: quantile(builds, 0.5),
    buildCompleteRatio: results.length === 0 ? 0 : builds.length / results.length,
    timedOut: results.filter((run) => run.timedOut).length,
  };
}
