import type { UpgradeOption, WeaponDef, WeaponLevel } from "@bh/shared-types";
import { EVOLUTION_POWER_RATIO } from "../../content/balance-targets";
import type { World } from "../sim/world";
import { evolutionChanges } from "./upgrade-changes";
import { refreshPlayerStats } from "./levels";
import { weaponSlotOf } from "./loadout";

/**
 * Эволюции оружия (docs/39-retention-mechanics.md Б2, tasks/T-0102): оружие
 * на максимальном уровне плюс навык рецепта превращаются в одну сильную версию
 * в том же слоте. Выдаёт её сундук забега; в карточках уровня её нет. Ни одной
 * случайности здесь нет: эволюция не двигает `world.rng`.
 */

export type EvolutionState = "absent" | "waiting" | "ready" | "done";

/** Набор по id и уровням: так им пользуются и движок, и экран, у которого нет мира. */
export interface LoadoutIds {
  weapons: readonly { id: string; level: number }[];
  passives: readonly { id: string; level: number }[];
}

/** Что нужно знать об оружии, чтобы разобрать рецепты: подходят и `WeaponDef`, и тип мира. */
export interface EvolutionSource {
  id: string;
  evolvedFrom?: string | undefined;
  recipe?: { passive: string } | undefined;
  levels: readonly unknown[];
}

export interface EvolutionProgress {
  evolutionId: string;
  weaponId: string;
  passiveId: string;
  /** уровень базового оружия в наборе; `null` — его нет */
  weaponLevel: number | null;
  weaponMaxLevel: number;
  hasPassive: boolean;
  state: EvolutionState;
}

/** Состояние каждой эволюции по набору, в порядке контента. */
export function evolutionProgress(defs: readonly EvolutionSource[], loadout: LoadoutIds): EvolutionProgress[] {
  const progress: EvolutionProgress[] = [];
  for (const def of defs) {
    if (def.evolvedFrom === undefined || def.recipe === undefined) continue;
    const source = defs.find((candidate) => candidate.id === def.evolvedFrom);
    const weaponMaxLevel = source?.levels.length ?? 0;
    const weaponLevel = loadout.weapons.find((weapon) => weapon.id === def.evolvedFrom)?.level ?? null;
    const hasPassive = loadout.passives.some((passive) => passive.id === def.recipe?.passive);
    let state: EvolutionState;
    if (loadout.weapons.some((weapon) => weapon.id === def.id)) state = "done";
    else if (weaponLevel === null) state = "absent";
    else state = weaponLevel >= weaponMaxLevel && hasPassive ? "ready" : "waiting";
    progress.push({ evolutionId: def.id, weaponId: def.evolvedFrom, passiveId: def.recipe.passive, weaponLevel, weaponMaxLevel, hasPassive, state });
  }
  return progress;
}

function worldSources(world: World): EvolutionSource[] {
  return world.weaponTypes.map((type) => ({
    id: type.id,
    evolvedFrom: type.evolvedFrom,
    recipe: type.recipePassive === undefined ? undefined : { passive: type.recipePassive },
    levels: type.levels,
  }));
}

function worldLoadout(world: World): LoadoutIds {
  return {
    weapons: world.loadout.weapons.map((slot) => ({ id: world.weaponTypes[slot.typeIndex]?.id ?? "", level: slot.level })),
    passives: world.loadout.passives.map((slot) => ({ id: world.passiveTypes[slot.typeIndex]?.id ?? "", level: slot.level })),
  };
}

/** Первая готовая эволюция по порядку в контенте; в мире, где её нет, — пропускается. */
function firstReady(world: World): EvolutionProgress | undefined {
  return evolutionProgress(worldSources(world), worldLoadout(world)).find((entry) => entry.state === "ready" && world.weaponTypes.some((type) => type.id === entry.evolutionId));
}

/**
 * Вариант награды «превратить оружие в эволюцию» для сундука; `null` — ничего
 * не готово. Строки «было → стало» — от последнего уровня базового к
 * единственному уровню эволюции.
 */
export function readyEvolutionOption(world: World): UpgradeOption | null {
  const ready = firstReady(world);
  if (ready === undefined) return null;
  const evolved = world.weaponTypes.find((type) => type.id === ready.evolutionId);
  const base = world.weaponTypes.find((type) => type.id === ready.weaponId);
  if (evolved === undefined || base === undefined) return null;
  return {
    id: `weapon_evolve:${evolved.id}:1`,
    kind: "weapon_evolve",
    refId: evolved.id,
    level: 1,
    nameKey: evolved.nameKey,
    descriptionKey: evolved.descriptionKey,
    changes: evolutionChanges(base, evolved, world.config.unitScale),
  };
}

/**
 * Эволюция занимает слот базового: меняются тип и уровень, перезарядка и
 * направление остаются, слоты и пассивки не трогаются. `false` — рецепт уже не
 * выполнен: выбор приходит снаружи, и доверять ему нельзя.
 */
