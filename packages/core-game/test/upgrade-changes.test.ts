import { describe, expect, it } from "vitest";
import { PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
import { resolvePassiveTypes } from "../src/game/progression/passives";
import { evolutionChanges, healChanges, passiveChanges, weaponChanges } from "../src/game/progression/upgrade-changes";
import { resolveWeaponTypes } from "../src/game/weapons/weapon-types";

// Что даёт вариант выбора: строки «урон 6 → 7» для карточки улучшения.

const weapon = (id: string, unitScale = 1) => {
  const type = resolveWeaponTypes(WEAPONS, unitScale).find((candidate) => candidate.id === id);
  if (type === undefined) throw new Error(`нет оружия ${id} в контенте`);
  return type;
};

const passive = (id: string) => {
  const type = resolvePassiveTypes(PASSIVES).find((candidate) => candidate.id === id);
  if (type === undefined) throw new Error(`нет пассивки ${id} в контенте`);
  return type;
};

const labels = (changes: { labelKey: string }[]) => changes.map((change) => change.labelKey);

describe("что даёт улучшение", () => {
  it("у уровня оружия — только то, что меняется", () => {
    const changes = weaponChanges(weapon("spark"), 2, 3, 1);

    expect(changes).toEqual([
      { labelKey: "upgrade.stat.damage", from: 7, to: 8, format: "value", lowerIsBetter: false },
      { labelKey: "upgrade.stat.cooldownSec", from: 0.26, to: 0.24, format: "value", lowerIsBetter: true },
      { labelKey: "upgrade.stat.projectiles", from: 1, to: 2, format: "value", lowerIsBetter: false },
    ]);
  });

  it("показывает числа в единицах контента, а не в пикселях устройства", () => {
    // На телефоне с плотностью 3 радиус в мире втрое больше, а в контенте — 60.
    const changes = weaponChanges(weapon("wardstone", 3), 1, 2, 3);
    const radius = changes.find((change) => change.labelKey === "upgrade.stat.areaRadius");

    expect(radius).toMatchObject({ from: 60, to: 64 });
  });

  it("у нового оружия — главные числа без скорости и времени полёта", () => {
    const changes = weaponChanges(weapon("knife"), null, 1, 1);

    expect(labels(changes)).toEqual([
      "upgrade.stat.damage",
      "upgrade.stat.cooldownSec",
      "upgrade.stat.projectiles",
      "upgrade.stat.pierce",
    ]);
    expect(changes.every((change) => change.from === null)).toBe(true);
  });

  it("не показывает полей, которые поведение не использует, и подписывает поле по поведению", () => {
    const aura = weaponChanges(weapon("hearth"), null, 1, 1);
    expect(labels(aura)).toEqual([
      "upgrade.stat.damage",
      "upgrade.stat.aura.cooldownSec",
      "upgrade.stat.aura.areaRadius",
      "upgrade.stat.statusChance.fire",
    ]);

    // Второй уровень добавляет камень: у орбиты поле снарядов подписано как
    // обереги, а не как снаряды.
    const orbit = weaponChanges(weapon("wardstone"), 1, 2, 1);
    expect(labels(orbit)).toContain("upgrade.stat.orbit.projectiles");
  });

  it("у стихийного оружия — шанс состояния в процентах, подписанный глаголом стихии", () => {
    expect(weaponChanges(weapon("hearth"), 1, 2, 1)).toContainEqual({
      labelKey: "upgrade.stat.statusChance.fire",
      from: 15,
      to: 17,
      format: "value",
      lowerIsBetter: false,
    });
    expect(weaponChanges(weapon("storm"), null, 1, 1)).toContainEqual(
      expect.objectContaining({ labelKey: "upgrade.stat.statusChance.lightning", from: null, to: 35 }),
    );
  });

  it("у пассивки-множителя — процентом, у перезарядки меньше — лучше", () => {
    expect(passiveChanges(passive("might"), 1, 2)).toEqual([
      { labelKey: "upgrade.stat.passive.damage", from: 1.1, to: 1.2, format: "percent", lowerIsBetter: false },
    ]);
    expect(passiveChanges(passive("haste"), null, 1)[0]).toMatchObject({
      from: null,
      format: "percent",
      lowerIsBetter: true,
    });
    expect(passiveChanges(passive("vitality"), 1, 2)[0]).toMatchObject({ from: 20, to: 45, format: "plus" });
    // Сопротивление — доля в контенте, а на карточке — проценты.
    expect(passiveChanges(passive("tempering"), 1, 2)[0]).toMatchObject({
      labelKey: "upgrade.stat.passive.resist",
      from: 15,
      to: 30,
      format: "plus",
    });
  });

  it("лечение — в процентах здоровья", () => {
    expect(healChanges(0.3)).toEqual([
      { labelKey: "upgrade.stat.heal", from: null, to: 30, format: "value", lowerIsBetter: false },
    ]);
  });

  it("за пределами уровней оружия не выдумывает чисел", () => {
    expect(weaponChanges(weapon("spark"), 8, 9, 1)).toEqual([]);
  });
});

describe("что даёт эволюция", () => {
  it("«Очаг» → «Горн»: радиус 140 → 175, шанс 30 → 50, пауза 0,28 → 0,22, урон 13 → 28", () => {
    const changes = evolutionChanges(weapon("hearth"), weapon("forge"), 1);

    expect(changes).toEqual([
      { labelKey: "upgrade.stat.damage", from: 13, to: 28, format: "value", lowerIsBetter: false },
      { labelKey: "upgrade.stat.aura.cooldownSec", from: 0.28, to: 0.22, format: "value", lowerIsBetter: true },
      { labelKey: "upgrade.stat.aura.areaRadius", from: 140, to: 175, format: "value", lowerIsBetter: false },
      { labelKey: "upgrade.stat.statusChance.fire", from: 30, to: 50, format: "value", lowerIsBetter: false },
    ]);
  });

  it("«Искра» → «Звездопад»: снаряды 3 → 4, пробив 2 → 3, урон 16 → 26; пауза 0,15 → 0,13", () => {
    const changes = evolutionChanges(weapon("spark"), weapon("starfall"), 1);
    const byLabel = new Map(changes.map((change) => [change.labelKey, change]));

    expect(byLabel.get("upgrade.stat.damage")).toMatchObject({ from: 16, to: 26 });
    expect(byLabel.get("upgrade.stat.projectiles")).toMatchObject({ from: 3, to: 4 });
    expect(byLabel.get("upgrade.stat.pierce")).toMatchObject({ from: 2, to: 3 });
    expect(byLabel.get("upgrade.stat.cooldownSec")).toMatchObject({ from: 0.15, to: 0.13 });
  });

  it("числа в единицах контента, а не в пикселях устройства", () => {
    const changes = evolutionChanges(weapon("hearth", 3), weapon("forge", 3), 3);

    expect(changes.find((change) => change.labelKey === "upgrade.stat.aura.areaRadius")).toMatchObject({ from: 140, to: 175 });
  });
});

