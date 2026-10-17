import type { ChestsDef, EnemyDef, LevelCurveDef, LoadoutLimits, PassiveDef, WeaponDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { CHESTS } from "../src/content/chests";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
import { killEnemy } from "../src/game/sim/combat";
import { dropChest, openChest, takeChestEvents } from "../src/game/sim/chests";
import {
  countOnField,
  PICKUP_KIND,
  PICKUP_LAND_TICKS,
  spawnPickup,
  updatePickups,
  type PickupKind,
} from "../src/game/sim/pickups";
import { createRng, deriveSeed, STREAM_SALT } from "../src/game/sim/rng";
import { createWorld, spawnEnemy, type CreateWorldOptions, type World } from "../src/game/sim/world";

// Сундук забега: падает с элиты и босса, при касании выдаёт 1, 3 или 5
// улучшений сам (docs/39-retention-mechanics.md Б1). Случайность сундука —
// отдельный поток от seed: world.rng он не трогает ни разу.

const GRUNT: EnemyDef = { id: "grunt", hp: 10, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };
const ELITE: EnemyDef = { id: "elite", hp: 100, speed: 0.001, damage: 0, xp: 1, pattern: "swarm", rank: "elite" };
const BOSS: EnemyDef = { id: "boss", hp: 100, speed: 0.001, damage: 0, xp: 1, pattern: "swarm", rank: "boss" };
const ENEMIES = [GRUNT, ELITE, BOSS];
const [GRUNT_TYPE, ELITE_TYPE, BOSS_TYPE] = [0, 1, 2];

const CHEST_KINDS: readonly PickupKind[] = [PICKUP_KIND.chestOne, PICKUP_KIND.chestThree, PICKUP_KIND.chestFive];
const SIZE_BY_KIND = new Map<number, number>([
  [PICKUP_KIND.chestOne, 1],
  [PICKUP_KIND.chestThree, 3],
  [PICKUP_KIND.chestFive, 5],
]);

/** Сундук в тестах не ограничен по числу на поле: ограничение проверяется отдельно. */
const ROOMY: ChestsDef = { ...CHESTS, maxOnField: 8 };

function setup(patch: Partial<CreateWorldOptions> = {}, chests: ChestsDef = ROOMY, seed = 1): World {
  return createWorld({
    seed,
    enemies: ENEMIES,
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    chests,
    ...patch,
  });
}

function kill(world: World, type: number): void {
  killEnemy(world, spawnEnemy(world, type, 100, 0));
}

/** Размеры лежащих на поле сундуков по порядку слотов. */
function chestSizes(world: World): number[] {
  const pool = world.pickups;
  const sizes: number[] = [];
  for (let i = 0; i < pool.count; i++) {
    const size = pool.alive[i] === 1 ? SIZE_BY_KIND.get(pool.kind[i]) : undefined;
    if (size !== undefined) sizes.push(size);
  }
  return sizes;
}

function chestsOnField(world: World): number {
  return CHEST_KINDS.reduce<number>((sum, kind) => sum + countOnField(world, kind), 0);
}

// --- Мини-мир без выбора: всё на потолке ---------------------------------------

const text = { nameKey: "n", descriptionKey: "d" };
const SPARK: WeaponDef = {
  id: "spark",
  behavior: "projectile_nearest",
  ...text,
  levels: [
    { damage: 10, cooldownSec: 0.5, projectiles: 1, projectileSpeed: 600, ttlSec: 2 },
    { damage: 20, cooldownSec: 0.5, projectiles: 1, projectileSpeed: 600, ttlSec: 2 },
  ],
};
const MIGHT: PassiveDef = { id: "might", ...text, category: "attack", stat: "damage", op: "mul", levels: [1.1] };
const TINY_LIMITS: LoadoutLimits = { weapons: 1, passives: { attack: 1, defense: 0, mobility: 0 } };
const TINY_CURVE: LevelCurveDef = { baseXp: 40, growth: 1.2 };

/** Оружие и пассивка прокачаны до предела, слоты заняты: брать нечего. */
function maxedWorld(): World {
  const world = createWorld({
    seed: 3,
    enemies: ENEMIES,
    weapons: [SPARK],
    passives: [MIGHT],
    levelCurve: TINY_CURVE,
    loadoutLimits: TINY_LIMITS,
    chests: ROOMY,
  });
  world.loadout.weapons[0].level = 2;
  world.loadout.passives.push({ typeIndex: 0, level: 1 });
  return world;
}

describe("поток случайности сундуков", () => {
  it("deriveSeed повторяется и отдаёт целое из [0, 2^32)", () => {
    for (const seed of [0, 1, 4242, 0xffffffff, 123456789]) {
      const value = deriveSeed(seed, STREAM_SALT.chest);
      expect(value).toBe(deriveSeed(seed, STREAM_SALT.chest));
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(2 ** 32);
    }
  });

  it("потоки сундуков и карточек не совпадают, а соседние seed расходятся", () => {
    expect(STREAM_SALT.chest).not.toBe(STREAM_SALT.cards);
    expect(deriveSeed(7, STREAM_SALT.chest)).not.toBe(deriveSeed(7, STREAM_SALT.cards));
    expect(deriveSeed(7, STREAM_SALT.chest)).not.toBe(deriveSeed(8, STREAM_SALT.chest));
  });

  it("мир заводит поток сундуков от deriveSeed, а не от seed забега", () => {
    const world = setup({}, ROOMY, 99);
    expect(world.chests.rng.getState()).toBe(createRng(deriveSeed(99, STREAM_SALT.chest)).getState());
    expect(world.chests.rng.getState()).not.toBe(world.rng.getState());
  });
});

describe("выпадение сундука", () => {
  it("первые четыре сундука — 1, 3, 1, 5, потом по весам", () => {
    const world = setup();
    const sizes: number[] = [];
    for (let k = 0; k < 5; k++) {
      kill(world, ELITE_TYPE);
      sizes.push(world.chests.founds[k].size);
    }
    expect(sizes.slice(0, 4)).toEqual([1, 3, 1, 5]);
    expect([1, 3, 5]).toContain(sizes[4]);
    expect(world.chests.dropped).toBe(5);
    expect(world.stats.chestsFound).toBe(5);
    expect(chestSizes(world)).toHaveLength(5);
  });

  it("после схемы размеры идут по весам: единичные чаще всего", () => {
    const world = setup({}, { ...ROOMY, opening: [] });
    const counts = new Map<number, number>();
    for (let k = 0; k < 300; k++) {
      dropChest(world, 0, 0, "elite");
      const size = world.chests.founds[world.chests.founds.length - 1].size;
      counts.set(size, (counts.get(size) ?? 0) + 1);
      world.pickups.alive.fill(0);
      world.pickups.aliveCount = 0;
    }
    expect(counts.get(1) ?? 0).toBeGreaterThan(counts.get(3) ?? 0);
    expect(counts.get(3) ?? 0).toBeGreaterThan(0);
    expect(counts.get(5) ?? 0).toBeGreaterThan(0);
  });

  it("сундук с босса не меньше bossMinSize, а источник записан", () => {
    const world = setup({}, { ...ROOMY, opening: [] });
    for (let k = 0; k < 40; k++) {
      kill(world, BOSS_TYPE);
      const found = world.chests.founds[k];
      expect(found.size).toBeGreaterThanOrEqual(CHESTS.bossMinSize);
      expect(found.source).toBe("boss");
      world.pickups.alive.fill(0);
      world.pickups.aliveCount = 0;
    }
  });

  it("с элиты в записи источник elite, номер идёт с нуля, время — секунда забега", () => {
    const world = setup();
    world.stats.elapsedSec = 95;
    kill(world, ELITE_TYPE);
    kill(world, ELITE_TYPE);
    expect(world.chests.founds.map((found) => found.index)).toEqual([0, 1]);
    expect(world.chests.founds[0]).toMatchObject({ source: "elite", elapsedSec: 95 });
  });

  it("рядовой враг сундук не роняет", () => {
    const world = setup();
    for (let k = 0; k < 30; k++) kill(world, GRUNT_TYPE);
    expect(chestsOnField(world)).toBe(0);
    expect(world.chests.dropped).toBe(0);
  });

  it("держит потолок на поле: две элиты при maxOnField 1 — один сундук", () => {
    const world = setup({}, { ...CHESTS, maxOnField: 1 });
    kill(world, ELITE_TYPE);
    kill(world, ELITE_TYPE);
    expect(chestsOnField(world)).toBe(1);
    expect(world.chests.dropped).toBe(1);
    expect(world.chests.founds).toHaveLength(1);
  });

  it("maxOnField 0 — сундуков нет вовсе", () => {
    const world = setup({}, { ...CHESTS, maxOnField: 0 });
    kill(world, ELITE_TYPE);
    expect(chestsOnField(world)).toBe(0);
    expect(world.chests.dropped).toBe(0);
  });

  it("не считает сундук выпавшим, если пул подборов переполнен", () => {
    const world = setup();
    for (let slot = 0; slot < world.pickups.alive.length; slot++) {
      spawnPickup(world, PICKUP_KIND.medkit, 5000 + slot, 5000);
    }
    kill(world, ELITE_TYPE);
    expect(world.chests.dropped).toBe(0);
    expect(world.stats.chestsFound).toBe(0);
    expect(world.chests.founds).toHaveLength(0);

    // Неудача не съедает схему: первый выпавший сундук всё равно размера 1.
    world.pickups.alive.fill(0);
    world.pickups.aliveCount = 0;
    kill(world, ELITE_TYPE);
    expect(world.chests.founds.map((found) => found.size)).toEqual([1]);
  });

  it("без добычи и без прокачки сундука нет, и мир не падает", () => {
    const noLoot = setup({ config: { lootEnabled: false } });
    kill(noLoot, ELITE_TYPE);
    expect(noLoot.chests.dropped).toBe(0);

    const noProgression = setup({ config: { progressionEnabled: false } });
    expect(() => kill(noProgression, ELITE_TYPE)).not.toThrow();
    expect(noProgression.chests.dropped).toBe(0);
  });

  it("мир без заданного сундука по умолчанию их не роняет", () => {
    const world = createWorld({ seed: 1, enemies: ENEMIES });
    kill(world, ELITE_TYPE);
    expect(world.chests.dropped).toBe(0);
    expect(world.chestRules.maxOnField).toBe(0);
  });
});

describe("генератор мира", () => {
  it("убийство элиты и открытие сундука не сдвигают world.rng", () => {
    const withChests = setup({}, ROOMY, 5);
    const without = setup({}, { ...CHESTS, maxOnField: 0 }, 5);

    kill(withChests, ELITE_TYPE);
    kill(without, ELITE_TYPE);
    expect(withChests.chests.dropped).toBe(1);
    expect(withChests.rng.getState()).toBe(without.rng.getState());

    openChest(withChests, 5);
    expect(withChests.rng.getState()).toBe(without.rng.getState());
  });
});

describe("открытие сундука", () => {
  it("размер 3 даёт ровно три допустимые награды, набор меняется", () => {
    const world = setup();
    const before = JSON.stringify([world.loadout.weapons, world.loadout.passives]);

    openChest(world, 3);

    const opening = world.chests.openings[0];
    expect(opening.rewards).toHaveLength(3);
    expect(opening.size).toBe(3);
    expect(JSON.stringify([world.loadout.weapons, world.loadout.passives])).not.toBe(before);

    expect(world.loadout.weapons.length).toBeLessThanOrEqual(LOADOUT_LIMITS.weapons);
    for (const slot of world.loadout.weapons) {
      expect(slot.level).toBeLessThanOrEqual(world.weaponTypes[slot.typeIndex].levels.length);
    }
    for (const slot of world.loadout.passives) {
      expect(slot.level).toBeLessThanOrEqual(world.passiveTypes[slot.typeIndex].levels.length);
    }
    for (const category of ["attack", "defense", "mobility"] as const) {
      const taken = world.loadout.passives.filter(
        (slot) => world.passiveTypes[slot.typeIndex].category === category,
      ).length;
      expect(taken).toBeLessThanOrEqual(LOADOUT_LIMITS.passives[category]);
    }
  });

  it("награды сундука не повторяются и не выдают то, что нельзя взять", () => {
    const world = setup();
    openChest(world, 5);
    const ids = world.chests.openings[0].rewards.map((reward) => reward.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const reward of world.chests.openings[0].rewards) {
      expect(["weapon_new", "weapon_level", "passive_new", "passive_level"]).toContain(reward.kind);
    }
  });

  it("два мира с одним seed получают одинаковые награды", () => {
    const first = setup({}, ROOMY, 31);
    const second = setup({}, ROOMY, 31);
    openChest(first, 5);
    openChest(second, 5);
    expect(first.chests.openings[0].rewards.map((reward) => reward.id)).toEqual(
      second.chests.openings[0].rewards.map((reward) => reward.id),
    );
  });

  it("запись открытия: номер, размер, число запасных наград и время", () => {
    const world = setup();
    world.stats.elapsedSec = 130;
    openChest(world, 1);
    openChest(world, 3);
    expect(world.chests.openings.map((opening) => opening.index)).toEqual([0, 1]);
    expect(world.chests.openings[1]).toMatchObject({ size: 3, fallbacks: 0, elapsedSec: 130 });
    expect(world.chests.opened).toBe(2);
    expect(world.stats.chestsOpened).toBe(2);
  });

  it("огромный ownedWeightMul — награды сплошь повышения уже взятого", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const world = setup({}, { ...ROOMY, ownedWeightMul: 1_000_000 }, seed);
      openChest(world, 1);
      expect(world.chests.openings[0].rewards[0].kind, `seed ${seed}`).toBe("weapon_level");
    }
  });

  it("не трогает варианты уровня и очередь уровней", () => {
    const world = setup();
    world.progression.pendingLevelUps = 2;
    world.progression.offers = [];
    const before = { offers: [...world.progression.offers], pending: world.progression.pendingLevelUps };

    openChest(world, 5);

    expect(world.progression.offers).toEqual(before.offers);
    expect(world.progression.pendingLevelUps).toBe(before.pending);
  });
});

