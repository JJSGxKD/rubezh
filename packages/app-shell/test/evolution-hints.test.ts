import { describe, expect, it } from "vitest";
import type { UpgradeOption } from "@bh/shared-types";
import { EVOLUTION_POWER_RATIO, WEAPON_EVOLUTIONS } from "@bh/core-game";
import { hasTranslation, t } from "../src/i18n";
import "../src/i18n/run";
import "../src/i18n/guide";
import "../src/i18n/account";
import { evolutionRecipes, unlockLevel } from "../src/screens/guide/guide-data";
import { hintForOffer, isEvolutionWeapon, slotEvolutionState } from "../src/screens/run/evolution-hints";
import { hasOwnWeaponIcon } from "../src/screens/item-icons";

// Рецепты эволюций в игре (tasks/T-0103): подсказка на карточке, состояние
// слота, рецепты гайдбука. Правила — чистые функции, без отрисовки.

function offer(kind: UpgradeOption["kind"], refId: string, level = 1): UpgradeOption {
  return { id: `${kind}:${refId}:${String(level)}`, kind, refId, level, nameKey: "x", descriptionKey: "y", changes: [] };
}

const set = (weapons: [string, number][], passives: [string, number][] = []) => ({
  weapons: weapons.map(([id, level]) => ({ id, level })),
  passives: passives.map(([id, level]) => ({ id, level })),
});

describe("подсказка рецепта на карточке", () => {
  it("новое оружие с эволюцией: с навыком станет эволюцией", () => {
    expect(hintForOffer(offer("weapon_new", "spark"), set([]))).toEqual({ key: "run.evolution.hintWeapon", params: { passive: "haste", evolution: "starfall" } });
  });

  it("уровень до максимума и навык в наборе — «Максимум!»", () => {
    expect(hintForOffer(offer("weapon_level", "spark", 8), set([["spark", 7]], [["haste", 1]]))?.key).toBe("run.evolution.hintWeaponReady");
  });

  it("то же без навыка — обычная подсказка", () => {
    expect(hintForOffer(offer("weapon_level", "spark", 8), set([["spark", 7]]))?.key).toBe("run.evolution.hintWeapon");
  });

  it("не максимум, даже с навыком, — обычная подсказка", () => {
    expect(hintForOffer(offer("weapon_level", "spark", 5), set([["spark", 4]], [["haste", 1]]))?.key).toBe("run.evolution.hintWeapon");
  });

  it("навык рецепта при базовом оружии в наборе — подсказка с оружием", () => {
    expect(hintForOffer(offer("passive_new", "haste"), set([["spark", 3]]))).toEqual({ key: "run.evolution.hintPassive", params: { weapon: "spark", evolution: "starfall" } });
  });

  it("навык без базового оружия в наборе — без подсказки, это шум", () => {
    expect(hintForOffer(offer("passive_level", "haste", 2), set([], [["haste", 1]]))).toBeNull();
  });

  it("навык вне рецептов, эволюция и лечение — без подсказки", () => {
    expect(hintForOffer(offer("passive_new", "might"), set([["spark", 3]]))).toBeNull();
    expect(hintForOffer(offer("weapon_evolve", "starfall"), set([["spark", 8]], [["haste", 1]]))).toBeNull();
    expect(hintForOffer(offer("heal", ""), set([]))).toBeNull();
  });

  it("эволюция уже в наборе — карточка базового оружия без подсказки", () => {
    expect(hintForOffer(offer("weapon_level", "spark", 2), set([["starfall", 1]]))).toBeNull();
  });
});

describe("состояние слота", () => {
  it("готово, ждёт, сделано, нет эволюции", () => {
    expect(slotEvolutionState(set([["spark", 8]], [["haste", 1]]), "spark")).toBe("ready");
    expect(slotEvolutionState(set([["spark", 8]]), "spark")).toBe("waiting");
    expect(slotEvolutionState(set([["starfall", 1]]), "starfall")).toBe("done");
    expect(slotEvolutionState(set([["starfall", 1]]), "spark")).toBe("done");
    expect(slotEvolutionState(set([["spark", 8]], [["haste", 1]]), "no_such_weapon")).toBe("absent");
  });

  it("оружие эволюции узнаётся по контенту", () => {
    expect(isEvolutionWeapon("starfall")).toBe(true);
    expect(isEvolutionWeapon("spark")).toBe(false);
  });
});

describe("рецепты в гайдбуке", () => {
  it("шесть строк в порядке контента, открытие — по старшему из оружия и навыка", () => {
    const recipes = evolutionRecipes(1);
    expect(recipes.map((recipe) => recipe.evolution)).toEqual(WEAPON_EVOLUTIONS.map((weapon) => weapon.id));
    for (const recipe of recipes) {
      expect(recipe.unlockLevel, recipe.evolution).toBe(Math.max(unlockLevel("weapon", recipe.weapon), unlockLevel("passive", recipe.passive)));
    }
  });

  it("закрыты те, чей уровень выше уровня аккаунта", () => {
    const closed = (level: number): string[] => evolutionRecipes(level).filter((recipe) => recipe.locked).map((recipe) => recipe.evolution);
    expect(closed(1).sort()).toEqual(["forge", "tempest", "viper"]);
    expect(closed(6)).toEqual([]);
  });

  it("сила эволюции лежит в коридоре", () => {
    for (const recipe of evolutionRecipes(1)) {
      expect(recipe.powerRatio, recipe.evolution).toBeGreaterThanOrEqual(EVOLUTION_POWER_RATIO.min);
      expect(recipe.powerRatio, recipe.evolution).toBeLessThanOrEqual(EVOLUTION_POWER_RATIO.max);
    }
  });

  it("у каждой эволюции свой значок", () => {
    for (const weapon of WEAPON_EVOLUTIONS) expect(hasOwnWeaponIcon(weapon.id), weapon.id).toBe(true);
  });
});

describe("тексты рецептов", () => {
  const expected: Record<string, string[]> = {
    "run.evolution.hintWeapon": ["passive", "evolution"],
    "run.evolution.hintWeaponReady": ["passive", "evolution"],
    "run.evolution.hintPassive": ["weapon", "evolution"],
    "run.evolution.recipe": ["evolution", "passive"],
    "run.evolution.ready": ["evolution"],
    "run.evolution.badge": [],
    "run.evolution.slotReady": [],
    "run.levelUp.evolve": [],
    "guide.weapons.evolutions": [],
    "guide.weapons.evolutionsIntro": [],
    "guide.evolution.recipe": ["weapon", "passive", "evolution"],
    "guide.evolution.power": ["ratio"],
    "guide.evolution.locked": ["level"],
    "runDetail.weaponEvolved": [],
  };

  it("все ключи есть, подстановки совпадают с параметрами кода", () => {
    for (const [key, params] of Object.entries(expected)) {
      expect(hasTranslation(key), key).toBe(true);
      const found = [...t(key, Object.fromEntries(params.map((name) => [name, `<${name}>`]))).matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      expect(found, key).toEqual([]);
    }
  });
});
