import { ENEMIES, WEAPONS } from "@bh/core-game";
import { describe, expect, it } from "vitest";
import { FX_SCENES, fxScene } from "../src/dev/fx-scenes";

// Каталог сцен собирается из контента: новое оружие получает сцену без правки
// каталога (docs/17-testing-strategy.md, «Стенд эффектов»).

const COMMAND_KINDS = [
  "levelUp",
  "giveWeapon",
  "givePassive",
  "spawnEnemy",
  "spawnPickup",
  "spawnGems",
  "killAll",
  "heal",
  "jumpToMinute",
  "stepTicks",
];

describe("каталог сцен эффектов", () => {
  it("у каждого оружия есть сцена с тем же id", () => {
    for (const weapon of WEAPONS) {
      const scene = fxScene(weapon.id);
      expect(scene, `нет сцены для оружия ${weapon.id}`).not.toBeNull();
      expect(scene?.commands.some((c) => c.kind === "giveWeapon" && c.id === weapon.id)).toBe(true);
    }
  });

  it("id сцен уникальны", () => {
    const ids = FX_SCENES.map((scene) => scene.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("тиков кратно трём и не больше 180", () => {
    for (const scene of FX_SCENES) {
      expect(scene.ticks % 3, scene.id).toBe(0);
      expect(scene.ticks, scene.id).toBeGreaterThan(0);
      expect(scene.ticks, scene.id).toBeLessThanOrEqual(180);
    }
  });

  it("сцены событий на месте", () => {
    for (const id of ["dynamite", "magnet", "elite_death"]) expect(fxScene(id), id).not.toBeNull();
  });

  it("команды известны, враги — из контента, оружие стартовое есть", () => {
    const enemies = new Set(ENEMIES.map((enemy) => enemy.id));
    const weapons = new Set(WEAPONS.map((weapon) => weapon.id));
    for (const scene of FX_SCENES) {
      expect(weapons.has(scene.startingWeaponId), scene.id).toBe(true);
      expect(scene.note, scene.id).not.toBe("");
      for (const command of scene.commands) {
        expect(COMMAND_KINDS, scene.id).toContain(command.kind);
        if (command.kind === "spawnEnemy") expect(enemies.has(command.id), `${scene.id}: ${command.id}`).toBe(true);
      }
    }
  });

  it("неизвестная сцена — null", () => {
    expect(fxScene("nope")).toBeNull();
  });
});
