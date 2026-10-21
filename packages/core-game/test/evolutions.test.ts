import { describe, expect, it } from "vitest";
import { CHESTS } from "../src/content/chests";
import { DROPS } from "../src/content/drops";
import { ENEMIES } from "../src/content/enemies";
import { MAPS } from "../src/content/maps";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { ENDLESS_CURVE, TIMELINE } from "../src/content/waves";
import { BASE_WEAPONS, WEAPONS } from "../src/content/weapons";
import { applyEvolution, describeEvolution, evolutionProgress, isWeaponOfferable, readyEvolutionOption } from "../src/game/progression/evolutions";
import { addPassive, addWeapon, passiveSlotOf, weaponSlotOf } from "../src/game/progression/loadout";
import { chooseUpgrade, collectCandidates, isAwaitingChoice, prepareOffers } from "../src/game/progression/levels";
import { captureWorld, restoreWorld } from "../src/game/run/snapshot";
import { checksumWorld } from "../src/game/sim/checksum";
import { openChest } from "../src/game/sim/chests";
import { createTimelineDirector } from "../src/game/sim/director";
import { createConstantPopulationSpawner } from "../src/game/sim/spawner";
import { stepWorld } from "../src/game/sim/step";
import { createWorld, TICK_SEC, type CreateWorldOptions, type World } from "../src/game/sim/world";
import { benchInput } from "../src/game/bench/autopilot";

// Движок эволюций (tasks/T-0102): готовность по набору, превращение слота,
// выдача сундуком. Эволюции нет в карточках уровня, и генератор мира они не
// трогают — забег без эволюции остаётся тем же числом в контрольной сумме.

function newWorld(patch: Partial<CreateWorldOptions> = {}): World {
  return createWorld({
    seed: 11,
    enemies: ENEMIES,
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    drops: DROPS,
    chests: CHESTS,
    map: MAPS[0],
    startingWeaponId: "spark",
    ...patch,
  });
}

/** Оружие в наборе на заданном уровне: берётся уже стоящий слот или добавляется новый. */
function setWeapon(world: World, id: string, level: number): void {
  const typeIndex = world.weaponTypes.findIndex((type) => type.id === id);
  if (typeIndex < 0) throw new Error(`нет оружия ${id}`);
  const slot = weaponSlotOf(world.loadout, typeIndex);
  (slot >= 0 ? world.loadout.weapons[slot] : addWeapon(world.loadout, typeIndex)).level = level;
}

function setPassive(world: World, id: string, level: number): void {
  const typeIndex = world.passiveTypes.findIndex((type) => type.id === id);
  if (typeIndex < 0) throw new Error(`нет навыка ${id}`);
  const slot = passiveSlotOf(world.loadout, typeIndex);
  (slot >= 0 ? world.loadout.passives[slot] : addPassive(world.loadout, typeIndex)).level = level;
}

/** Набор, который движок отдаёт расчёту готовности: id оружия и навыков с уровнями. */
function loadoutIds(world: World): { weapons: string[]; passives: { id: string; level: number }[] } {
  return {
    weapons: world.loadout.weapons.map((slot) => world.weaponTypes[slot.typeIndex]?.id ?? ""),
    passives: world.loadout.passives.map((slot) => ({ id: world.passiveTypes[slot.typeIndex]?.id ?? "", level: slot.level })),
  };
}

/** Мир, в котором «Искра» на максимуме и «Спешка» взята: эволюция готова. */
function readyWorld(patch: Partial<CreateWorldOptions> = {}): World {
  const world = newWorld(patch);
  setWeapon(world, "spark", 8);
  setPassive(world, "haste", 1);
  return world;
}

describe("готовность эволюции по набору", () => {
  const stateOf = (world: World, evolution: string) => evolutionProgress(WEAPONS, loadoutIds(world)).find((entry) => entry.evolutionId === evolution);

  it("по записи на эволюцию в порядке контента", () => {
    const progress = evolutionProgress(WEAPONS, loadoutIds(newWorld()));
    expect(progress.map((entry) => entry.evolutionId)).toEqual(["starfall", "tempest", "blade_whirl", "frost_crown", "forge", "viper"]);
    expect(progress[0]).toMatchObject({ weaponId: "spark", passiveId: "haste", weaponMaxLevel: 8 });
  });

  it("7-й уровень и навык — ждёт; 8-й без навыка — ждёт; 8-й и навык 1-го уровня — готова", () => {
    const world = newWorld();
    setWeapon(world, "spark", 7);
    setPassive(world, "haste", 1);
    expect(stateOf(world, "starfall")).toMatchObject({ state: "waiting", weaponLevel: 7, hasPassive: true });

    const noPassive = newWorld();
    setWeapon(noPassive, "spark", 8);
    expect(stateOf(noPassive, "starfall")).toMatchObject({ state: "waiting", weaponLevel: 8, hasPassive: false });

    expect(stateOf(readyWorld(), "starfall")).toMatchObject({ state: "ready", weaponLevel: 8, hasPassive: true });
  });

  it("оружия нет в наборе — absent; эволюция в наборе — done", () => {
    const world = readyWorld();
    expect(stateOf(world, "tempest")).toMatchObject({ state: "absent", weaponLevel: null });
    expect(applyEvolution(world, "starfall")).toBe(true);
    expect(stateOf(world, "starfall")?.state).toBe("done");
  });

  it("описание эволюции: оружие и навык рецепта; неизвестная — null", () => {
    expect(describeEvolution(WEAPONS, "forge")).toEqual({ weaponId: "hearth", passiveId: "mending" });
    expect(describeEvolution(WEAPONS, "spark")).toBeNull();
    expect(describeEvolution(WEAPONS, "ghost")).toBeNull();
  });
});

