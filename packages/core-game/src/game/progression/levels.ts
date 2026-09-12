import type { LevelCurveDef, UpgradeOption } from "@bh/shared-types";
import type { World } from "../sim/world";
import { computePlayerStats } from "./passives";
import {
  addPassive,
  addWeapon,
  passiveLevels,
  passiveSlotOf,
  weaponSlotOf,
} from "./loadout";

/** Сколько вариантов показывается при наборе уровня. */
export const OFFERS_PER_LEVEL = 3;

/** Доля максимального здоровья, которую лечит запасной вариант. */
const HEAL_RATIO = 0.3;

export const HEAL_OPTION_ID = "heal";

/**
 * Опыт, нужный для перехода с текущего уровня на следующий. Формула, а не
 * таблица: геймдизайнеру нужно крутить темп, а не сто чисел по отдельности.
 * Округление — вверх до целого, чтобы прогресс не зависел от дробных остатков.
 */
export function xpForLevel(curve: LevelCurveDef, level: number): number {
  // Умножение в цикле, а не Math.pow: степень по спецификации ECMAScript
  // приближённая и может разойтись между JS-движками, а от порога опыта
  // зависит, на каком тике игрок получит уровень (docs/26-stage2-plan.md, WP4.5).
  let raw = curve.baseXp;
  for (let step = 1; step < level; step++) raw *= curve.growth;
  return Math.max(1, Math.ceil(raw));
}

/**
 * Начислить опыт. Уровни копятся в очередь: за один тик можно набрать
 * несколько, а выбор игрок делает по одному — иначе три экрана подряд
 * схлопнулись бы в один и два улучшения пропали.
 */
export function addXp(world: World, amount: number): void {
  const progression = world.progression;
  progression.xp += amount;
  progression.totalXp += amount;
  world.stats.xpCollected += amount;

  while (progression.xp >= progression.xpToNext) {
    progression.xp -= progression.xpToNext;
    progression.level++;
    progression.pendingLevelUps++;
    progression.xpToNext = xpForLevel(world.levelCurve, progression.level);
  }
}

/** Ждёт ли симуляция выбора игрока. */
export function isAwaitingChoice(world: World): boolean {
  return world.progression.offers.length > 0;
}

/**
 * Подготовить варианты для ближайшего уровня из очереди. Возвращает пустой
 * список, если выбирать не из чего или очередь пуста.
 *
 * Варианты берутся генератором мира: одинаковый seed и одинаковый ход забега
 * дают одинаковые предложения, иначе повтор забега разойдётся на первом же
 * уровне.
 */
export function prepareOffers(world: World): UpgradeOption[] {
  const progression = world.progression;
  if (progression.pendingLevelUps <= 0 || progression.offers.length > 0) {
    return progression.offers;
  }

  const candidates = collectCandidates(world);
  progression.offers =
    candidates.length === 0 ? [healOption()] : pickWeighted(world, candidates, OFFERS_PER_LEVEL);
  return progression.offers;
}

interface Candidate {
  option: UpgradeOption;
  weight: number;
}

function collectCandidates(world: World): Candidate[] {
  const candidates: Candidate[] = [];
  const loadout = world.loadout;

  world.weaponTypes.forEach((type, typeIndex) => {
    const slot = weaponSlotOf(loadout, typeIndex);
    if (slot < 0) {
      if (loadout.weapons.length >= world.loadoutLimits.weapons) return;
      candidates.push({
        weight: type.weight,
        option: {
          id: `weapon_new:${type.id}:1`,
          kind: "weapon_new",
          refId: type.id,
          level: 1,
          nameKey: type.nameKey,
          descriptionKey: type.descriptionKey,
        },
      });
      return;
    }

    const nextLevel = loadout.weapons[slot].level + 1;
    if (nextLevel > type.levels.length) return;
    candidates.push({
      weight: type.weight,
      option: {
        id: `weapon_level:${type.id}:${nextLevel}`,
        kind: "weapon_level",
        refId: type.id,
        level: nextLevel,
        nameKey: type.nameKey,
        descriptionKey: type.descriptionKey,
      },
    });
  });

  world.passiveTypes.forEach((type, typeIndex) => {
    const slot = passiveSlotOf(loadout, typeIndex);
    if (slot < 0) {
      if (loadout.passives.length >= world.loadoutLimits.passives) return;
      candidates.push({
        weight: type.weight,
        option: {
          id: `passive_new:${type.id}:1`,
          kind: "passive_new",
          refId: type.id,
          level: 1,
          nameKey: type.nameKey,
          descriptionKey: type.descriptionKey,
        },
      });
      return;
    }

    const nextLevel = loadout.passives[slot].level + 1;
    if (nextLevel > type.levels.length) return;
    candidates.push({
      weight: type.weight,
      option: {
        id: `passive_level:${type.id}:${nextLevel}`,
        kind: "passive_level",
        refId: type.id,
        level: nextLevel,
        nameKey: type.nameKey,
        descriptionKey: type.descriptionKey,
      },
    });
  });

  return candidates;
}

