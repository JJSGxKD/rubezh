import { ELEMENTS, type ElementId, type RunOutcome, type RunPassiveSummary, type RunResult, type RunWeaponSummary } from "@bh/shared-types";
import { continueSeconds } from "../sim/continue";
import { TICK_HZ, type World } from "../sim/world";

/**
 * Итог забега: то, что видит игрок на экране смерти и что оболочка отправляет
 * событием `run_finished` / `run_abandoned` (docs/26-stage2-plan.md, WP3).
 *
 * Счётчики копятся в мире по ходу забега, а объект собирается один раз в
 * конце: в кадре здесь не аллоцируется ничего.
 *
 * Движок только считает. Ни отправкой, ни хранением рекорда он не занимается —
 * о сети и о платформе он не знает (docs/15-engineering-standards.md §2.2).
 */
export interface RunResultOptions {
  runId: string;
  seed: number;
  outcome: RunOutcome;
  startingWeaponId: string;
  /**
   * Отпечаток контента передаётся снаружи, а не читается отсюда: слой забега
   * не импортирует content/* — иначе движок нельзя прогнать на фикстурах, и
   * тест симуляции превращается в тест текущего баланса.
   */
  contentHash: string;
  /** в забеге включали читы режима разработчика */
  cheats?: boolean;
}

export function buildRunResult(world: World, options: RunResultOptions): RunResult {
  const stats = world.stats;

  return {
    runId: options.runId,
    seed: options.seed,
    outcome: options.outcome,
    startingWeaponId: options.startingWeaponId,
    mapId: world.mapId,
    difficultyId: world.difficultyLevel.id,
    contentHash: options.contentHash,
    waveReached: world.difficulty.segment,
    survivalSec: stats.elapsedSec,
    level: world.progression.level,
    xpCollected: stats.xpCollected,
    enemiesKilled: stats.enemiesKilled,
    bossKills: stats.bossKills,
    eliteKills: stats.eliteKills,
    chestsOpened: stats.chestsOpened,
    crystalsCollected: stats.crystalsCollected,
    killsByEnemy: killsByEnemy(world),
    damageDealt: stats.damageDealt,
    damageTaken: stats.damageTaken,
    damageByElement: damageByElement(world),
    // Серии идут в итог целыми секундами вниз: без попаданий — лучшая из закрытых и текущей на конец забега
    // (кто выстоял десять минут и сдался, свою серию прошёл), без убийств — только закрытые убийством.
    noHitSec: Math.floor(Math.max(stats.longestNoHitTicks, stats.tick - stats.lastHitTick) / TICK_HZ),
    noKillSec: Math.floor(stats.longestNoKillTicks / TICK_HZ),
    killsByElement: killsByElement(world),
    weapons: weaponSummaries(world),
    passives: passiveSummaries(world),
    // Сдача — это не смерть: причина смерти у неё пустая, иначе в аналитике
    // забег, из которого вышли на первой минуте, выглядел бы как убийство.
    deathCause: deathCause(world, options.outcome),
    distance: stats.distance,
    peakEnemies: stats.peakEnemies,
    cheats: options.cheats === true,
    continues: continueSeconds(world),
    ...(world.boosts.ids.length === 0 ? {} : { boosts: [...world.boosts.ids] }),
  };
}

/**
 * Убийства по id врага. Нули не попадают: в выгрузке телеметрии на каждый
 * забег иначе едет полный список типов, из которых половина не встретилась.
 */
function killsByEnemy(world: World): Record<string, number> {
  const kills: Record<string, number> = {};

  for (let typeIndex = 0; typeIndex < world.enemyTypes.length; typeIndex++) {
    const count = world.stats.killsByType[typeIndex];
    if (count > 0) kills[world.enemyTypes[typeIndex].id] = count;
  }
  return kills;
}

/** Убийства по стихиям; физических в словаре нет, стихии без убийств не попадают. */
function killsByElement(world: World): Partial<Record<ElementId, number>> {
  const kills: Partial<Record<ElementId, number>> = {};
  ELEMENTS.forEach((element, index) => {
    const count = world.stats.killsByElement[index] ?? 0;
    if (count > 0 && element !== "physical") kills[element] = count;
  });
  return kills;
}

/** Урон по стихиям; стихии без урона не попадают. */
function damageByElement(world: World): Partial<Record<ElementId, number>> {
  const damage: Partial<Record<ElementId, number>> = {};
  ELEMENTS.forEach((element, index) => {
    const dealt = world.stats.damageByElement[index] ?? 0;
    if (dealt > 0) damage[element] = dealt;
  });
  return damage;
}

/**
 * Урон по оружиям. Номер слота наружу не отдаётся — он внутренний и зависит
 * от порядка подбора; геймдизайнеру нужен id оружия.
 */
function weaponSummaries(world: World): RunWeaponSummary[] {
  return world.loadout.weapons.map((slot, index) => ({
    id: world.weaponTypes[slot.typeIndex].id,
    level: slot.level,
    damage: world.stats.damageByWeapon[index],
  }));
}

function passiveSummaries(world: World): RunPassiveSummary[] {
  return world.loadout.passives.map((slot) => ({
    id: world.passiveTypes[slot.typeIndex].id,
    level: slot.level,
  }));
}

function deathCause(world: World, outcome: RunOutcome): string | null {
  if (outcome !== "died") return null;

  const typeIndex = world.stats.deathCauseType;
  // -1 — урон пришёл не от врага (сейчас таких источников нет, но появятся
  // ловушки и зоны); тип вне списка — забег на контенте, которого уже нет.
  if (typeIndex < 0 || typeIndex >= world.enemyTypes.length) return null;
  return world.enemyTypes[typeIndex].id;
}
