import { readFileSync } from "node:fs";
import type { WeaponDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { EVOLUTION_POWER_RATIO } from "../src/content/balance-targets";
import { PASSIVES, LOADOUT_LIMITS } from "../src/content/upgrades";
import { ACCOUNT_UNLOCKS } from "../src/content/unlocks";
import { BASE_WEAPONS, WEAPON_EVOLUTIONS, WEAPONS } from "../src/content/weapons";
import { findEvolutionProblems, weaponPowerIndex } from "../src/game/progression/evolutions";
import { findUnlockProblems, unlocksAt, weaponsOpenAt } from "../src/game/progression/unlocks";
import { findWeaponContentProblems } from "../src/game/weapons";

// Эволюции оружия (docs/39-retention-mechanics.md Б2, tasks/T-0102): запись в
// `WEAPONS` после всех базовых, один уровень, рецепт «оружие на максимуме плюс
// навык». Здесь — контент и его проверки; движок — в evolutions.test.ts.

const PASSIVE_IDS = PASSIVES.map((passive) => passive.id);
const texts = JSON.parse(readFileSync(new URL("../../app-shell/src/i18n/ru.json", import.meta.url), "utf8")) as Record<string, string>;

/** Слабое базовое оружие и годная эволюция к нему: сила 10·1/1 = 10 против 30·1/1 = 30 — втрое. */
function base(id: string, patch: Partial<WeaponDef> = {}): WeaponDef {
  return {
    id,
    behavior: "projectile_nearest",
    nameKey: `weapon.${id}.name`,
    descriptionKey: `weapon.${id}.description`,
    levels: [
      { damage: 5, cooldownSec: 1 },
      { damage: 10, cooldownSec: 1 },
    ],
    ...patch,
  };
}

function evolved(id: string, from: string, passive: string, patch: Partial<WeaponDef> = {}): WeaponDef {
  return {
    id,
    behavior: "projectile_nearest",
    nameKey: `weapon.${id}.name`,
    descriptionKey: `weapon.${id}.description`,
    evolvedFrom: from,
    recipe: { passive },
    levels: [{ damage: 30, cooldownSec: 1 }],
    ...patch,
  };
}

describe("эволюции в контенте", () => {
  it("проходят проверку целиком: и общую проверку оружия, и свою", () => {
    expect(findWeaponContentProblems(WEAPONS)).toEqual([]);
    expect(findEvolutionProblems(WEAPONS, PASSIVE_IDS)).toEqual([]);
  });

  it("шесть эволюций стоят после всех базовых, у каждого базового — ровно одна", () => {
    expect(BASE_WEAPONS).toHaveLength(7);
    expect(WEAPON_EVOLUTIONS).toHaveLength(7);
    const firstEvolution = WEAPONS.findIndex((weapon) => weapon.evolvedFrom !== undefined);
    expect(WEAPONS.slice(firstEvolution).every((weapon) => weapon.evolvedFrom !== undefined)).toBe(true);
    for (const weapon of BASE_WEAPONS) {
      expect(WEAPON_EVOLUTIONS.filter((candidate) => candidate.evolvedFrom === weapon.id), weapon.id).toHaveLength(1);
    }
  });

  it("пары «оружие → навык → эволюция» — как в таблице решения 8", () => {
    const pairs = WEAPON_EVOLUTIONS.map((weapon) => [weapon.evolvedFrom, weapon.recipe?.passive, weapon.id]);
    expect(pairs).toEqual([
      ["spark", "haste", "starfall"],
      ["storm", "volley", "tempest"],
      ["knife", "swiftness", "blade_whirl"],
      ["wardstone", "lodestone", "frost_crown"],
      ["hearth", "mending", "forge"],
      ["sting", "tempering", "viper"],
      ["meteor", "reach", "fire_rain"],
    ]);
  });

  it("у эволюции один уровень, то же поведение и та же стихия, что у базового", () => {
    for (const weapon of WEAPON_EVOLUTIONS) {
      const source = BASE_WEAPONS.find((candidate) => candidate.id === weapon.evolvedFrom);
      expect(source, weapon.id).toBeDefined();
      expect(weapon.levels, weapon.id).toHaveLength(1);
      expect(weapon.behavior, weapon.id).toBe(source?.behavior);
      expect(weapon.element, weapon.id).toBe(source?.element);
    }
  });

  it("сила эволюции — в коридоре относительно последнего уровня базового", () => {
    for (const weapon of WEAPON_EVOLUTIONS) {
      const source = BASE_WEAPONS.find((candidate) => candidate.id === weapon.evolvedFrom);
      const top = source?.levels.at(-1);
      const only = weapon.levels[0];
      if (top === undefined || only === undefined) throw new Error(`нет уровней у ${weapon.id}`);
      const ratio = weaponPowerIndex(only) / weaponPowerIndex(top);
      expect(ratio, weapon.id).toBeGreaterThanOrEqual(EVOLUTION_POWER_RATIO.min);
      expect(ratio, weapon.id).toBeLessThanOrEqual(EVOLUTION_POWER_RATIO.max);
    }
    expect(EVOLUTION_POWER_RATIO).toEqual({ min: 1.8, max: 3.5 });
  });

  it("сила — урон на число снарядов в секунду: цифры решения 8", () => {
    expect(weaponPowerIndex({ damage: 16, cooldownSec: 0.15, projectiles: 3 })).toBeCloseTo(320, 5);
    expect(weaponPowerIndex({ damage: 13, cooldownSec: 0.28 })).toBeCloseTo(46.4286, 3);
  });

  it("тексты есть: имя и описание по ключам, названия — как в решении 9", () => {
    for (const weapon of WEAPON_EVOLUTIONS) {
      expect(weapon.nameKey, weapon.id).toBe(`weapon.${weapon.id}.name`);
      expect(weapon.descriptionKey, weapon.id).toBe(`weapon.${weapon.id}.description`);
      expect(texts[weapon.nameKey] ?? "", weapon.nameKey).not.toBe("");
      expect(texts[weapon.descriptionKey] ?? "", weapon.descriptionKey).not.toBe("");
    }
    expect(WEAPON_EVOLUTIONS.map((weapon) => texts[weapon.nameKey])).toEqual(["Звездопад", "Буря", "Вихрь клинков", "Ледяной венец", "Горн", "Гадюка"]);
  });

  it("навыки рецептов не повторяются и пары разведены по категориям: слотов хватает на каждую", () => {
    const passives = WEAPON_EVOLUTIONS.map((weapon) => weapon.recipe?.passive ?? "");
    expect(new Set(passives).size).toBe(passives.length);
    const byCategory = new Map<string, number>();
    for (const id of passives) {
      const category = PASSIVES.find((passive) => passive.id === id)?.category ?? "";
      byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
    }
    expect(byCategory.get("attack")).toBe(2);
    expect(byCategory.get("mobility")).toBe(2);
    expect(byCategory.get("defense")).toBe(2);
    // слотов защиты и мобильности меньше, чем пар: игрок выбирает, какую эволюцию строить
    expect(LOADOUT_LIMITS.passives.defense).toBeLessThan(2);
    expect(LOADOUT_LIMITS.passives.mobility).toBeLessThan(2);
  });
});

describe("проверка эволюций на неверном контенте", () => {
  const problems = (defs: WeaponDef[], passives: readonly string[] = ["p", "q"]) => findEvolutionProblems(defs, passives);

  it("годная пара — без замечаний", () => {
    expect(problems([base("b"), evolved("e", "b", "p")])).toEqual([]);
  });

  it("evolvedFrom без recipe и recipe без evolvedFrom ловит общая проверка оружия, сообщение называет оружие", () => {
    const onlyFrom = findWeaponContentProblems([base("b"), { ...evolved("e", "b", "p"), recipe: undefined }]);
    const onlyRecipe = findWeaponContentProblems([base("b"), { ...evolved("e", "b", "p"), evolvedFrom: undefined }]);
    expect(onlyFrom.join("\n")).toMatch(/оружие e:.*evolvedFrom.*recipe/);
    expect(onlyRecipe.join("\n")).toMatch(/оружие e:.*evolvedFrom.*recipe/);
  });

  it("базовое не найдено", () => {
    expect(problems([base("b"), evolved("e", "ghost", "p")])).toContainEqual(expect.stringContaining("оружие e: evolvedFrom ghost"));
  });

  it("цепочка: эволюция эволюции", () => {
    const list = [base("b"), evolved("e", "b", "p"), evolved("e2", "e", "q")];
    expect(problems(list)).toContainEqual(expect.stringContaining("оружие e2: evolvedFrom e"));
  });

  it("две эволюции одного базового", () => {
    const list = [base("b"), evolved("e", "b", "p"), evolved("e2", "b", "q")];
    expect(problems(list)).toContainEqual(expect.stringMatching(/оружие b: .*e.*e2/));
  });

  it("один навык в двух рецептах", () => {
    const list = [base("b"), base("c"), evolved("e", "b", "p"), evolved("e2", "c", "p")];
    expect(problems(list)).toContainEqual(expect.stringContaining("оружие e2: recipe.passive p"));
  });

  it("навыка рецепта нет в контенте", () => {
    expect(problems([base("b"), evolved("e", "b", "zzz")])).toContainEqual(expect.stringContaining("оружие e: recipe.passive zzz"));
  });

  it("поведение или стихия не как у базового", () => {
    const otherBehavior = problems([base("b"), evolved("e", "b", "p", { behavior: "aura" })]);
    const otherElement = problems([base("b"), evolved("e", "b", "p", { element: "fire" })]);
    expect(otherBehavior).toContainEqual(expect.stringContaining("оружие e: behavior и element"));
    expect(otherElement).toContainEqual(expect.stringContaining("оружие e: behavior и element"));
  });

  it("сила вне коридора: слабее и сильнее", () => {
    const weak = problems([base("b"), evolved("e", "b", "p", { levels: [{ damage: 11, cooldownSec: 1 }] })]);
    const strong = problems([base("b"), evolved("e", "b", "p", { levels: [{ damage: 60, cooldownSec: 1 }] })]);
    expect(weak).toContainEqual(expect.stringContaining("оружие e: сила"));
    expect(strong).toContainEqual(expect.stringContaining("оружие e: сила"));
  });

  it("у эволюции больше одного уровня", () => {
    const list = [base("b"), evolved("e", "b", "p", { levels: [{ damage: 30, cooldownSec: 1 }, { damage: 31, cooldownSec: 1 }] })];
    expect(problems(list)).toContainEqual(expect.stringContaining("оружие e: один уровень"));
  });

  it("эволюция раньше базовых и базовое без эволюции", () => {
    const early = problems([evolved("e", "b", "p"), base("b")]);
    const lonely = problems([base("b"), base("c"), evolved("e", "b", "p")]);
    expect(early).toContainEqual(expect.stringContaining("оружие e: после всех базовых"));
    expect(lonely).toContainEqual(expect.stringContaining("оружие c: нет эволюции"));
  });
});

describe("эволюции и таблица открытий", () => {
  const baseContent = { weapons: BASE_WEAPONS.map((weapon) => weapon.id), passives: new Map(PASSIVES.map((passive) => [passive.id, passive.category])) };

  it("таблица не называет эволюций; правило «ровно один уровень» — для базовых", () => {
    const named = new Set(ACCOUNT_UNLOCKS.flatMap((row) => row.weapons ?? []));
    for (const weapon of WEAPON_EVOLUTIONS) expect(named.has(weapon.id), weapon.id).toBe(false);
    expect(findUnlockProblems(ACCOUNT_UNLOCKS, baseContent, LOADOUT_LIMITS)).toEqual([]);
  });

  it("на первом уровне три базовых, а открыты вместе с ними их эволюции", () => {
    const first = unlocksAt(ACCOUNT_UNLOCKS, 1);
    expect(first.weapons.size).toBe(3);
    const open = weaponsOpenAt(WEAPONS, first).map((weapon) => weapon.id);
    expect(open).toHaveLength(6);
    expect(open.filter((id) => first.weapons.has(id))).toHaveLength(3);
    for (const id of first.weapons) {
      expect(WEAPONS.some((weapon) => weapon.evolvedFrom === id && open.includes(weapon.id)), id).toBe(true);
    }
  });

  it("на последнем уровне открыто всё: четырнадцать видов в порядке контента", () => {
    const last = unlocksAt(ACCOUNT_UNLOCKS, Math.max(...ACCOUNT_UNLOCKS.map((row) => row.level)));
    expect(weaponsOpenAt(WEAPONS, last).map((weapon) => weapon.id)).toEqual(WEAPONS.map((weapon) => weapon.id));
  });
});
