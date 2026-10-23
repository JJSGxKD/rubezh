import type { UpgradeOption } from "@bh/shared-types";
import { evolutionProgress, WEAPONS, WEAPON_EVOLUTIONS, type EvolutionProgress, type EvolutionState, type LoadoutIds } from "@bh/core-game";

/**
 * Рецепты эволюций для интерфейса забега (tasks/T-0103, docs/39-retention-mechanics.md Б2):
 * какую подсказку показать на карточке и в каком состоянии слот. Правила —
 * чистые функции поверх `evolutionProgress`, чтобы их проверяли тесты без
 * отрисовки; имена предметов подставляет компонент по id.
 */

export interface OfferHint {
  key: "run.evolution.hintWeapon" | "run.evolution.hintWeaponReady" | "run.evolution.hintPassive";
  /** id предметов, а не названия: переводит компонент */
  params: Record<string, string>;
}

function maxLevelOf(weaponId: string): number {
  return WEAPONS.find((weapon) => weapon.id === weaponId)?.levels.length ?? 0;
}

/**
 * Подсказка под карточкой выбора: не больше одной строки и только когда есть
 * смысл. Навыку рецепта подсказка нужна, лишь если базовое оружие уже в наборе —
 * иначе это шум.
 */
export function hintForOffer(offer: UpgradeOption, loadout: LoadoutIds): OfferHint | null {
  if (offer.kind === "weapon_new" || offer.kind === "weapon_level") {
    const evolution = WEAPON_EVOLUTIONS.find((weapon) => weapon.evolvedFrom === offer.refId);
    if (evolution?.recipe === undefined) return null;
    if (loadout.weapons.some((weapon) => weapon.id === evolution.id)) return null;
    const params = { passive: evolution.recipe.passive, evolution: evolution.id };
    const hasPassive = loadout.passives.some((passive) => passive.id === evolution.recipe?.passive);
    const reachesMax = offer.kind === "weapon_level" && offer.level >= maxLevelOf(offer.refId);
    return { key: reachesMax && hasPassive ? "run.evolution.hintWeaponReady" : "run.evolution.hintWeapon", params };
  }
  if (offer.kind === "passive_new" || offer.kind === "passive_level") {
    const evolution = WEAPON_EVOLUTIONS.find((weapon) => weapon.recipe?.passive === offer.refId);
    if (evolution?.evolvedFrom === undefined) return null;
    const base = evolution.evolvedFrom;
    if (!loadout.weapons.some((weapon) => weapon.id === base)) return null;
    if (loadout.weapons.some((weapon) => weapon.id === evolution.id)) return null;
    return { key: "run.evolution.hintPassive", params: { weapon: base, evolution: evolution.id } };
  }
  return null;
}

/** Эволюция слота: по базовому оружию или по самой эволюции; `null` — у оружия эволюции нет. */
export function slotEvolution(loadout: LoadoutIds, weaponId: string): EvolutionProgress | null {
  return evolutionProgress(WEAPONS, loadout).find((progress) => progress.weaponId === weaponId || progress.evolutionId === weaponId) ?? null;
}

export function slotEvolutionState(loadout: LoadoutIds, weaponId: string): EvolutionState {
  return slotEvolution(loadout, weaponId)?.state ?? "absent";
}

/** Это оружие — эволюция: вместо единственного уровня ему пишут слово. */
export function isEvolutionWeapon(id: string): boolean {
  return WEAPON_EVOLUTIONS.some((weapon) => weapon.id === id);
}
