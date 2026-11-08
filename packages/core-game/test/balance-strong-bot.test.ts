import type { EnemyDef, UpgradeOption } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
import { POWER_PROFILES, simulateBalanceRun } from "../src/game/balance";
import { decodeInputLog } from "../src/game/diagnostics/input-log";
import { pickCard, createStrongBot, STRONG_BOT, STAND_FROM_SEC, STAND_STEP } from "../src/game/balance/strong-bot";
import veteranRun from "./fixtures/veteran-run-v0122.json";
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
  const stander = (): ReturnType<typeof createStrongBot> => createStrongBot({ stance: "stand" });

  it("«стоит» до 180 с двигается как «бегает»", () => {
    const w = world();
    placeEnemies(w, [[100, 0]]);

    w.stats.elapsedSec = STAND_FROM_SEC - 1;
    expect(stander().input(w).moveX).toBeLessThan(0);
  });

  it("с 180 с без врагов рядом не двигается", () => {
    const w = world();
    placeEnemies(w, [[STAND_STEP.radiusUnits + 60, 0]]);
    placeGem(w, 150, 0);

    w.stats.elapsedSec = STAND_FROM_SEC;
    const bot = stander();
    for (let call = 0; call < 40; call++) expect(bot.input(w), `вызов ${String(call)}`).toEqual({ moveX: 0, moveY: 0 });
  });

  it("с 180 с враг ближе радиуса шага — короткий шаг от него, потом снова стоит", () => {
    const w = world();
    placeEnemies(w, [[STAND_STEP.radiusUnits - 10, 0]]);
    w.stats.elapsedSec = STAND_FROM_SEC + 30;

    const bot = stander();
    for (let call = 0; call < STAND_STEP.ticks; call++) expect(bot.input(w).moveX, `шаг ${String(call)}`).toBeLessThan(0);
    // враг остался рядом, но шаг не повторяется, пока не прошла пауза
    expect(bot.input(w)).toEqual({ moveX: 0, moveY: 0 });
    for (let call = 0; call < STAND_STEP.cooldownTicks - 1; call++) bot.input(w);
    expect(bot.input(w).moveX).toBeLessThan(0);
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
  it("порядок владельца: «Живучесть», «Спешка», «Искра», «Обережный камень», «Заживление», «Мощь»", () => {
    const order = [
      offer("passive_new", "vitality"),
      offer("passive_new", "haste"),
      offer("weapon_new", "spark"),
      offer("weapon_new", "wardstone"),
      offer("passive_new", "mending"),
      offer("passive_new", "might"),
    ];
    for (let from = 0; from < order.length - 1; from++) {
      const bot = createStrongBot({ stance: "kite" });
      expect(bot.choose(order.slice(from), undefined), `с ${order[from].id}`).toBe(order[from].id);
      expect(bot.choose([order[order.length - 1], order[from]], undefined)).toBe(order[from].id);
    }
  });

  it("«Очаг» в предложении (значит, слот свободен) берёт раньше навыка вне плана", () => {
    const bot = createStrongBot({ stance: "kite" });
    const picked = bot.choose([offer("passive_new", "reach"), offer("weapon_new", "hearth"), offer("passive_new", "ward")]);
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

  it("развитие оружия плана идёт раньше навыка вне плана и уровня навыка", () => {
    const bot = createStrongBot({ stance: "kite" });
    expect(bot.choose([offer("passive_new", "reach"), offer("weapon_level", "hearth", 2), offer("passive_level", "might", 2)])).toBe(
      "weapon_level:hearth:2",
    );
  });

  it("новое из плана идёт раньше развития оружия: так брал владелец", () => {
    const bot = createStrongBot({ stance: "kite" });
    expect(bot.choose([offer("weapon_level", "spark", 2), offer("passive_new", "mending")])).toBe("passive_new:mending:1");
  });

  it("оружие, чей навык рецепта уже взят, тоже ведёт к эволюции — и развивается первым", () => {
    const bot = createStrongBot({ stance: "kite" });
    // «Быстрота» — рецепт эволюции «Ножа»; пока её нет, нож — обычное оружие
    expect(bot.choose([offer("passive_level", "might", 2), offer("weapon_level", "knife", 2)])).toBe("passive_level:might:2");
    expect(bot.choose([offer("passive_new", "swiftness")])).toBe("passive_new:swiftness:1");
    expect(bot.choose([offer("passive_level", "might", 2), offer("weapon_level", "knife", 2)])).toBe("weapon_level:knife:2");
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

describe("запись забега владельца (v0.12.2, Р196)", () => {
  const codes = decodeInputLog(veteranRun.input);
  const share = (fromSec: number, toSec: number): number => {
    const slice = codes.slice(fromSec * 60, Math.min(codes.length, toSec * 60));
    return slice.filter((code) => code >= 0).length / slice.length;
  };

  it("фикстура — только игровые поля, без следов игрока и устройства", () => {
    const text = JSON.stringify(veteranRun);
    for (const field of ["reportId", "runId", "platformUserId", "installId", "device", "gpu", "perf", "timeline", "startedAt"]) {
      expect(text, field).not.toContain(`"${field}"`);
    }
    expect(veteranRun.startingWeaponId).toBe("hearth");
  });

  it("профиль «ветеран» равен набору из записи", () => {
    expect(POWER_PROFILES.veteran.loadout).toEqual(veteranRun.loadout);
    expect(POWER_PROFILES.veteran.startingWeaponId).toBe(veteranRun.startingWeaponId);
  });

  it("доля движения владельца: половина до 3-й минуты, 44% до 10-й, 4% после", () => {
    expect(codes.length).toBe(veteranRun.input.ticks);
    expect(share(0, 180)).toBeCloseTo(0.5, 2);
    expect(share(180, 600)).toBeCloseTo(0.44, 2);
    expect(share(600, 1242)).toBeCloseTo(0.037, 2);
  });

  it("первые двадцать выборов бота совпадают с выбором владельца", () => {
    // Бот видит те же карточки и тот же набор, что и владелец: набор копится по выборам владельца.
    const passives = new Set<string>();
    const weapons = new Set<string>([veteranRun.startingWeaponId]);
    const asOffer = (id: string): UpgradeOption => {
      const [kind, refId, level] = id.split(":");
      return offer(kind as UpgradeOption["kind"], refId, Number(level));
    };
    const choices = new Map(veteranRun.choices.map(([tick, id]) => [tick as number, id as string]));
    const mismatches: string[] = [];
    let compared = 0;
    for (const [tick, ids] of veteranRun.offers) {
      const owner = choices.get(tick as number);
      if (owner === undefined || compared >= 20) continue;
      const offers = (ids as string).split(",").map(asOffer);
      const picked = pickCard(offers, { passives, weapons, freeWeaponSlots: null, planIncomplete: false });
      if (picked.id !== owner) mismatches.push(`${String(tick)}: бот ${picked.id}, владелец ${owner}`);
      compared++;
      const ownerOffer = asOffer(owner);
      if (ownerOffer.kind === "passive_new" || ownerOffer.kind === "passive_level") passives.add(ownerOffer.refId);
      if (ownerOffer.kind === "weapon_new" || ownerOffer.kind === "weapon_level") weapons.add(ownerOffer.refId);
    }
    expect(compared).toBe(20);
    // Единственное расхождение: на 12708-м тике «Очаг» уже выше 6-го уровня (дали сундуки), и владелец
    // развил «Обережный камень». Бот идёт по месту в плане («Очаг» раньше) и берёт «Очаг».
    expect(mismatches).toEqual(["12708: бот weapon_level:hearth:7, владелец weapon_level:wardstone:3"]);
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
