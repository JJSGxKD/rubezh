import type { EnemyDef, UpgradeOption } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
import { POWER_PROFILES, simulateBalanceRun } from "../src/game/balance";
import { createStrongBot, STRONG_BOT, STAND_FROM_SEC } from "../src/game/balance/strong-bot";
import { spawnGem } from "../src/game/sim/gems";
import { createWorld, spawnEnemy, type World } from "../src/game/sim/world";

// Сильный бот калибровки — модель опытного игрока (Р194, T-0389): собирает
// опыт, строит связку «Очаг + Оберег + Заживление», бегает или стоит.

const RAT: EnemyDef = { id: "rat", hp: 10, speed: 1, damage: 1, xp: 1, pattern: "swarm" };

function world(): World {
  return createWorld({ seed: 1, enemies: [RAT], config: { progressionEnabled: false, lootEnabled: true } });
}

/** Ставит врагов в единицах контента и перестраивает сетку, как это делает шаг мира. */
function placeEnemies(w: World, points: readonly (readonly [number, number])[]): void {
  const scale = w.config.unitScale;
  for (const [x, y] of points) spawnEnemy(w, 0, x * scale, y * scale);
  w.enemyGrid.rebuild(w.player.x, w.player.y, w.enemies.x, w.enemies.y, w.enemies.alive, w.enemies.count);
}

/** Кристалл, уже лежащий на земле: без полёта от места смерти. */
function placeGem(w: World, x: number, y: number): void {
  const scale = w.config.unitScale;
  spawnGem(w, x * scale, y * scale, 1);
}

function offer(kind: UpgradeOption["kind"], refId: string, level = 1): UpgradeOption {
  return { id: `${kind}:${refId}:${String(level)}`, kind, refId, level, nameKey: "", descriptionKey: "", changes: [] };
}

describe("детерминизм", () => {
  it("два прогона одного seed дают один итог — для обеих стоек", { timeout: 60_000 }, () => {
    for (const stance of ["kite", "stand"] as const) {
      const options = { seed: 4, skill: "strong", stance, maxSec: 150, loadout: POWER_PROFILES.average.loadout } as const;
      expect(simulateBalanceRun(options), stance).toEqual(simulateBalanceRun(options));
    }
  });

  it("прогон помнит, каким ботом шёл", { timeout: 60_000 }, () => {
    expect(simulateBalanceRun({ seed: 2, skill: "strong", stance: "stand", maxSec: 30 }).skill).toBe("strong");
  });
});

describe("стойка", () => {
  it("«стоит» до 180 с двигается, а с 180 с не двигается", () => {
    const w = world();
    placeEnemies(w, [[100, 0]]);

    w.stats.elapsedSec = STAND_FROM_SEC - 1;
    expect(createStrongBot({ stance: "stand" }).input(w).moveX).toBeLessThan(0);

    w.stats.elapsedSec = STAND_FROM_SEC;
    expect(createStrongBot({ stance: "stand" }).input(w)).toEqual({ moveX: 0, moveY: 0 });
    w.stats.elapsedSec = STAND_FROM_SEC + 400;
    expect(createStrongBot({ stance: "stand" }).input(w)).toEqual({ moveX: 0, moveY: 0 });
  });

  it("«бегает» не останавливается и после 180 с", () => {
    const w = world();
    placeEnemies(w, [[100, 0]]);

    w.stats.elapsedSec = STAND_FROM_SEC + 400;
    expect(createStrongBot({ stance: "kite" }).input(w).moveX).toBeLessThan(0);
  });
});

