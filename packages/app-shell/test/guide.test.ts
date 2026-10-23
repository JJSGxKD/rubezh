import { describe, expect, it } from "vitest";
import { ENEMIES, LOADOUT_LIMITS, PASSIVES, BASE_WEAPONS, WEAPON_EVOLUTIONS } from "@bh/core-game";
import { hasTranslation } from "../src/i18n";
// Словарь гайдбука приезжает вместе с его чанком — тест грузит его так же.
import "../src/i18n/guide";
import {
  eliteEnemies,
  evolutionRecipes,
  enemyResists,
  passiveCategories,
  passiveRange,
  regularEnemies,
  speedClass,
  weaponElements,
  weaponGrowth,
} from "../src/screens/guide/guide-data";

// Гайдбук собирается из контента (docs/27-design-system-and-app-shell.md §6):
// враг или оружие, добавленные данными, обязаны получить в нём текст, а не
// ключ перевода на экране.

describe("гайдбук", () => {
  it("знает имя каждого врага и объясняет каждое поведение", () => {
    for (const enemy of ENEMIES) {
      expect(hasTranslation(`enemy.${enemy.id}.name`), enemy.id).toBe(true);
      for (const part of ["name", "text", "tip"]) {
        expect(hasTranslation(`guide.pattern.${enemy.pattern}.${part}`), `${enemy.pattern}.${part}`).toBe(true);
      }
    }
  });

  it("объясняет каждое поведение оружия", () => {
    for (const weapon of BASE_WEAPONS) {
      expect(hasTranslation(`guide.behavior.${weapon.behavior}`), weapon.behavior).toBe(true);
    }
  });

  it("показывает всех врагов ровно по одному разу: обычных и элиту отдельно", () => {
    const shown = [...regularEnemies(), ...eliteEnemies()].map((enemy) => enemy.def.id);
    expect(shown.sort()).toEqual(ENEMIES.map((enemy) => enemy.id).sort());
    expect(eliteEnemies().every((enemy) => enemy.def.rank !== undefined)).toBe(true);
  });

  it("называет новых пеших врагов по именам и показывает каждого один раз, элиту — отдельно", () => {
    const regular = regularEnemies().map((enemy) => enemy.def.id);
    const elite = eliteEnemies().map((enemy) => enemy.def.id);
    for (const id of ["bone_walker", "mire_shambler", "elite_grave_knight"]) {
      expect(hasTranslation(`enemy.${id}.name`), id).toBe(true);
    }
    expect(regular.filter((id) => id === "bone_walker")).toHaveLength(1);
    expect(regular.filter((id) => id === "mire_shambler")).toHaveLength(1);
    expect(elite.filter((id) => id === "elite_grave_knight")).toHaveLength(1);
    expect(regular).not.toContain("elite_grave_knight");
  });

  it("говорит, на кого распадается делящийся, с числом из контента или умолчания", () => {
    const splitters = [...regularEnemies(), ...eliteEnemies()].filter((enemy) => enemy.def.pattern === "splitter");
    expect(splitters.length).toBeGreaterThan(0);
    for (const splitter of splitters) {
      expect(splitter.children, splitter.def.id).not.toHaveLength(0);
      for (const child of splitter.children) expect(child.count).toBeGreaterThan(0);
    }
  });

  it("называет скорость словом по порогам, а не числом", () => {
    expect(speedClass(30)).toBe("slow");
    expect(speedClass(60)).toBe("medium");
    expect(speedClass(110)).toBe("fast");
  });

  it("показывает рост оружия только по тем числам, что меняются, и подписывает их", () => {
    for (const weapon of BASE_WEAPONS) {
      const growth = weaponGrowth(weapon);
      expect(growth.length, weapon.id).toBeGreaterThan(0);
      for (const change of growth) {
        expect(change.from).not.toBe(change.to);
        expect(hasTranslation(change.labelKey), change.labelKey).toBe(true);
      }
    }
  });

  it("называет и объясняет каждую стихию оружия и стойкости врагов", () => {
    const elements = weaponElements();
    expect(elements.length).toBeGreaterThan(0);
    for (const element of elements) {
      expect(hasTranslation(`guide.element.${element}`), element).toBe(true);
      expect(hasTranslation(`guide.status.${element}`), element).toBe(true);
      expect(hasTranslation(`upgrade.stat.statusChance.${element}`), element).toBe(true);
    }
    for (const enemy of ENEMIES) {
      const { strong, weak } = enemyResists(enemy);
      const attack = enemy.element === undefined ? [] : [enemy.element];
      for (const element of [...strong, ...weak, ...attack]) expect(hasTranslation(`guide.element.${element}`), enemy.id).toBe(true);
    }
  });

  it("делит стойкость врага на стойкость и слабость, а без стойкостей — пусто", () => {
    const [anyEnemy] = ENEMIES;
    if (anyEnemy === undefined) throw new Error("контент без врагов");
    expect(enemyResists({ ...anyEnemy, resist: { fire: 0.5, cold: -0.5, lightning: 0 } })).toEqual({
      strong: ["fire"],
      weak: ["cold"],
    });
    expect(enemyResists({ ...anyEnemy, resist: undefined })).toEqual({ strong: [], weak: [] });
  });

  it("показывает рост шанса состояния у стихийного оружия в процентах", () => {
    for (const weapon of BASE_WEAPONS.filter((candidate) => candidate.element !== undefined)) {
      const chance = weaponGrowth(weapon).find((change) => change.labelKey.startsWith("upgrade.stat.statusChance."));
      expect(chance, weapon.id).toBeDefined();
      expect(Number.isInteger(chance?.from) && Number.isInteger(chance?.to), weapon.id).toBe(true);
    }
  });

  it("раскладывает пассивки по категориям со слотами из контента", () => {
    const groups = passiveCategories();
    expect(groups.flatMap((group) => group.passives)).toHaveLength(PASSIVES.length);
    for (const group of groups) {
      expect(group.slots).toBe(LOADOUT_LIMITS.passives[group.category]);
    }
    for (const passive of PASSIVES) {
      const range = passiveRange(passive);
      expect(range === null ? false : hasTranslation(range.labelKey), passive.id).toBe(true);
    }
    // Сопротивление — процентами, как на карточке выбора.
    const tempering = PASSIVES.find((passive) => passive.stat === "resist");
    expect(tempering === undefined ? null : passiveRange(tempering)).toMatchObject({ from: 15, to: 60 });
  });

  it("у каждой эволюции есть строка рецепта, и название с описанием переведены", () => {
    const recipes = evolutionRecipes(1);
    for (const weapon of WEAPON_EVOLUTIONS) {
      expect(recipes.some((recipe) => recipe.evolution === weapon.id), weapon.id).toBe(true);
      expect(hasTranslation(weapon.nameKey), weapon.nameKey).toBe(true);
      expect(hasTranslation(weapon.descriptionKey), weapon.descriptionKey).toBe(true);
    }
  });
});