/** Взвешенный выбор без повторов: один и тот же вариант не предлагается дважды. */
function pickWeighted(world: World, candidates: Candidate[], count: number): UpgradeOption[] {
  const pool = [...candidates];
  const picked: UpgradeOption[] = [];

  while (picked.length < count && pool.length > 0) {
    let total = 0;
    for (const candidate of pool) total += candidate.weight;

    let roll = world.rng.nextFloat() * total;
    let index = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      roll -= pool[i].weight;
      if (roll <= 0) {
        index = i;
        break;
      }
    }

    picked.push(pool[index].option);
    pool.splice(index, 1);
  }
  return picked;
}

/**
 * Запасной вариант, когда всё собрано и прокачано до потолка: выбор из
 * ничего хуже, чем небольшая награда.
 */
function healOption(): UpgradeOption {
  return {
    id: HEAL_OPTION_ID,
    kind: "heal",
    refId: "",
    level: 0,
    nameKey: "upgrade.heal.name",
    descriptionKey: "upgrade.heal.description",
  };
}

/**
 * Применить выбор игрока. Возвращает `false`, если такого варианта нет среди
 * предложенных: выбор приходит снаружи — из интерфейса или из лога ввода при
 * повторе забега, — и доверять ему нельзя.
 */
export function chooseUpgrade(world: World, optionId: string): boolean {
  const option = world.progression.offers.find((candidate) => candidate.id === optionId);
  if (option === undefined) return false;

  switch (option.kind) {
    case "weapon_new": {
      const typeIndex = world.weaponTypes.findIndex((type) => type.id === option.refId);
      if (typeIndex >= 0) addWeapon(world.loadout, typeIndex);
      break;
    }
    case "weapon_level": {
      const typeIndex = world.weaponTypes.findIndex((type) => type.id === option.refId);
      const slot = weaponSlotOf(world.loadout, typeIndex);
      if (slot >= 0) world.loadout.weapons[slot].level = option.level;
      break;
    }
    case "passive_new": {
      const typeIndex = world.passiveTypes.findIndex((type) => type.id === option.refId);
      if (typeIndex >= 0) addPassive(world.loadout, typeIndex);
      break;
    }
    case "passive_level": {
      const typeIndex = world.passiveTypes.findIndex((type) => type.id === option.refId);
      const slot = passiveSlotOf(world.loadout, typeIndex);
      if (slot >= 0) world.loadout.passives[slot].level = option.level;
      break;
    }
    default:
      world.player.hp = Math.min(world.playerStats.maxHp, world.player.hp + world.playerStats.maxHp * HEAL_RATIO);
  }

  refreshPlayerStats(world);
  world.progression.offers = [];
  world.progression.pendingLevelUps = Math.max(0, world.progression.pendingLevelUps - 1);
  return true;
}

/**
 * Пересчитать характеристики игрока целиком. Максимальное здоровье растёт
 * вместе с текущим: пассивка на живучесть, которая не лечит, ощущается как
 * обман, а отнимать уже полученное лечение при пересчёте нельзя.
 */
export function refreshPlayerStats(world: World): void {
  const previousMaxHp = world.playerStats.maxHp;
  world.playerStats = computePlayerStats(
    world.playerStatsBase,
    world.passiveTypes,
    passiveLevels(world.loadout),
  );

  const gained = world.playerStats.maxHp - previousMaxHp;
  if (gained > 0) world.player.hp += gained;
  world.player.maxHp = world.playerStats.maxHp;
  if (world.player.hp > world.playerStats.maxHp) world.player.hp = world.playerStats.maxHp;
}
