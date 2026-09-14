import { describe, expect, it } from "vitest";
import { DROPS } from "../src/content/drops";
import { ENEMIES } from "../src/content/enemies";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
import { CueTracker } from "../src/game/run/cues";
import { killEnemy } from "../src/game/sim/combat";
import { pushSimEvent, SIM_EVENT } from "../src/game/sim/events";
import { IDLE_INPUT, stepWorld } from "../src/game/sim/step";
import { createWorld, damagePlayer, spawnEnemy, type World } from "../src/game/sim/world";

// Сигналы забега для вибрации и звука: из буфера событий и счётчиков мира.

function world(): World {
  return createWorld({
    seed: 5,
    enemies: ENEMIES,
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    drops: DROPS,
    startingWeaponId: "spark",
  });
}

function typeIndex(target: World, id: string): number {
  return target.enemyTypes.findIndex((type) => type.id === id);
}

describe("сигналы забега", () => {
  it("молчат, пока ничего не случилось, и не повторяют уже отданное", () => {
    const target = world();
    const tracker = new CueTracker(target);
    expect(tracker.collect()).toBeNull();

    damagePlayer(target, 5, 0);
    damagePlayer(target, 5, 0);
    expect(tracker.collect()).toMatchObject({ playerHit: 2 });
    expect(tracker.collect()).toBeNull();
  });

  it("не отдаёт залпом то, что было до создания: продолженный забег молчит", () => {
    const target = world();
    damagePlayer(target, 5, 0);
    killEnemy(target, spawnEnemy(target, typeIndex(target, "swarm_rat"), 500, 0));
    expect(new CueTracker(target).collect()).toBeNull();
  });

  it("считает убийства, элиту и взрыв рядом с игроком отдельно от дальнего", () => {
    const target = world();
    const tracker = new CueTracker(target);

    const elite = spawnEnemy(target, typeIndex(target, "elite_ghoul"), 600, 0);
    expect(tracker.collect()).toMatchObject({ eliteSpawns: 1 });

    killEnemy(target, elite);
    killEnemy(target, spawnEnemy(target, typeIndex(target, "swarm_rat"), 500, 0));
    pushSimEvent(target.events, { kind: SIM_EVENT.explosion, x: 30, y: 0, radius: 60, tick: 1 });
    pushSimEvent(target.events, { kind: SIM_EVENT.explosion, x: 3000, y: 0, radius: 60, tick: 1 });
    const cues = tracker.collect();
    expect(cues).toMatchObject({ kills: 2, eliteKills: 1, eliteSpawns: 0, explosions: 2, explosionsNear: 1 });
  });

  it("отмечает начало угрозы, а не каждый тик её отсчёта", () => {
    const target = world();
    target.loadout.weapons.length = 0;
    const tracker = new CueTracker(target);
    // Появляются в стороне и подходят сами: угроза начинается на глазах у трекера.
    spawnEnemy(target, typeIndex(target, "bomber_imp"), 400, 0);
    spawnEnemy(target, typeIndex(target, "dasher_wolf"), 0, 500);
    const totals = { fuses: 0, dashWarns: 0, dashes: 0 };
    for (let tick = 0; tick < 600; tick++) {
      stepWorld(target, IDLE_INPUT);
      const cues = tracker.collect();
      totals.fuses += cues?.fuses ?? 0;
      totals.dashWarns += cues?.dashWarns ?? 0;
      totals.dashes += cues?.dashes ?? 0;
    }
    expect(totals.fuses).toBe(1);
    expect(totals.dashWarns).toBeGreaterThan(0);
    expect(totals.dashWarns - totals.dashes).toBeGreaterThanOrEqual(0);
    expect(totals.dashWarns - totals.dashes).toBeLessThanOrEqual(1);
  });

  it("замечает срабатывание оружия по взведённой перезарядке", () => {
    const target = world();
    const tracker = new CueTracker(target);
    spawnEnemy(target, typeIndex(target, "tank_ghoul"), 120, 0);
    let fired = 0;
    for (let tick = 0; tick < 120; tick++) {
      stepWorld(target, IDLE_INPUT);
      fired += tracker.collect()?.weapons.spark ?? 0;
    }
    expect(fired).toBeGreaterThan(3);
  });
});