describe("сбор опыта", () => {
  it("угрозы нет — идёт к ближайшему кристаллу в радиусе сбора", () => {
    const w = world();
    placeGem(w, 0, STRONG_BOT.collectRadiusUnits - 20);
    placeGem(w, -(STRONG_BOT.collectRadiusUnits - 40), 0);

    const move = createStrongBot({ stance: "kite" }).input(w);
    // ближний — второй, слева: ближе на 20 единиц
    expect(move.moveX).toBeLessThan(-0.99);
    expect(Math.abs(move.moveY)).toBeLessThan(0.05);
  });

  it("кристалл за радиусом сбора бот не берёт в расчёт", () => {
    const w = world();
    placeGem(w, -(STRONG_BOT.collectRadiusUnits + 60), 0);

    // идти некуда — курс остаётся прежним (вправо), а не к далёкому кристаллу
    expect(createStrongBot({ stance: "kite" }).input(w).moveX).toBeGreaterThan(0);
  });

  it("враг в безопасном радиусе важнее кристалла: бот уходит от врага, а не за добычей", () => {
    const w = world();
    placeEnemies(w, [[-60, 0]]);
    placeGem(w, -150, 0);

    expect(createStrongBot({ stance: "kite" }).input(w).moveX).toBeGreaterThan(0);
  });

  it("враг за безопасным радиусом кристалл не отменяет", () => {
    const w = world();
    placeEnemies(w, [[0, STRONG_BOT.safeRadiusUnits + 80]]);
    placeGem(w, -150, 0);

    expect(createStrongBot({ stance: "kite" }).input(w).moveX).toBeLessThan(-0.9);
  });
});

describe("выбор карточек", () => {
  it("«Очаг» в предложении (значит, слот свободен) берёт раньше навыка урона и живучести", () => {
    const bot = createStrongBot({ stance: "kite" });
    const picked = bot.choose([offer("passive_new", "might"), offer("weapon_new", "hearth"), offer("passive_new", "vitality")]);
    expect(picked).toBe("weapon_new:hearth:1");
  });

  it("«Оберег» берёт так же", () => {
    const bot = createStrongBot({ stance: "kite" });
    expect(bot.choose([offer("passive_level", "haste", 2), offer("weapon_new", "wardstone"), offer("weapon_new", "knife")])).toBe(
      "weapon_new:wardstone:1",
    );
  });

  it("новое оружие вне связки не перебивает Заживление, Живучесть и Магнит", () => {
    const bot = createStrongBot({ stance: "kite" });
    expect(bot.choose([offer("weapon_new", "knife"), offer("passive_new", "lodestone")])).toBe("passive_new:lodestone:1");
    expect(bot.choose([offer("weapon_new", "knife"), offer("passive_new", "vitality")])).toBe("passive_new:vitality:1");
    expect(bot.choose([offer("weapon_new", "knife"), offer("passive_new", "mending")])).toBe("passive_new:mending:1");
  });

  it("развитие оружия связки идёт раньше нового навыка", () => {
    const bot = createStrongBot({ stance: "kite" });
    expect(bot.choose([offer("passive_new", "vitality"), offer("weapon_level", "hearth", 2), offer("passive_new", "might")])).toBe(
      "weapon_level:hearth:2",
    );
  });

  it("оружие, чей навык рецепта уже взят, тоже ведёт к эволюции — и развивается первым", () => {
    const bot = createStrongBot({ stance: "kite" });
    // «Быстрота» — рецепт эволюции «Ножа»; пока её нет, нож — обычное оружие
    expect(bot.choose([offer("passive_new", "might"), offer("weapon_level", "knife", 2)])).toBe("passive_new:might:1");
    expect(bot.choose([offer("passive_new", "swiftness")])).toBe("passive_new:swiftness:1");
    expect(bot.choose([offer("passive_new", "might"), offer("weapon_level", "knife", 2)])).toBe("weapon_level:knife:2");
  });

  it("урон и перезарядка — после связки и выживания, но раньше прочего", () => {
    const bot = createStrongBot({ stance: "kite" });
    expect(bot.choose([offer("passive_new", "swiftness"), offer("passive_new", "might")])).toBe("passive_new:might:1");
    expect(bot.choose([offer("passive_new", "reach"), offer("passive_level", "haste", 2)])).toBe("passive_level:haste:2");
  });

  it("нечего предпочесть — первая карточка", () => {
    const bot = createStrongBot({ stance: "kite" });
    const offers = [offer("heal", ""), offer("limit", "speed")];
    expect(bot.choose(offers)).toBe(offers[0].id);
  });
});

/** Мир, который ждёт выбора карточки: настоящий контент, заряды переброса и изгнания, заданные карточки. */
function worldWaiting(offers: UpgradeOption[], tools: { reroll: number; banish: number }): World {
  const w = createWorld({
    seed: 1,
    enemies: [RAT],
    weapons: WEAPONS,
    passives: PASSIVES,
    loadoutLimits: LOADOUT_LIMITS,
    startingWeaponId: "spark",
    cardTools: tools,
    config: { progressionEnabled: true },
  });
  w.progression.offers = offers;
  return w;
}

