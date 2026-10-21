import type { BoostDef, EnemyDef, LoadoutLimits, WeaponDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { CHESTS } from "../src/content/chests";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
import {
  applyCardTool,
  BANISH_PREFIX,
  canReroll,
  isCardToolCommand,
  itemKeyOf,
  MAX_CARD_TOOLS,
  REROLL_COMMAND,
  SKIP_COMMAND,
} from "../src/game/progression/card-tools";
import { addXp, chooseUpgrade, collectCandidates, HEAL_OPTION_ID, healOption, prepareOffers } from "../src/game/progression/levels";
import { EMPTY_LOADOUT } from "../src/game/progression/run-loadout";
import { openChest } from "../src/game/sim/chests";
import { createRng, deriveSeed, STREAM_SALT } from "../src/game/sim/rng";
import { createWorld, type CreateWorldOptions, type World } from "../src/game/sim/world";

// Переброс, пропуск и изгнание карточек (docs/39-retention-mechanics.md Б3):
// случайность действий — отдельный поток от seed, world.rng они не двигают.

const GRUNT: EnemyDef = { id: "grunt", hp: 10, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };
const TOOLS = { reroll: 2, skip: 1, banish: 1 };

/** Мир, который уже ждёт выбора: опыта хватило ровно на уровень. */
function choosing(patch: Partial<CreateWorldOptions> = {}, seed = 1): World {
  const world = createWorld({
    seed,
    enemies: [GRUNT],
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    chests: { ...CHESTS, maxOnField: 8 },
    cardTools: TOOLS,
    ...patch,
  });
  addXp(world, world.progression.xpToNext);
  prepareOffers(world);
  return world;
}

/** Мир с ровно `count` кандидатами: оружие без пассивок, слотов под всё. */
function smallPool(count: number, patch: Partial<CreateWorldOptions> = {}): World {
  const weapons: WeaponDef[] = WEAPONS.slice(0, count);
  const limits: LoadoutLimits = { weapons: count, passives: { attack: 0, defense: 0, mobility: 0 } };
  return choosing({ weapons, passives: [], loadoutLimits: limits, ...patch });
}

const ids = (world: World): string[] => world.progression.offers.map((offer) => offer.id);

describe("фикстура", () => {
  it("в полном мире кандидатов хватает на переброс", () => {
    const world = choosing();
    expect(collectCandidates(world).length).toBeGreaterThanOrEqual(12);
    expect(world.progression.offers).toHaveLength(3);
  });

  it("маленький мир даёт ровно столько кандидатов, сколько просили", () => {
    expect(collectCandidates(smallPool(3))).toHaveLength(3);
    expect(collectCandidates(smallPool(5))).toHaveLength(5);
  });
});

describe("команды", () => {
  it("узнаёт команды по префиксу, обычный id варианта — нет", () => {
    expect(isCardToolCommand(REROLL_COMMAND)).toBe(true);
    expect(isCardToolCommand(SKIP_COMMAND)).toBe(true);
    expect(isCardToolCommand(`${BANISH_PREFIX}weapon_new:spark:1`)).toBe(true);
    expect(isCardToolCommand("weapon_new:spark:1")).toBe(false);
    expect(isCardToolCommand(HEAL_OPTION_ID)).toBe(false);
  });

  it("ключ предмета — вид и id; у лечения ключа нет", () => {
    const world = choosing();
    const weapon = world.progression.offers.find((offer) => offer.kind.startsWith("weapon"));
    const passive = world.progression.offers.find((offer) => offer.kind.startsWith("passive"));
    if (weapon !== undefined) expect(itemKeyOf(weapon)).toBe(`weapon:${weapon.refId}`);
    if (passive !== undefined) expect(itemKeyOf(passive)).toBe(`passive:${passive.refId}`);
    expect(itemKeyOf(healOption())).toBeNull();
  });

  it("потолок зарядов — девять", () => {
    expect(MAX_CARD_TOOLS).toBe(9);
  });
});

describe("поток случайности карточек", () => {
  it("заводится от deriveSeed, а не от seed забега", () => {
    const world = choosing({}, 77);
    expect(world.cardRng.getState()).toBe(createRng(deriveSeed(77, STREAM_SALT.cards)).getState());
    expect(world.cardRng.getState()).not.toBe(world.rng.getState());
  });

  it("мир без зарядов: нули, потока не трогает", () => {
    const world = choosing({ cardTools: undefined });
    expect(world.progression.tools).toEqual({ reroll: 0, skip: 0, banish: 0 });
    expect(world.progression.toolsTotal).toEqual({ reroll: 0, skip: 0, banish: 0 });
    expect(world.progression.banished).toEqual([]);
  });
});

describe("переброс", () => {
  it("меняет все карточки на новые, число то же, заряд −1, world.rng цел", () => {
    const world = choosing();
    const before = ids(world);
    const rngBefore = world.rng.getState();
    const result = applyCardTool(world, REROLL_COMMAND);

    expect(result).toEqual({ kind: "reroll", left: 1, item: null });
    expect(ids(world)).toHaveLength(before.length);
    expect(ids(world).filter((id) => before.includes(id))).toEqual([]);
    expect(new Set(ids(world)).size).toBe(ids(world).length);
    expect(world.progression.tools.reroll).toBe(1);
    expect(world.progression.toolsTotal.reroll).toBe(2);
    expect(world.rng.getState()).toBe(rngBefore);
  });

  it("с лишней карточкой буста показывает на одну больше и после переброса", () => {
    const insight: BoostDef = { id: "insight", nameKey: "n", descriptionKey: "d", extraOffers: 1 };
    const world = choosing({ boosts: [insight], maxBoostsPerRun: 3, loadout: { ...EMPTY_LOADOUT, boosts: ["insight"] } });
    expect(world.progression.offers).toHaveLength(4);
    applyCardTool(world, REROLL_COMMAND);
    expect(world.progression.offers).toHaveLength(4);
  });

  it("без заряда не применяется: карточки и счётчик целы", () => {
    const world = choosing({ cardTools: { reroll: 0, skip: 1, banish: 1 } });
    const before = ids(world);
    expect(canReroll(world)).toBe(false);
    expect(applyCardTool(world, REROLL_COMMAND)).toBeNull();
    expect(ids(world)).toEqual(before);
    expect(world.progression.tools.reroll).toBe(0);
  });

  it("без альтернатив (ровно три кандидата) не применяется, заряд цел", () => {
    const world = smallPool(3);
    const before = ids(world);
    expect(canReroll(world)).toBe(false);
    expect(applyCardTool(world, REROLL_COMMAND)).toBeNull();
    expect(ids(world)).toEqual(before);
    expect(world.progression.tools.reroll).toBe(2);
  });

  it("не хватает новых — добор из прежних, повторов нет", () => {
    // Пять кандидатов, четыре карточки: новая только одна.
    const insight: BoostDef = { id: "insight", nameKey: "n", descriptionKey: "d", extraOffers: 1 };
    const world = smallPool(5, { boosts: [insight], maxBoostsPerRun: 3, loadout: { ...EMPTY_LOADOUT, boosts: ["insight"] } });
    const shown = ids(world);
    const extra = collectCandidates(world).map((candidate) => candidate.option.id).filter((id) => !shown.includes(id));
    expect(shown).toHaveLength(4);
    expect(extra).toHaveLength(1);

    expect(applyCardTool(world, REROLL_COMMAND)).not.toBeNull();
    expect(ids(world)).toHaveLength(4);
    expect(new Set(ids(world)).size).toBe(4);
    expect(ids(world)).toContain(extra[0]);
  });

  it("когда карточки — лечение, переброс невозможен", () => {
    const world = choosing();
    world.progression.offers = [healOption()];
    expect(canReroll(world)).toBe(false);
    expect(applyCardTool(world, REROLL_COMMAND)).toBeNull();
  });
});

describe("пропуск", () => {
  it("забирает уровень без улучшения и платит долей опыта, в «собрано» не идёт", () => {
    const world = choosing();
    const { xp, xpToNext } = world.progression;
    const collected = world.stats.xpCollected;
    const result = applyCardTool(world, SKIP_COMMAND);

    expect(result).toEqual({ kind: "skip", left: 0, item: null });
    expect(world.progression.offers).toEqual([]);
    expect(world.progression.pendingLevelUps).toBe(0);
    expect(world.progression.xp).toBe(xp + Math.ceil(xpToNext * 0.3));
    expect(world.stats.xpCollected).toBe(collected);
    expect(world.progression.tools.skip).toBe(0);
  });

  it("у порога опыта оставляет ещё один накопленный уровень", () => {
    const world = choosing();
    const level = world.progression.level;
    world.progression.xp = world.progression.xpToNext - 1;
    applyCardTool(world, SKIP_COMMAND);
    expect(world.progression.level).toBe(level + 1);
    expect(world.progression.pendingLevelUps).toBe(1);
  });

  it("без заряда не применяется", () => {
    const world = choosing({ cardTools: { reroll: 1, skip: 0, banish: 0 } });
    expect(applyCardTool(world, SKIP_COMMAND)).toBeNull();
    expect(world.progression.offers).toHaveLength(3);
    expect(world.progression.pendingLevelUps).toBe(1);
  });

  it("пропуск уровня — в любом составе карточек, даже при лечении", () => {
    const world = choosing();
    world.progression.offers = [healOption()];
    expect(applyCardTool(world, SKIP_COMMAND)).not.toBeNull();
  });
});

describe("изгнание", () => {
  it("заменяет карточку на том же месте и записывает предмет", () => {
    const world = choosing();
    const before = world.progression.offers.map((offer) => offer);
    const target = before[1];
    const key = itemKeyOf(target);
    const result = applyCardTool(world, `${BANISH_PREFIX}${target.id}`);

    expect(result).toEqual({ kind: "banish", left: 0, item: key });
    expect(world.progression.banished).toEqual([key]);
    expect(world.progression.offers).toHaveLength(3);
    expect(world.progression.offers[0].id).toBe(before[0].id);
    expect(world.progression.offers[2].id).toBe(before[2].id);
    expect(world.progression.offers[1].id).not.toBe(target.id);
    expect(ids(world).filter((id) => before.map((offer) => offer.id).includes(id))).toHaveLength(2);
  });

  it("изгнанный предмет не предлагается ни на одном из тридцати уровней", () => {
    const world = choosing({ cardTools: { reroll: 0, skip: 0, banish: 1 } });
    const target = world.progression.offers[0];
    const key = itemKeyOf(target);
    applyCardTool(world, `${BANISH_PREFIX}${target.id}`);

    for (let level = 0; level < 30; level++) {
      for (const offer of world.progression.offers) expect(itemKeyOf(offer)).not.toBe(key);
      expect(chooseUpgrade(world, world.progression.offers[0].id)).toBe(true);
      addXp(world, world.progression.xpToNext);
      prepareOffers(world);
    }
  });

  it("можно изгнать и уже взятый предмет: его улучшений больше не будет", () => {
    const world = choosing();
    const owned = collectCandidates(world).find((candidate) => candidate.option.kind === "weapon_level")?.option;
    expect(owned).toBeDefined();
    if (owned === undefined) return;
    world.progression.offers[0] = owned;
    expect(applyCardTool(world, `${BANISH_PREFIX}${owned.id}`)).not.toBeNull();
    expect(collectCandidates(world).some((candidate) => itemKeyOf(candidate.option) === `weapon:${owned.refId}`)).toBe(false);
  });

  it("сундук размера 5 не выдаёт изгнанное — на пятидесяти seed", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const world = choosing({ seed }, seed);
      const target = world.progression.offers[0];
      const key = itemKeyOf(target);
      applyCardTool(world, `${BANISH_PREFIX}${target.id}`);
      openChest(world, 5);
      for (const reward of world.chests.openings[0].rewards) expect(itemKeyOf(reward)).not.toBe(key);
    }
  });

  it("лечение, чужой id и незнакомая команда не принимаются, заряд цел", () => {
    const world = choosing();
    const before = ids(world);
    expect(applyCardTool(world, `${BANISH_PREFIX}nothing:here:1`)).toBeNull();
    expect(applyCardTool(world, `${BANISH_PREFIX}`)).toBeNull();
    expect(applyCardTool(world, "~boom")).toBeNull();
    expect(applyCardTool(world, before[0])).toBeNull();
    world.progression.offers = [healOption()];
    expect(applyCardTool(world, `${BANISH_PREFIX}${HEAL_OPTION_ID}`)).toBeNull();
    expect(world.progression.tools.banish).toBe(1);
    expect(world.progression.banished).toEqual([]);
  });

  it("замены нет — карточка убирается; изгнан весь пул — предлагается лечение", () => {
    const world = smallPool(3, { cardTools: { reroll: 0, skip: 0, banish: 3 } });
    const [first, second, third] = [...world.progression.offers];

    applyCardTool(world, `${BANISH_PREFIX}${first.id}`);
    expect(ids(world)).toEqual([second.id, third.id]);
    applyCardTool(world, `${BANISH_PREFIX}${second.id}`);
    expect(ids(world)).toEqual([third.id]);
    applyCardTool(world, `${BANISH_PREFIX}${third.id}`);
    expect(ids(world)).toEqual([HEAL_OPTION_ID]);
    expect(world.progression.banished).toHaveLength(3);
  });

  it("повторно изгнанное не двоится в списке", () => {
    const world = choosing({ cardTools: { reroll: 0, skip: 0, banish: 3 } });
    const target = world.progression.offers[0];
    applyCardTool(world, `${BANISH_PREFIX}${target.id}`);
    world.progression.offers[0] = target;
    applyCardTool(world, `${BANISH_PREFIX}${target.id}`);
    expect(world.progression.banished).toHaveLength(1);
  });
});