export function applyEvolution(world: World, evolutionId: string): boolean {
  const ready = evolutionProgress(worldSources(world), worldLoadout(world)).find((entry) => entry.evolutionId === evolutionId);
  if (ready?.state !== "ready") return false;
  const evolvedIndex = world.weaponTypes.findIndex((type) => type.id === evolutionId);
  const slot = weaponSlotOf(world.loadout, world.weaponTypes.findIndex((type) => type.id === ready.weaponId));
  if (evolvedIndex < 0 || slot < 0) return false;
  const target = world.loadout.weapons[slot];
  if (target === undefined) return false;
  target.typeIndex = evolvedIndex;
  target.level = 1;
  refreshPlayerStats(world);
  return true;
}

/**
 * Можно ли предлагать оружие карточкой или сундуком: эволюцию — никогда, а
 * базовое — пока его эволюция не взята (иначе оно заняло бы второй слот).
 */
export function isWeaponOfferable(world: World, typeIndex: number): boolean {
  const type = world.weaponTypes[typeIndex];
  if (type === undefined || type.evolvedFrom !== undefined) return false;
  const taken = world.loadout.weapons.map((slot) => world.weaponTypes[slot.typeIndex]);
  return !world.weaponTypes.some((candidate) => candidate.evolvedFrom === type.id && taken.includes(candidate));
}

/** Сила уровня: урон на число снарядов в секунду. По ней сравнивают эволюцию с базовым. */
export function weaponPowerIndex(level: Pick<WeaponLevel, "damage" | "cooldownSec"> & { projectiles?: number | undefined }): number {
  return (level.damage * Math.max(level.projectiles ?? 1, 1)) / level.cooldownSec;
}

/** Оружие и навык рецепта эволюции; `null` — такой эволюции нет. */
export function describeEvolution(defs: readonly EvolutionSource[], evolutionId: string): { weaponId: string; passiveId: string } | null {
  const def = defs.find((candidate) => candidate.id === evolutionId);
  if (def?.evolvedFrom === undefined || def.recipe === undefined) return null;
  return { weaponId: def.evolvedFrom, passiveId: def.recipe.passive };
}

/** Ошибки эволюций в контенте — сообщением, которое называет оружие и поле. */
export function findEvolutionProblems(defs: readonly WeaponDef[], passiveIds: readonly string[]): string[] {
  const problems: string[] = [];
  const bases = defs.filter((def) => def.evolvedFrom === undefined);
  const lastBase = defs.reduce((last, def, index) => (def.evolvedFrom === undefined ? index : last), -1);
  const recipeOwner = new Map<string, string>();

  defs.forEach((def, index) => {
    if (def.evolvedFrom === undefined || def.recipe === undefined) return;
    const source = defs.find((candidate) => candidate.id === def.evolvedFrom);
    if (source === undefined) return void problems.push(`оружие ${def.id}: evolvedFrom ${def.evolvedFrom} — такого оружия нет`);
    if (source.evolvedFrom !== undefined) return void problems.push(`оружие ${def.id}: evolvedFrom ${source.id} — это эволюция, цепочек нет`);
    if (index < lastBase) problems.push(`оружие ${def.id}: после всех базовых — эволюция стоит раньше оружия ${defs[lastBase]?.id ?? ""}`);
    if (def.levels.length !== 1) problems.push(`оружие ${def.id}: один уровень, а не ${String(def.levels.length)}`);
    if (def.behavior !== source.behavior || def.element !== source.element) problems.push(`оружие ${def.id}: behavior и element — как у ${source.id}`);

    const passive = def.recipe.passive;
    if (!passiveIds.includes(passive)) problems.push(`оружие ${def.id}: recipe.passive ${passive} — такого навыка нет`);
    const other = recipeOwner.get(passive);
    if (other !== undefined) problems.push(`оружие ${def.id}: recipe.passive ${passive} уже в рецепте ${other}`);
    recipeOwner.set(passive, def.id);

    const top = source.levels.at(-1);
    const only = def.levels[0];
    if (top !== undefined && only !== undefined && top.cooldownSec > 0 && only.cooldownSec > 0) {
      const ratio = weaponPowerIndex(only) / weaponPowerIndex(top);
      if (!(ratio >= EVOLUTION_POWER_RATIO.min && ratio <= EVOLUTION_POWER_RATIO.max)) {
        problems.push(`оружие ${def.id}: сила ×${(Math.round(ratio * 100) / 100).toString()} вне коридора ${String(EVOLUTION_POWER_RATIO.min)}…${String(EVOLUTION_POWER_RATIO.max)}`);
      }
    }
  });

  for (const base of bases) {
    const own = defs.filter((def) => def.evolvedFrom === base.id);
    if (own.length === 0) problems.push(`оружие ${base.id}: нет эволюции`);
    if (own.length > 1) problems.push(`оружие ${base.id}: две эволюции (${own.map((def) => def.id).join(", ")}), ожидается одна`);
  }
  return problems;
}