describe("запасная награда", () => {
  it("всё на потолке, здоровье ниже порога — аптечка", () => {
    const world = maxedWorld();
    world.player.hp = world.playerStats.maxHp * 0.5;

    openChest(world, 1);

    const opening = world.chests.openings[0];
    expect(opening.rewards.map((reward) => reward.kind)).toEqual(["heal"]);
    expect(opening.fallbacks).toBe(1);
    expect(world.player.hp).toBeGreaterThan(world.playerStats.maxHp * 0.5);
  });

  it("при очень низком здоровье все три награды — аптечки", () => {
    const world = maxedWorld();
    world.player.hp = 1;
    openChest(world, 3);
    expect(world.chests.openings[0].rewards.map((reward) => reward.kind)).toEqual(["heal", "heal", "heal"]);
    expect(world.chests.openings[0].fallbacks).toBe(3);
  });

  it("здоровье полное — опыт: доля пути до уровня, в статистику сбора не идёт", () => {
    const world = maxedWorld();
    const need = Math.ceil(world.progression.xpToNext * CHESTS.xpRatio);
    const collected = world.stats.xpCollected;

    openChest(world, 1);

    const reward = world.chests.openings[0].rewards[0];
    expect(reward.kind).toBe("xp");
    expect(reward.id).toBe("xp");
    expect(reward.nameKey).toBe("upgrade.xp.name");
    expect(reward.changes[0]).toMatchObject({ labelKey: "upgrade.xp.label", from: null, to: need, format: "plus" });
    expect(world.progression.xp).toBe(need);
    expect(world.progression.totalXp).toBe(need);
    expect(world.stats.xpCollected).toBe(collected);
    expect(world.chests.openings[0].fallbacks).toBe(1);
  });
});