describe("общие правила", () => {
  it("мир не ждёт выбора — команды не принимаются", () => {
    const world = choosing();
    chooseUpgrade(world, world.progression.offers[0].id);
    for (const command of [REROLL_COMMAND, SKIP_COMMAND, `${BANISH_PREFIX}x`]) {
      expect(applyCardTool(world, command)).toBeNull();
    }
    expect(world.progression.tools).toEqual(TOOLS);
  });

  it("одинаковый seed и команды дают одинаковые карточки", () => {
    const run = (): string[][] => {
      const world = choosing({}, 5);
      const seen: string[][] = [ids(world)];
      applyCardTool(world, REROLL_COMMAND);
      seen.push(ids(world));
      applyCardTool(world, `${BANISH_PREFIX}${world.progression.offers[0].id}`);
      seen.push(ids(world));
      applyCardTool(world, REROLL_COMMAND);
      seen.push(ids(world));
      return seen;
    };
    expect(run()).toEqual(run());
  });

  it("действия не сдвигают world.rng: следующий уровень выпадает так же, как без них", () => {
    const plain = choosing({ cardTools: undefined }, 9);
    const used = choosing({}, 9);
    applyCardTool(used, REROLL_COMMAND);
    applyCardTool(used, `${BANISH_PREFIX}${used.progression.offers[0].id}`);
    expect(used.rng.getState()).toBe(plain.rng.getState());
  });

  it("мир без зарядов и без изгнания выдаёт те же карточки, что и раньше", () => {
    const withTools = choosing({}, 4);
    const without = choosing({ cardTools: undefined }, 4);
    expect(ids(withTools)).toEqual(ids(without));
  });
});
