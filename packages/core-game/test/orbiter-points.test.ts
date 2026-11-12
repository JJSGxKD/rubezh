import type { EnemyDef, PassiveDef, WeaponDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { addPassive, addWeapon } from "../src/game/progression/loadout";
import { refreshPlayerStats } from "../src/game/progression/levels";
import { orbiterRenderPoints } from "../src/game/render/orbiter-points";
import { orbiterLook } from "../src/game/render/looks";
import { createWorld, DEFAULT_SIM_CONFIG, type World } from "../src/game/sim/world";
import { effectiveWeaponLevel, orbiterCount, type OrbiterPoint } from "../src/game/weapons";
import type { ResolvedWeaponLevel } from "../src/game/weapons/weapon-types";

// Обереги на экране — те, что бьют: рендер берёт усиленные числа оружия и
// сглаженный центр персонажа (tasks/T-0005).

const text = { nameKey: "n", descriptionKey: "d" };
const DUMMY: EnemyDef = { id: "dummy", hp: 400, speed: 0.001, damage: 0, xp: 3, pattern: "swarm" };
const WARD: WeaponDef = {
  id: "ward",
  behavior: "orbit",
  ...text,
  levels: [{ damage: 10, cooldownSec: 0.4, projectiles: 2, areaRadius: 100, projectileSpeed: 200 }],
};
const REACH: PassiveDef = { id: "reach", ...text, category: "attack", stat: "area", op: "mul", levels: [1.6] };
const VOLLEY: PassiveDef = { id: "volley", ...text, category: "attack", stat: "projectiles", op: "add", levels: [2] };

function boostedWorld(): World {
  const world = createWorld({
    seed: 1,
    enemies: [DUMMY],
    weapons: [WARD],
    passives: [REACH, VOLLEY],
    loadoutLimits: { weapons: 1, passives: { attack: 2, defense: 0, mobility: 0 } },
    config: { player: { ...DEFAULT_SIM_CONFIG.player } },
  });
  for (const id of ["reach", "volley"]) addPassive(world.loadout, world.passiveTypes.findIndex((type) => type.id === id));
  refreshPlayerStats(world);
  return world;
}

function effective(world: World): ResolvedWeaponLevel {
  return effectiveWeaponLevel(world, 0, {
    damage: 0,
    cooldownSec: 0,
    projectiles: 0,
    pierce: 0,
    areaRadius: 0,
    projectileSpeed: 0,
    ttlSec: 0,
    element: 0,
    statusChance: 0,
  });
}

describe("положения оберегов для рендера", () => {
  it("точек столько, сколько оберегов у усиленного уровня, а не у базового", () => {
    const world = boostedWorld();
    const out: OrbiterPoint[] = [];
    const count = orbiterRenderPoints(world, 1, out);

    expect(count).toBe(orbiterCount(effective(world)));
    expect(count).toBeGreaterThan(world.weaponTypes[0].levels[0].projectiles);
  });

  it("каждая точка — на усиленном радиусе от центра", () => {
    const world = boostedWorld();
    const out: OrbiterPoint[] = [];
    const count = orbiterRenderPoints(world, 1, out);
    const radius = effective(world).areaRadius;

    expect(radius).toBeGreaterThan(world.weaponTypes[0].levels[0].areaRadius);
    for (let k = 0; k < count; k++) {
      expect(Math.hypot(out[k].x - world.player.x, out[k].y - world.player.y)).toBeCloseTo(radius, 9);
    }
  });

  it("центр при t = 0.5 — середина между прошлым и нынешним положением героя", () => {
    const world = boostedWorld();
    world.player.prevX = 100;
    world.player.prevY = -40;
    world.player.x = 120;
    world.player.y = -20;
    const out: OrbiterPoint[] = [];
    const count = orbiterRenderPoints(world, 0.5, out);
    const radius = effective(world).areaRadius;

    for (let k = 0; k < count; k++) {
      expect(Math.hypot(out[k].x - 110, out[k].y + 30)).toBeCloseTo(radius, 9);
    }
  });

  it("второй вызов с тем же out не создаёт объектов: ссылки те же", () => {
    const world = boostedWorld();
    const out: OrbiterPoint[] = [];
    const count = orbiterRenderPoints(world, 0.3, out);
    const first = out.slice(0, count);

    expect(orbiterRenderPoints(world, 0.7, out)).toBe(count);
    for (let k = 0; k < count; k++) expect(out[k]).toBe(first[k]);
  });

  it("без оберегов — ноль точек", () => {
    const world = createWorld({ seed: 1, enemies: [DUMMY], weapons: [] });
    expect(orbiterRenderPoints(world, 0, [])).toBe(0);
  });
});

describe("облик оберегов по оружию слота", () => {
  const FLAIL: WeaponDef = { ...WARD, id: "flail" };

  it("вместе с точками пишет id оружия, чьё это обереги, в порядке слотов", () => {
    const world = createWorld({
      seed: 1,
      enemies: [DUMMY],
      weapons: [WARD, FLAIL],
      loadoutLimits: { weapons: 2, passives: { attack: 0, defense: 0, mobility: 0 } },
    });
    addWeapon(world.loadout, 1);
    const out: OrbiterPoint[] = [];
    const ids: string[] = [];
    const count = orbiterRenderPoints(world, 1, out, ids);

    expect(world.loadout.weapons.length).toBe(2);
    expect(ids.slice(0, count)).toEqual(["ward", "ward", "flail", "flail"]);
  });

  it("кистень и круговерть рисуются своими кадрами, а не кадром оберега", () => {
    expect(orbiterLook("ward").frame).toBe("fx/orbiter_ward0");
    expect(orbiterLook("flail").frame).toBe("fx/orbiter_flail0");
    expect(orbiterLook("whirl").frame).toBe("fx/orbiter_whirl0");
  });

  it("груз кистеня крупнее оберега, круговерти — не мельче кистеня", () => {
    expect(orbiterLook("flail").radius).toBeGreaterThan(orbiterLook("ward").radius);
    expect(orbiterLook("whirl").radius).toBeGreaterThanOrEqual(orbiterLook("flail").radius);
    expect(orbiterLook("flail").color).not.toBe(orbiterLook("ward").color);
  });

  it("оружие без своего облика рисуется как оберег", () => {
    expect(orbiterLook("blade_whirl")).toBe(orbiterLook("ward"));
  });
});
