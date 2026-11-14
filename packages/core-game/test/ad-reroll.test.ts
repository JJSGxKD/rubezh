import type { BoostDef, EnemyDef, LoadoutLimits, WeaponDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { CHESTS } from "../src/content/chests";
import { DROPS } from "../src/content/drops";
import { ENEMIES } from "../src/content/enemies";
import { MAPS } from "../src/content/maps";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { ENDLESS_CURVE, TIMELINE } from "../src/content/waves";
import { WEAPONS } from "../src/content/weapons";
import { replayRecording } from "../src/game/diagnostics/replay";
import { CHECKPOINT_TICKS } from "../src/game/diagnostics/run-recorder";
import {
  AD_REROLL_COMMAND,
  applyCardTool,
  canAdReroll,
  canReroll,
  isCardToolCommand,
  MAX_AD_REROLLS,
  REROLL_COMMAND,
} from "../src/game/progression/card-tools";
import { addXp, chooseUpgrade, healOption, isAwaitingChoice, prepareOffers } from "../src/game/progression/levels";
import { EMPTY_LOADOUT } from "../src/game/progression/run-loadout";
import { buildRunResult } from "../src/game/run/run-result";
import { captureWorld, restoreWorld, SnapshotError, WORLD_SNAPSHOT_VERSION } from "../src/game/run/snapshot";
import { createTimelineDirector } from "../src/game/sim/director";
import type { Spawner } from "../src/game/sim/spawner";
import { stepWorld } from "../src/game/sim/step";
import { createWorld, TICK_SEC, type CreateWorldOptions, type World } from "../src/game/sim/world";
import { circling, recordHeadlessRun } from "./helpers/recorded-run";

// Переброс карточек за рекламу (tasks/T-0199, Р133): тот же механизм, что у
// обычного переброса (T-0101), но платит не заряд, а право «раз за забег».
// Новой случайности нет: карточки идут из `world.cardRng`, `world.rng` не тронут,
// забег без рекламного переброса не меняется ни на бит.

const GRUNT: EnemyDef = { id: "grunt", hp: 10, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };
const INSIGHT: BoostDef = { id: "insight", nameKey: "n", descriptionKey: "d", extraOffers: 1 };

/** Мир, который уже ждёт выбора; зарядов переброса нет — как у игрока, у которого они кончились или не было вовсе. */
function choosing(patch: Partial<CreateWorldOptions> = {}, seed = 1): World {
  const world = createWorld({
    seed,
    enemies: [GRUNT],
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    chests: { ...CHESTS, maxOnField: 8 },
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

describe("команда и правило", () => {
  it("условная команда — ~adreroll, узнаётся по префиксу; право одно на забег", () => {
    expect(AD_REROLL_COMMAND).toBe("~adreroll");
    expect(isCardToolCommand(AD_REROLL_COMMAND)).toBe(true);
    expect(MAX_AD_REROLLS).toBe(1);
  });

  it("новый мир: право не потрачено, переброс за рекламу при нуле зарядов возможен", () => {
    const world = choosing();
    expect(world.progression.adRerolls).toBe(0);
    expect(world.progression.tools.reroll).toBe(0);
    expect(canAdReroll(world)).toBe(true);
    // Обычный переброс без заряда невозможен, и это не одно и то же.
    expect(canReroll(world)).toBe(false);
  });
});

describe("переброс за рекламу", () => {
  it("без зарядов заменяет все карточки, число то же, world.rng цел, право потрачено", () => {
    const world = choosing();
    const before = ids(world);
    const rngBefore = world.rng.getState();
    const result = applyCardTool(world, AD_REROLL_COMMAND);

    expect(result).toEqual({ kind: "reroll", left: 0, item: null, viaAd: true });
    expect(ids(world)).toHaveLength(before.length);
    expect(ids(world).filter((id) => before.includes(id))).toEqual([]);
    expect(new Set(ids(world)).size).toBe(ids(world).length);
    expect(world.progression.adRerolls).toBe(1);
    expect(world.progression.tools.reroll).toBe(0);
    expect(world.progression.toolsTotal.reroll).toBe(0);
    expect(world.rng.getState()).toBe(rngBefore);
  });

  it("с лишней карточкой буста показывает на одну больше и после переброса", () => {
    const world = choosing({ boosts: [INSIGHT], maxBoostsPerRun: 3, loadout: { ...EMPTY_LOADOUT, boosts: ["insight"] } });
    expect(world.progression.offers).toHaveLength(4);
    expect(applyCardTool(world, AD_REROLL_COMMAND)).not.toBeNull();
    expect(world.progression.offers).toHaveLength(4);
  });

  it("второй раз в том же забеге — null: карточки целы, право не растёт", () => {
    const world = choosing();
    expect(applyCardTool(world, AD_REROLL_COMMAND)).not.toBeNull();
    const after = ids(world);
    expect(canAdReroll(world)).toBe(false);
    expect(applyCardTool(world, AD_REROLL_COMMAND)).toBeNull();
    expect(ids(world)).toEqual(after);
    expect(world.progression.adRerolls).toBe(1);
  });

  it("право одно на забег, а не на уровень: на следующем выборе его уже нет", () => {
    const world = choosing();
    applyCardTool(world, AD_REROLL_COMMAND);
    expect(chooseUpgrade(world, world.progression.offers[0].id)).toBe(true);
    addXp(world, world.progression.xpToNext);
    prepareOffers(world);
    expect(isAwaitingChoice(world)).toBe(true);
    expect(canAdReroll(world)).toBe(false);
    expect(applyCardTool(world, AD_REROLL_COMMAND)).toBeNull();
  });

  it("пока заряд обычного переброса есть, рекламный не применяется: заряд цел", () => {
    const world = choosing({ cardTools: { reroll: 1, skip: 0, banish: 0 } });
    const before = ids(world);
    expect(canAdReroll(world)).toBe(false);
    expect(applyCardTool(world, AD_REROLL_COMMAND)).toBeNull();
    expect(ids(world)).toEqual(before);
    expect(world.progression.tools.reroll).toBe(1);
    expect(world.progression.adRerolls).toBe(0);
  });

  it("рекламный переброс не отнимает у обычного: заряд, появившийся позже, работает как прежде", () => {
    const world = choosing();
    applyCardTool(world, AD_REROLL_COMMAND);
    world.progression.tools.reroll = 1;
    expect(applyCardTool(world, REROLL_COMMAND)).toEqual({ kind: "reroll", left: 0, item: null });
    expect(world.progression.adRerolls).toBe(1);
  });

  it("на карточке одного лечения, без кандидатов вне показанных и вне выбора — null", () => {
    const healing = choosing();
    healing.progression.offers = [healOption()];
    expect(canAdReroll(healing)).toBe(false);
    expect(applyCardTool(healing, AD_REROLL_COMMAND)).toBeNull();
    expect(healing.progression.adRerolls).toBe(0);

    // Ровно три кандидата и три карточки: нового показать нечего.
    const exhausted = smallPool(3);
    const shown = ids(exhausted);
    expect(canAdReroll(exhausted)).toBe(false);
    expect(applyCardTool(exhausted, AD_REROLL_COMMAND)).toBeNull();
    expect(ids(exhausted)).toEqual(shown);
    expect(exhausted.progression.adRerolls).toBe(0);

    const idle = choosing();
    chooseUpgrade(idle, idle.progression.offers[0].id);
    expect(canAdReroll(idle)).toBe(false);
    expect(applyCardTool(idle, AD_REROLL_COMMAND)).toBeNull();
    expect(idle.progression.adRerolls).toBe(0);
  });

  it("не хватает новых — добор из прежних, как у обычного переброса", () => {
    const world = smallPool(5, { boosts: [INSIGHT], maxBoostsPerRun: 3, loadout: { ...EMPTY_LOADOUT, boosts: ["insight"] } });
    expect(world.progression.offers).toHaveLength(4);
    expect(applyCardTool(world, AD_REROLL_COMMAND)).not.toBeNull();
    expect(world.progression.offers).toHaveLength(4);
    expect(new Set(ids(world)).size).toBe(4);
  });

  it("обычный и рекламный переброс из одного состояния дают те же новые карточки: поток случайности один", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const paid = choosing({ cardTools: { reroll: 1, skip: 0, banish: 0 } }, seed);
      const viaAd = choosing({}, seed);
      expect(ids(viaAd)).toEqual(ids(paid));

      applyCardTool(paid, REROLL_COMMAND);
      applyCardTool(viaAd, AD_REROLL_COMMAND);
      expect(ids(viaAd), `seed ${seed}`).toEqual(ids(paid));
      expect(viaAd.cardRng.getState()).toBe(paid.cardRng.getState());
      expect(viaAd.rng.getState()).toBe(paid.rng.getState());
    }
  });

  it("не сдвигает world.rng: следующий уровень выпадает так же, как без переброса", () => {
    const plain = choosing({}, 9);
    const used = choosing({}, 9);
    applyCardTool(used, AD_REROLL_COMMAND);
    expect(used.rng.getState()).toBe(plain.rng.getState());
  });

  it("одинаковый seed и команда дают одинаковые карточки", () => {
    const run = (): string[] => {
      const world = choosing({}, 5);
      applyCardTool(world, AD_REROLL_COMMAND);
      return ids(world);
    };
    expect(run()).toEqual(run());
  });

  it("пропуск и изгнание за рекламу не продаются: команд с такими приставками рекламой не заменить", () => {
    const world = choosing();
    const before = ids(world);
    expect(applyCardTool(world, "~adskip")).toBeNull();
    expect(applyCardTool(world, `~adbanish:${before[0]}`)).toBeNull();
    expect(ids(world)).toEqual(before);
    expect(world.progression.adRerolls).toBe(0);
  });
});

describe("снимок прерванного забега", () => {
  interface Run {
    world: World;
    director: Spawner;
  }

  function newRun(seed: number): Run {
    return {
      world: createWorld({
        seed,
        enemies: ENEMIES,
        weapons: WEAPONS,
        passives: PASSIVES,
        levelCurve: LEVEL_CURVE,
        loadoutLimits: LOADOUT_LIMITS,
        drops: DROPS,
        chests: CHESTS,
        map: MAPS[0],
      }),
      director: createTimelineDirector(TIMELINE, ENDLESS_CURVE),
    };
  }

  function atChoice(seed: number): Run {
    const run = newRun(seed);
    while (!isAwaitingChoice(run.world)) {
      run.director.update(run.world, TICK_SEC);
      stepWorld(run.world, { moveX: 1, moveY: 0 });
    }
    return run;
  }

  const roundTrip = (run: Run): Record<string, unknown> => JSON.parse(JSON.stringify(captureWorld(run.world, run.director))) as Record<string, unknown>;

  it("несёт потраченное право и поток карточек: повторный рекламный переброс невозможен, дальше всё так же", () => {
    const original = atChoice(77);
    expect(applyCardTool(original.world, AD_REROLL_COMMAND)).not.toBeNull();
    const saved = roundTrip(original);

    const resumed = newRun(77);
    restoreWorld(resumed.world, resumed.director, saved);
    expect(resumed.world.progression.adRerolls).toBe(1);
    expect(resumed.world.cardRng.getState()).toBe(original.world.cardRng.getState());
    expect(resumed.world.progression.offers).toEqual(original.world.progression.offers);
    expect(canAdReroll(resumed.world)).toBe(false);
    expect(applyCardTool(resumed.world, AD_REROLL_COMMAND)).toBeNull();

    // Следующие карточки совпадают с прогоном без перерыва.
    for (const run of [original, resumed]) {
      run.world.progression.tools.reroll = 1;
      applyCardTool(run.world, REROLL_COMMAND);
    }
    expect(ids(resumed.world)).toEqual(ids(original.world));
    expect(resumed.world.cardRng.getState()).toBe(original.world.cardRng.getState());
  });

  it("право, которое не тратили, возвращается нетронутым", () => {
    const original = atChoice(78);
    const resumed = newRun(78);
    restoreWorld(resumed.world, resumed.director, roundTrip(original));
    expect(resumed.world.progression.adRerolls).toBe(0);
    expect(canAdReroll(resumed.world)).toBe(true);
  });

  it("версия формата выросла, а снимок прежней версии не читается", () => {
    expect(WORLD_SNAPSHOT_VERSION).toBeGreaterThanOrEqual(19);
    const saved = roundTrip(newRun(1));
    expect(saved.version).toBe(WORLD_SNAPSHOT_VERSION);
    expect(() => restoreWorld(newRun(1).world, newRun(1).director, { ...saved, version: 18 })).toThrow(SnapshotError);
  });

  it("битое число рекламных переборов — SnapshotError, а не мир с бесконечными перебросами", () => {
    const saved = roundTrip(newRun(1)) as { progression: Record<string, unknown> };
    for (const adRerolls of [-1, 2, 0.5, "1", null, undefined, Number.NaN]) {
      const input = { ...saved, progression: { ...saved.progression, adRerolls } };
      expect(() => restoreWorld(newRun(1).world, newRun(1).director, input), String(adRerolls)).toThrow(SnapshotError);
    }
    const without = { ...saved.progression };
    delete without.adRerolls;
    expect(() => restoreWorld(newRun(1).world, newRun(1).director, { ...saved, progression: without })).toThrow(SnapshotError);
  });
});

describe("запись и итог забега", () => {
  const plan = (): ((offers: readonly { id: string }[]) => string) => {
    const commands = [() => AD_REROLL_COMMAND];
    return (offers) => commands.shift()?.() ?? offers[0].id;
  };

  function recorded() {
    return recordHeadlessRun({ seed: 21, maxTicks: CHECKPOINT_TICKS + 30, steer: circling(150), choose: plan() });
  }

  it("~adreroll попадает в лог условным id, а повтор забега «сошёлся»", () => {
    const recording = recorded();
    const commands = recording.choices.map(([, id]) => id).filter((id) => id.startsWith("~"));
    expect(commands).toEqual([AD_REROLL_COMMAND]);

    const outcome = replayRecording(recording);
    expect(outcome.reason).toBeNull();
    expect(outcome.verdict).toBe("match");
    expect(outcome.actual).toEqual(recording.result);
  });

  it("вторая команда в том же забеге не ложится на забег", () => {
    const recording = recorded();
    const index = recording.choices.findIndex(([, id]) => id === AD_REROLL_COMMAND);
    const [tick] = recording.choices[index];
    const doubled = { ...recording, choices: [...recording.choices.slice(0, index + 1), [tick, AD_REROLL_COMMAND] as [number, string], ...recording.choices.slice(index + 1)] };

    const outcome = replayRecording(doubled);
    expect(outcome.verdict).toBe("mismatch");
    expect(outcome.reason).toContain(AD_REROLL_COMMAND);
    expect(outcome.reason).toContain("не ложится на забег");
  });

  it("команда при ненулевых зарядах не ложится на забег: заряды берутся из набора записи", () => {
    const recording = recorded();
    const withCharges = { ...recording, loadout: { modifiers: {}, boosts: ["control"] } };
    const outcome = replayRecording(withCharges);
    expect(outcome.verdict).toBe("mismatch");
    expect(outcome.reason).toContain(AD_REROLL_COMMAND);
    expect(outcome.reason).toContain("не ложится на забег");
  });

  it("итог несёт adRerolls: 1, а без рекламного переброса поля нет", () => {
    const options = { runId: "run-x", seed: 1, outcome: "abandoned" as const, startingWeaponId: "spark", contentHash: "abc" };
    const world = choosing();
    expect("adRerolls" in buildRunResult(world, options)).toBe(false);
    applyCardTool(world, AD_REROLL_COMMAND);
    expect(buildRunResult(world, options).adRerolls).toBe(1);
  });
});