describe("готовая эволюция как вариант награды", () => {
  it("ничего не готово — null", () => {
    expect(readyEvolutionOption(newWorld())).toBeNull();
  });

  it("готова «Искра» — вариант weapon_evolve:starfall:1 со строкой «урон 16 → 26»", () => {
    const option = readyEvolutionOption(readyWorld());
    expect(option).toMatchObject({ id: "weapon_evolve:starfall:1", kind: "weapon_evolve", refId: "starfall", level: 1, nameKey: "weapon.starfall.name", descriptionKey: "weapon.starfall.description" });
    expect(option?.changes.find((change) => change.labelKey === "upgrade.stat.damage")).toMatchObject({ from: 16, to: 26 });
  });

  it("готовы две — первая по порядку в WEAPONS", () => {
    const world = readyWorld();
    setWeapon(world, "storm", 8);
    setPassive(world, "volley", 2);
    expect(readyEvolutionOption(world)?.refId).toBe("starfall");
    const swapped = newWorld({ startingWeaponId: "storm" });
    setWeapon(swapped, "storm", 8);
    setPassive(swapped, "volley", 2);
    setWeapon(swapped, "spark", 8);
    setPassive(swapped, "haste", 1);
    // порядок задаёт контент, а не порядок слотов в наборе
    expect(readyEvolutionOption(swapped)?.refId).toBe("starfall");
  });
});

describe("превращение слота", () => {
  it("номер слота тот же, тип — эволюции, уровень 1; перезарядка и направление остались, набор не вырос", () => {
    const world = readyWorld();
    const slotIndex = weaponSlotOf(world.loadout, world.weaponTypes.findIndex((type) => type.id === "spark"));
    const slot = world.loadout.weapons[slotIndex];
    slot.cooldown = 0.07;
    slot.dirX = 0;
    slot.dirY = 1;
    const weapons = world.loadout.weapons.length;
    const passives = world.loadout.passives.length;

    expect(applyEvolution(world, "starfall")).toBe(true);

    const after = world.loadout.weapons[slotIndex];
    expect(world.weaponTypes[after.typeIndex].id).toBe("starfall");
    expect(after).toMatchObject({ level: 1, cooldown: 0.07, dirX: 0, dirY: 1 });
    expect(world.loadout.weapons).toHaveLength(weapons);
    expect(world.loadout.passives).toHaveLength(passives);
  });

  it("рецепт уже не выполнен или повтор — false, набор не меняется", () => {
    const world = newWorld();
    setWeapon(world, "spark", 8);
    expect(applyEvolution(world, "starfall")).toBe(false);
    expect(world.weaponTypes[world.loadout.weapons[0].typeIndex].id).toBe("spark");

    const ready = readyWorld();
    expect(applyEvolution(ready, "starfall")).toBe(true);
    expect(applyEvolution(ready, "starfall")).toBe(false);
    expect(applyEvolution(ready, "ghost")).toBe(false);
  });
});

describe("эволюция и карточки уровня", () => {
  it("за 50 seed ни карточки, ни кандидаты не содержат эволюцию и базовое после её получения", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const world = readyWorld({ seed });
      world.progression.pendingLevelUps = 1;
      const before = prepareOffers(world);
      for (const offer of before) expect(offer.kind, `seed ${seed}`).not.toBe("weapon_evolve");
      for (const { option } of collectCandidates(world)) {
        expect(option.refId, `seed ${seed}`).not.toBe("starfall");
        expect(option.kind, `seed ${seed}`).not.toBe("weapon_evolve");
      }

      expect(applyEvolution(world, "starfall")).toBe(true);
      for (const { option } of collectCandidates(world)) expect(["spark", "starfall"], `seed ${seed}`).not.toContain(option.refId);
    }
  });

  it("isWeaponOfferable: эволюция — нет, базовое с готовой эволюцией в наборе — нет, остальное — да", () => {
    const world = readyWorld();
    const index = (id: string) => world.weaponTypes.findIndex((type) => type.id === id);
    expect(isWeaponOfferable(world, index("starfall"))).toBe(false);
    expect(isWeaponOfferable(world, index("spark"))).toBe(true);
    expect(isWeaponOfferable(world, index("storm"))).toBe(true);
    applyEvolution(world, "starfall");
    expect(isWeaponOfferable(world, index("spark"))).toBe(false);
  });

  it("стартовым оружием эволюция стать не может: берётся первое базовое", () => {
    const world = newWorld({ startingWeaponId: "starfall" });
    expect(world.weaponTypes[world.loadout.weapons[0].typeIndex].id).toBe(BASE_WEAPONS[0]?.id);
  });
});

