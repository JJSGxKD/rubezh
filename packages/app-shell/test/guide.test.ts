import { describe, expect, it } from "vitest";
import { ENEMIES, LOADOUT_LIMITS, PASSIVES, WEAPONS } from "@bh/core-game";
import { hasTranslation } from "../src/i18n";
// Словарь гайдбука приезжает вместе с его чанком — тест грузит его так же.
import "../src/i18n/guide";
import {
  eliteEnemies,
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
    for (const weapon of WEAPONS) {
      expect(hasTranslation(`guide.behavior.${weapon.behavior}`), weapon.behavior).toBe(true);
    }
  });

  it("показывает всех врагов ровно по одному разу: обычных и элиту отдельно", () => {
    const shown = [...regularEnemies(), ...eliteEnemies()].map((enemy) => enemy.def.id);
    expect(shown.sort()).toEqual(ENEMIES.map((enemy) => enemy.id).sort());
    expect(eliteEnemies().every((enemy) => enemy.def.rank !== undefined)).toBe(true);
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
    for (const weapon of WEAPONS) {
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
      for (const element of [...strong, ...weak]) expect(hasTranslation(`guide.element.${element}`), enemy.id).toBe(true);
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
    for (const weapon of WEAPONS.filter((candidate) => candidate.element !== undefined)) {
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
  });
});