describe("переброс и изгнание карточек", () => {
  it("в плане ещё есть «Очаг», а на карточках его нет — переброс", () => {
    const offers = [offer("passive_new", "reach"), offer("passive_new", "volley"), offer("weapon_new", "knife")];
    const w = worldWaiting(offers, { reroll: 1, banish: 0 });
    expect(createStrongBot({ stance: "kite" }).choose(offers, w)).toBe("~reroll");
  });

  it("нет заряда переброса — берёт лучшую из показанного", () => {
    const offers = [offer("passive_new", "reach"), offer("passive_new", "might")];
    const w = worldWaiting(offers, { reroll: 0, banish: 0 });
    expect(createStrongBot({ stance: "kite" }).choose(offers, w)).toBe("passive_new:might:1");
  });

  it("на карточках есть «Очаг» — не перебрасывает: заряд остаётся на потом", () => {
    const offers = [offer("passive_new", "reach"), offer("weapon_new", "hearth")];
    const w = worldWaiting(offers, { reroll: 2, banish: 1 });
    expect(createStrongBot({ stance: "kite" }).choose(offers, w)).toBe("weapon_new:hearth:1");
  });

  it("лучшее из показанного закрывает слот связке, перебросить нельзя — изгоняет его", () => {
    // «Быстрота» заняла бы единственный слот подвижности, который ждёт «Магнит»
    const offers = [offer("passive_new", "swiftness")];
    const w = worldWaiting(offers, { reroll: 0, banish: 1 });
    expect(createStrongBot({ stance: "kite" }).choose(offers, w)).toBe("~banish:passive_new:swiftness:1");
  });

  it("прогон с заданными зарядами заканчивается: команды расходуют заряды, а не зацикливаются", { timeout: 60_000 }, () => {
    const run = simulateBalanceRun({ seed: 3, skill: "strong", stance: "kite", maxSec: 120, loadout: POWER_PROFILES.full.loadout });
    expect(run.survivalSec).toBeGreaterThan(0);
  });
});

describe("просвет в кольце врагов", () => {
  it("кольцо врагов со всех сторон, кроме одной, — бот идёт в просвет", () => {
    const w = world();
    // кольцо по шестнадцати направлениям, пустое справа
    const ring: [number, number][] = [];
    const around: [number, number][] = [
      [-1, 0], [-0.92, 0.38], [-0.92, -0.38], [-0.7, 0.7], [-0.7, -0.7], [-0.38, 0.92], [-0.38, -0.92],
      [0, 1], [0, -1], [0.38, 0.92], [0.38, -0.92], [0.7, 0.7], [0.7, -0.7],
    ];
    for (const [x, y] of around) ring.push([x * 90, y * 90]);
    placeEnemies(w, ring);

    expect(createStrongBot({ stance: "kite" }).input(w).moveX).toBeGreaterThan(0.5);
  });
});

describe("сильный бот против уклоняющегося", () => {
  it(
    "«бегает» со средним профилем живёт дольше уклоняющегося и собирает больше опыта к 300 с",
    { timeout: 120_000 },
    () => {
      let strongSurvival = 0;
      let dodgingSurvival = 0;
      let strongXp = 0;
      let dodgingXp = 0;
      for (const seed of [1, 2, 3, 4, 5]) {
        const common = { seed, startingWeaponId: "spark", maxSec: 300, loadout: POWER_PROFILES.average.loadout } as const;
        const strong = simulateBalanceRun({ ...common, skill: "strong", stance: "kite" });
        const dodging = simulateBalanceRun({ ...common, skill: "dodging" });
        strongSurvival += strong.survivalSec;
        dodgingSurvival += dodging.survivalSec;
        strongXp += strong.xpCollected;
        dodgingXp += dodging.xpCollected;
      }
      expect(strongSurvival).toBeGreaterThan(dodgingSurvival);
      expect(strongXp).toBeGreaterThan(dodgingXp);
    },
  );
});
