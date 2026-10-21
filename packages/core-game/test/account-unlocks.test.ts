import { describe, expect, it } from "vitest";
import { ACCOUNT_UNLOCKS, CARD_TOOL_RULES, CARD_TOOL_UNLOCKS } from "../src/content/unlocks";
import { LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { BOOSTS } from "../src/content/boosts";
import { WEAPONS } from "../src/content/weapons";
import { replayRecording } from "../src/game/diagnostics/replay";
import { chooseUpgrade, prepareOffers } from "../src/game/progression/levels";
import { isEmptyLoadout, sanitizeLoadout } from "../src/game/progression/run-loadout";
import { MAX_CARD_TOOLS } from "../src/game/progression/card-tools";
import { cardToolsAt, findCardToolProblems, unlockLevelOf, unlocksAt } from "../src/game/progression/unlocks";
import { createRunWorld } from "../src/game/run-world";
import { createWorld } from "../src/game/sim/world";
import { circling, recordHeadlessRun } from "./helpers/recorded-run";

// Уровень аккаунта открывает оружие, навыки и слоты (docs/35-stage4-plan.md
// Р41, §3.13, WP25). Закрытое в мир забега не попадает вовсе: ни стартовым,
// ни в предложениях; слоты — по уровню. Без уровня открыто всё — так идут
// запись и снимок прошлой сборки, стенд и golden-тесты.

const world = (accountLevel?: number, startingWeaponId?: string) =>
  createRunWorld({
    seed: 7,
    mapId: "",
    difficultyId: "easy",
    unitScale: 1,
    ...(startingWeaponId === undefined ? {} : { startingWeaponId }),
    ...(accountLevel === undefined ? {} : { loadout: { modifiers: {}, boosts: [], accountLevel } }),
  }).world;

const ids = (types: readonly { id: string }[]) => types.map((type) => type.id).sort();

describe("мир забега по уровню аккаунта", () => {
  it("без уровня открыто всё и слоты — потолок контента", () => {
    const open = world();
    expect(ids(open.weaponTypes)).toEqual(ids(WEAPONS));
    expect(ids(open.passiveTypes)).toEqual(ids(PASSIVES));
    expect(open.loadoutLimits).toEqual(LOADOUT_LIMITS);
  });

  it("первый уровень — стартовый набор и урезанные слоты", () => {
    const first = unlocksAt(ACCOUNT_UNLOCKS, 1);
    const novice = world(1);
    expect(ids(novice.weaponTypes)).toEqual([...first.weapons].sort());
    expect(ids(novice.passiveTypes)).toEqual([...first.passives].sort());
    expect(novice.loadoutLimits).toEqual(first.limits);
  });

  it("стартовым берётся любое открытое, а закрытое — нет: забег начнётся с первого открытого", () => {
    expect(world(1, "wardstone").weaponTypes[world(1, "wardstone").loadout.weapons[0].typeIndex].id).toBe("wardstone");
    const locked = world(1, "sting");
    expect(locked.weaponTypes[locked.loadout.weapons[0].typeIndex].id).toBe(WEAPONS.find((weapon) => unlocksAt(ACCOUNT_UNLOCKS, 1).weapons.has(weapon.id))?.id);
    const stingLevel = unlockLevelOf(ACCOUNT_UNLOCKS, "weapon", "sting") ?? 0;
    const opened = world(stingLevel, "sting");
    expect(opened.weaponTypes[opened.loadout.weapons[0].typeIndex].id).toBe("sting");
    const before = world(stingLevel - 1, "sting");
    const firstOpen = WEAPONS.find((weapon) => unlocksAt(ACCOUNT_UNLOCKS, stingLevel - 1).weapons.has(weapon.id))?.id;
    expect(before.weaponTypes[before.loadout.weapons[0].typeIndex].id).toBe(firstOpen);
  });

  it("предлагает только открытое и не больше слотов уровня", () => {
    const novice = world(1);
    const first = unlocksAt(ACCOUNT_UNLOCKS, 1);
    for (let round = 0; round < 40; round++) {
      novice.progression.pendingLevelUps = 1;
      const offers = prepareOffers(novice);
      for (const offer of offers) {
        if (offer.kind === "weapon_new" || offer.kind === "weapon_level") expect(first.weapons.has(offer.refId), offer.refId).toBe(true);
        if (offer.kind === "passive_new" || offer.kind === "passive_level") expect(first.passives.has(offer.refId), offer.refId).toBe(true);
      }
      const pick = offers[round % offers.length];
      if (pick !== undefined) chooseUpgrade(novice, pick.id);
    }
    expect(novice.loadout.weapons.length).toBeLessThanOrEqual(first.limits.weapons);
    for (const category of ["attack", "defense", "mobility"] as const) {
      const inCategory = novice.loadout.passives.filter((slot) => novice.passiveTypes[slot.typeIndex].category === category).length;
      expect(inCategory, category).toBeLessThanOrEqual(first.limits.passives[category]);
    }
  });
});

describe("уровень в наборе, записи и повторе", () => {
  it("целый уровень проходит как есть, битый — первый уровень, а не «открыто всё»", () => {
    expect(sanitizeLoadout({ modifiers: {}, boosts: [], accountLevel: 4 }).accountLevel).toBe(4);
    expect(sanitizeLoadout({ modifiers: {}, boosts: [], accountLevel: 2.5 }).accountLevel).toBe(1);
    expect(sanitizeLoadout({ modifiers: {}, boosts: [], accountLevel: "9" }).accountLevel).toBe(1);
    expect(sanitizeLoadout({ modifiers: {}, boosts: [], accountLevel: -3 }).accountLevel).toBe(1);
    expect(sanitizeLoadout({ modifiers: {}, boosts: [] })).not.toHaveProperty("accountLevel");
  });

  it("набор с одним уровнем — не пустой: иначе запись и снимок его потеряли бы", () => {
    expect(isEmptyLoadout({ modifiers: {}, boosts: [], accountLevel: 1 })).toBe(false);
    expect(isEmptyLoadout({ modifiers: {}, boosts: [] })).toBe(true);
  });

  it("запись несёт уровень, и повтор идёт с ним; без уровня тот же ввод расходится", { timeout: 30_000 }, () => {
    const recording = recordHeadlessRun({ seed: 11, maxTicks: 60 * 90, steer: circling(240), loadout: { modifiers: {}, boosts: [], accountLevel: 1 } });
    expect(recording.loadout?.accountLevel).toBe(1);
    expect(recording.choices.length).toBeGreaterThan(0);
    expect(replayRecording(recording).verdict).toBe("match");

    const { accountLevel, ...withoutLevel } = recording.loadout ?? { modifiers: {}, boosts: [] };
    expect(accountLevel).toBe(1);
    expect(replayRecording({ ...recording, loadout: withoutLevel }).verdict).not.toBe("match");
  });
});

describe("заряды карточек по уровню аккаунта (tasks/T-0101)", () => {
  const at = (level: number) => cardToolsAt(CARD_TOOL_UNLOCKS, level);

  it("лестница из задачи: итог с уровня, как у слотов", () => {
    expect(at(1)).toEqual({ reroll: 0, skip: 0, banish: 0 });
    expect(at(2)).toEqual({ reroll: 0, skip: 0, banish: 0 });
    expect(at(3)).toEqual({ reroll: 1, skip: 0, banish: 0 });
    expect(at(5)).toEqual({ reroll: 1, skip: 0, banish: 0 });
    expect(at(6)).toEqual({ reroll: 1, skip: 1, banish: 0 });
    expect(at(9)).toEqual({ reroll: 2, skip: 1, banish: 1 });
    expect(at(14)).toEqual({ reroll: 2, skip: 2, banish: 1 });
    expect(at(20)).toEqual({ reroll: 3, skip: 2, banish: 2 });
    expect(at(99)).toEqual(at(20));
  });

  it("не заданное строкой — как строкой ниже, порядок строк не важен", () => {
    const table = [{ level: 5, reroll: 2 }, { level: 2, reroll: 1, skip: 1 }];
    expect(cardToolsAt(table, 1)).toEqual({ reroll: 0, skip: 0, banish: 0 });
    expect(cardToolsAt(table, 3)).toEqual({ reroll: 1, skip: 1, banish: 0 });
    expect(cardToolsAt(table, 5)).toEqual({ reroll: 2, skip: 1, banish: 0 });
  });

  it("контент проходит проверку, награда пропуска — доля от 0 до 1", () => {
    expect(findCardToolProblems(CARD_TOOL_UNLOCKS)).toEqual([]);
    expect(CARD_TOOL_RULES.skipXpRatio).toBe(0.3);
    expect(CARD_TOOL_RULES.skipXpRatio).toBeGreaterThan(0);
    expect(CARD_TOOL_RULES.skipXpRatio).toBeLessThanOrEqual(1);
  });

  it("проверка называет строку: дубль уровня, отрицательное, дробное, убывающее, выше потолка", () => {
    const problems = findCardToolProblems([
      { level: 1, reroll: 2 },
      { level: 1, skip: -1 },
      { level: 2, reroll: 1.5 },
      { level: 3, reroll: 1 },
      { level: 0, banish: MAX_CARD_TOOLS + 1 },
    ]).join("\n");
    expect(problems).toMatch(/уровень 1 встречается дважды/);
    expect(problems).toMatch(/skip.*-1/);
    expect(problems).toMatch(/reroll.*1[.,]5/);
    expect(problems).toMatch(/уровень 3: .*reroll.*меньше, чем уровнем ниже/);
    expect(problems).toMatch(/уровень 0/);
    expect(problems).toMatch(new RegExp(`banish.*${String(MAX_CARD_TOOLS)}`));
  });
});

describe("заряды в мире забега", () => {
  const tools = (accountLevel?: number, boosts: string[] = []) =>
    createRunWorld({
      seed: 7,
      mapId: "",
      difficultyId: "easy",
      unitScale: 1,
      ...(accountLevel === undefined && boosts.length === 0 ? {} : { loadout: { modifiers: {}, boosts, ...(accountLevel === undefined ? {} : { accountLevel }) } }),
    }).world.progression.tools;

  it("без уровня — нули: на этом наборе идут golden-тесты", () => {
    expect(tools()).toEqual({ reroll: 0, skip: 0, banish: 0 });
    expect(tools(undefined, ["control"])).toEqual({ reroll: 1, skip: 1, banish: 1 });
  });

  it("уровень 1 без буста — нули, а с бустом «Контроль» — 1/1/1", () => {
    expect(tools(1)).toEqual({ reroll: 0, skip: 0, banish: 0 });
    expect(tools(1, ["control"])).toEqual({ reroll: 1, skip: 1, banish: 1 });
  });

  it("уровень 9 с бустом — 3/2/2, уровень 20 — 4/3/3; выданное запоминается", () => {
    expect(tools(9, ["control"])).toEqual({ reroll: 3, skip: 2, banish: 2 });
    const rich = createRunWorld({ seed: 7, mapId: "", difficultyId: "easy", unitScale: 1, loadout: { modifiers: {}, boosts: ["control"], accountLevel: 20 } }).world;
    expect(rich.progression.tools).toEqual({ reroll: 4, skip: 3, banish: 3 });
    expect(rich.progression.toolsTotal).toEqual({ reroll: 4, skip: 3, banish: 3 });
  });

  it("сумма каждого вида держится под потолком", () => {
    const world = createWorld({
      seed: 1,
      enemies: [{ id: "g", hp: 1, speed: 1, damage: 0, xp: 1, pattern: "swarm" }],
      weapons: WEAPONS,
      passives: PASSIVES,
      boosts: BOOSTS,
      maxBoostsPerRun: 3,
      cardTools: { reroll: 20, skip: 8, banish: 0 },
      loadout: { modifiers: {}, boosts: ["control"] },
    });
    expect(world.progression.tools).toEqual({ reroll: MAX_CARD_TOOLS, skip: MAX_CARD_TOOLS, banish: 1 });
  });
});