describe("подбор сундука", () => {
  function dropAndLand(world: World, kind: PickupKind, dx: number, dy: number): number {
    spawnPickup(world, kind, world.player.x + dx, world.player.y + dy);
    world.stats.tick += PICKUP_LAND_TICKS;
    return world.pickups.count - 1;
  }

  it("сундук в радиусе сбора не тянется к игроку", () => {
    const world = setup();
    const slot = dropAndLand(world, PICKUP_KIND.chestOne, world.playerStats.pickupRadius * 0.6, 0);
    const [x, y] = [world.pickups.x[slot], world.pickups.y[slot]];

    for (let tick = 0; tick < 30; tick++) updatePickups(world);

    expect(world.pickups.x[slot]).toBe(x);
    expect(world.pickups.y[slot]).toBe(y);
    expect(world.pickups.alive[slot]).toBe(1);
  });

  it("касание открывает сундук нужного размера и снимает его с поля", () => {
    for (const [kind, size] of [
      [PICKUP_KIND.chestOne, 1],
      [PICKUP_KIND.chestThree, 3],
      [PICKUP_KIND.chestFive, 5],
    ] as const) {
      const world = setup();
      dropAndLand(world, kind, 0, 0);
      updatePickups(world);
      expect(world.pickups.aliveCount).toBe(0);
      expect(world.chests.openings).toHaveLength(1);
      expect(world.chests.openings[0].size).toBe(size);
      expect(world.chests.openings[0].rewards).toHaveLength(size);
    }
  });

  it("летящий сундук не открывается", () => {
    const world = setup();
    spawnPickup(world, PICKUP_KIND.chestOne, world.player.x, world.player.y);
    updatePickups(world);
    expect(world.chests.openings).toHaveLength(0);
    expect(world.pickups.aliveCount).toBe(1);
  });

  it("за радиусом удержания сундук исчезает, как любой подбор", () => {
    const world = setup();
    dropAndLand(world, PICKUP_KIND.chestFive, world.config.view.retentionRadius + 50, 0);
    updatePickups(world);
    expect(world.pickups.aliveCount).toBe(0);
    expect(world.chests.openings).toHaveLength(0);
  });
});

describe("события сундуков для сцены", () => {
  it("первый вызов отдаёт новое, второй — пусто; курсор сдвигается", () => {
    const world = setup();
    kill(world, ELITE_TYPE);
    openChest(world, 1);

    const first = takeChestEvents(world, { found: 0, opened: 0 });
    expect(first.found).toHaveLength(1);
    expect(first.opened).toHaveLength(1);
    expect(first.cursor).toEqual({ found: 1, opened: 1 });

    const second = takeChestEvents(world, first.cursor);
    expect(second.found).toHaveLength(0);
    expect(second.opened).toHaveLength(0);
    expect(second.cursor).toEqual(first.cursor);

    kill(world, ELITE_TYPE);
    const third = takeChestEvents(world, second.cursor);
    expect(third.found.map((found) => found.index)).toEqual([1]);
    expect(third.cursor).toEqual({ found: 2, opened: 1 });
  });

  it("не меняет мир", () => {
    const world = setup();
    kill(world, ELITE_TYPE);
    const before = JSON.stringify(world.chests.founds);
    takeChestEvents(world, { found: 0, opened: 0 });
    expect(JSON.stringify(world.chests.founds)).toBe(before);
    expect(world.chests.dropped).toBe(1);
  });
});
