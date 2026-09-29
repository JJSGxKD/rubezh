import { describe, expect, it } from "vitest";
import { ACCOUNT_UNLOCKS } from "../src/content/unlocks";
import { LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
import { replayRecording } from "../src/game/diagnostics/replay";
import { chooseUpgrade, prepareOffers } from "../src/game/progression/levels";
import { isEmptyLoadout, sanitizeLoadout } from "../src/game/progression/run-loadout";
import { unlocksAt } from "../src/game/progression/unlocks";
import { createRunWorld } from "../src/game/run-world";
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
    const opened = world(6, "sting");
    expect(opened.weaponTypes[opened.loadout.weapons[0].typeIndex].id).toBe("sting");
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
