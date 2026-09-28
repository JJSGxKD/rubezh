import type { EnemyDef, RunLoadout } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { BOOSTS, MAX_BOOSTS_PER_RUN } from "../src/content/boosts";
import { PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
import { replayRecording } from "../src/game/diagnostics/replay";
import { findBoostProblems, resolveBoosts } from "../src/game/progression/boosts";
import { OFFERS_PER_LEVEL, prepareOffers } from "../src/game/progression/levels";
import { LOADOUT_BOUNDS } from "../src/game/progression/run-loadout";
import { buildRunResult } from "../src/game/run/run-result";
import { captureWorld, restoreWorld } from "../src/game/run/snapshot";
import { createRunWorld } from "../src/game/run-world";
import { SIM_EVENT } from "../src/game/sim/events";
import { createWorld, damagePlayer, DEFAULT_SIM_CONFIG, SHIELD_GRACE_TICKS, type World } from "../src/game/sim/world";
import { circling, recordHeadlessRun } from "./helpers/recorded-run";

/**
 * Бусты в движке (docs/35-stage4-plan.md §3.5, Р39): список из набора — в
 * эффекты, которые меняют забег, и те же эффекты в повторе по записи. Какие
 * бусты оплачены, решает сервер; движок только не даёт битому списку усилить
 * забег сильнее контента.
 */

const DUMMY: EnemyDef = { id: "dummy", hp: 10_000, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };

function world(boosts: string[], modifiers: RunLoadout["modifiers"] = {}): World {
  return createWorld({
    seed: 7,
    enemies: [DUMMY],
    weapons: WEAPONS,
    passives: PASSIVES,
    boosts: BOOSTS,
    maxBoostsPerRun: MAX_BOOSTS_PER_RUN,
    config: { player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 100 } },
    loadout: { modifiers, boosts },
  });
}

describe("бусты: контент", () => {
  it("каждый буст что-то делает, id не повторяются, прибавки — в пределах движка", () => {
    expect(findBoostProblems(BOOSTS)).toEqual([]);
  });

  it("проверка называет буст и поле", () => {
    expect(findBoostProblems([{ id: "x", nameKey: "", descriptionKey: "" }])).toEqual(["x: буст ничего не делает"]);
    expect(findBoostProblems([{ id: "y", nameKey: "", descriptionKey: "", modifiers: { damage: 99 } }])[0]).toContain("y.damage");
    expect(findBoostProblems([{ id: "z", nameKey: "", descriptionKey: "", startLevels: 0.5 }])[0]).toContain("z.startLevels");
  });
});

describe("бусты: разбор списка", () => {
  it("незнакомое и повтор отбрасываются, лишнее сверх потолка — тоже", () => {
    const resolved = resolveBoosts(BOOSTS, ["fury", "nope", "fury", "aegis", "insight", "bulwark"], 3);
    expect(resolved.ids).toEqual(["fury", "aegis", "insight"]);
    expect(resolved).toMatchObject({ shieldHits: 1, extraOffers: 1, startLevels: 0, modifiers: { damage: 0.15 } });
  });

  it("без контента бустов id в наборе ничего не делают", () => {
    const plain = createWorld({ seed: 1, enemies: [DUMMY], loadout: { modifiers: {}, boosts: ["aegis"] } });
    expect(plain.player.shieldHits).toBe(0);
    expect(plain.boosts.ids).toEqual([]);
  });
});

describe("бусты в бою", () => {
  it("прибавки ложатся поверх снаряжения и упираются в пределы движка", () => {
    expect(world(["fury"]).playerStats.damageMul).toBeCloseTo(1.15, 9);
    expect(world(["fury"], { damage: 0.2 }).playerStats.damageMul).toBeCloseTo(1.35, 9);
    expect(world(["fury"], { damage: LOADOUT_BOUNDS.damage }).playerStats.damageMul).toBeCloseTo(1 + LOADOUT_BOUNDS.damage, 9);
    // «Крепость» — игрок начинает полным, с её здоровьем.
    expect(world(["bulwark"]).player).toMatchObject({ hp: 130, maxHp: 130 });
  });

  it("щит гасит первое попадание целиком, даёт полсекунды неуязвимости, дальше урон проходит", () => {
    const shielded = world(["aegis"]);
    damagePlayer(shielded, 40, 0);
    expect(shielded.player.hp).toBe(100);
    expect(shielded.player.shieldHits).toBe(0);
    expect(shielded.player.invulnerableTicks).toBe(SHIELD_GRACE_TICKS);
    expect(shielded.events.kind[0]).toBe(SIM_EVENT.shield);

    shielded.player.invulnerableTicks = 0;
    damagePlayer(shielded, 40, 0);
    expect(shielded.player.hp).toBeLessThan(100);
  });

  it("«Фора» начинает забег с третьего уровня и двумя выборами в очереди", () => {
    const headStart = world(["head_start"]);
    expect(headStart.progression).toMatchObject({ level: 3, pendingLevelUps: 2 });
    expect(prepareOffers(headStart).length).toBeGreaterThan(0);
  });

  it("«Чутьё» — на карточку больше на каждом выборе", () => {
    const plain = world(["head_start"]);
    const insightful = world(["head_start", "insight"]);
    expect(prepareOffers(plain)).toHaveLength(OFFERS_PER_LEVEL);
    expect(prepareOffers(insightful)).toHaveLength(OFFERS_PER_LEVEL + 1);
  });
});

describe("бусты в итоге забега", () => {
  it("итог перечисляет применённые бусты — сервер сверит их с покупкой; без бустов поля нет", () => {
    const options = { runId: "run-x", seed: 1, outcome: "abandoned" as const, startingWeaponId: "spark", contentHash: "abc" };
    expect(buildRunResult(world(["fury", "nope", "aegis"]), options).boosts).toEqual(["fury", "aegis"]);
    expect("boosts" in buildRunResult(world([]), options)).toBe(false);
  });
});

describe("бусты в записи и снимке", () => {
  const loadout: RunLoadout = { modifiers: { damage: 0.1 }, boosts: ["aegis", "head_start", "insight"] };

  it("повтор забега с бустами совпадает, а без них — расходится", () => {
    const recording = recordHeadlessRun({ seed: 4242, maxTicks: 3_000, steer: circling(150), loadout });
    expect(recording.loadout).toEqual(loadout);
    expect(replayRecording(recording).verdict).toBe("match");

    const stripped = { ...recording, loadout: { ...loadout, boosts: [] } };
    expect(replayRecording(stripped).verdict).toBe("mismatch");
  });

  it("снимок переносит неистраченный щит, а бусты — из набора продолженного забега", () => {
    const original = createRunWorld({ seed: 9, mapId: "", difficultyId: "normal", unitScale: 2, loadout });
    const saved: unknown = JSON.parse(JSON.stringify(captureWorld(original.world, original.spawner)));
    const resumed = createRunWorld({ seed: 9, mapId: "", difficultyId: "normal", unitScale: 2, loadout });
    resumed.world.player.shieldHits = 0;
    restoreWorld(resumed.world, resumed.spawner, saved);

    expect(resumed.world.player.shieldHits).toBe(1);
    expect(resumed.world.boosts.extraOffers).toBe(1);
    expect(resumed.world.progression.level).toBe(original.world.progression.level);
  });
});
