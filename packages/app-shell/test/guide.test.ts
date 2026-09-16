import { describe, expect, it } from "vitest";
import { ENEMIES, LOADOUT_LIMITS, PASSIVES, WEAPONS } from "@bh/core-game";
import { hasTranslation } from "../src/i18n";
import {
  eliteEnemies,
  passiveCategories,
  passiveRange,
  regularEnemies,
  speedClass,
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