describe("выдача сундуком", () => {
  it("сундук из трёх наград: эволюция первой, всего три", () => {
    const world = readyWorld();
    openChest(world, 3);
    const opening = world.chests.openings[0];
    expect(opening.rewards).toHaveLength(3);
    expect(opening.rewards[0]).toMatchObject({ kind: "weapon_evolve", refId: "starfall" });
    expect(world.weaponTypes.some((type, index) => type.id === "starfall" && weaponSlotOf(world.loadout, index) >= 0)).toBe(true);
    expect(world.loadout.weapons.some((slot) => world.weaponTypes[slot.typeIndex].id === "spark")).toBe(false);
  });

  it("сундук из одной награды отдаёт только эволюцию и не тратит генератор сундука", () => {
    const world = readyWorld();
    const fresh = readyWorld();
    openChest(world, 1);
    expect(world.chests.openings[0].rewards.map((reward) => reward.kind)).toEqual(["weapon_evolve"]);
    expect(world.chests.rng.getState()).toBe(fresh.chests.rng.getState());
  });

  it("эволюция не готова — сундук работает как прежде: столько наград, сколько размер, без эволюций", () => {
    const world = newWorld();
    openChest(world, 3);
    const rewards = world.chests.openings[0].rewards;
    expect(rewards).toHaveLength(3);
    expect(rewards.some((reward) => reward.kind === "weapon_evolve")).toBe(false);
  });

  it("готовность проверяется один раз в начале: награды того же сундука её не создают", () => {
    const world = newWorld();
    setWeapon(world, "spark", 7);
    setPassive(world, "haste", 1);
    openChest(world, 5);
    expect(world.chests.openings[0].rewards.some((reward) => reward.kind === "weapon_evolve")).toBe(false);
  });
});

describe("генератор мира", () => {
  it("readyEvolutionOption и applyEvolution не берут чисел из world.rng", () => {
    const touched = readyWorld({ seed: 77 });
    const untouched = readyWorld({ seed: 77 });
    expect(readyEvolutionOption(touched)).not.toBeNull();
    expect(applyEvolution(touched, "starfall")).toBe(true);
    expect(touched.rng.nextFloat()).toBe(untouched.rng.nextFloat());
    expect(touched.rng.getState()).toBe(untouched.rng.getState());
  });
});

describe("контрольная сумма забега", () => {
  /** Сценарный забег фиксированной длины: первый вариант на каждом выборе. */
  function runChecksum(weapons: typeof WEAPONS): number {
    const world = newWorld({ seed: 5, weapons });
    const spawner = createConstantPopulationSpawner(40);
    for (let tick = 0; tick < 3000; tick++) {
      if (isAwaitingChoice(world)) chooseUpgrade(world, world.progression.offers[0].id);
      spawner.update(world, TICK_SEC);
      stepWorld(world, benchInput(tick));
    }
    return checksumWorld(world);
  }

  it("забег без эволюции: сумма с WEAPONS равна сумме с BASE_WEAPONS", { timeout: 30_000 }, () => {
    expect(runChecksum(WEAPONS)).toBe(runChecksum(BASE_WEAPONS));
  });

  it("слепок с эволюцией в слоте восстанавливается с той же суммой", () => {
    const make = (): { world: World; director: ReturnType<typeof createTimelineDirector> } => ({ world: readyWorld({ seed: 3 }), director: createTimelineDirector(TIMELINE, ENDLESS_CURVE) });
    const original = make();
    expect(applyEvolution(original.world, "starfall")).toBe(true);
    const saved: unknown = JSON.parse(JSON.stringify(captureWorld(original.world, original.director)));

    const resumed = make();
    restoreWorld(resumed.world, resumed.director, saved);

    expect(resumed.world.weaponTypes[resumed.world.loadout.weapons[0].typeIndex].id).toBe("starfall");
    expect(checksumWorld(resumed.world)).toBe(checksumWorld(original.world));
  });
});
