import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EnemyDef, SecretsDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { CHESTS } from "../src/content/chests";
import { SECRETS } from "../src/content/secrets";
import { CONTENT_SNAPSHOT } from "../src/content/snapshot";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { ENEMIES } from "../src/content/enemies";
import { ENDLESS_CURVE, TIMELINE } from "../src/content/waves";
import { WEAPONS } from "../src/content/weapons";
import { MAPS } from "../src/content/maps";
import { replayRecording } from "../src/game/diagnostics/replay";
import { isCardToolCommand } from "../src/game/progression/card-tools";
import { buildRunResult } from "../src/game/run/run-result";
import { captureWorld, restoreWorld, SnapshotError, WORLD_SNAPSHOT_VERSION } from "../src/game/run/snapshot";
import { AD_CHEST_COMMAND, applyAdChest, canAdChest, MAX_AD_CHESTS, openChest } from "../src/game/sim/chests";
import { checksumWorld } from "../src/game/sim/checksum";
import { createTimelineDirector } from "../src/game/sim/director";
import type { Spawner } from "../src/game/sim/spawner";
import { IDLE_INPUT, stepWorld } from "../src/game/sim/step";
import { createWorld, type CreateWorldOptions, type SecretSite, type World } from "../src/game/sim/world";
import { recordHeadlessRun } from "./helpers/recorded-run";

// Второй сундук клада за ролик (docs/35-stage4-plan.md Р162, tasks/T-0328): движок. Право одно на
// забег, сундук того же размера, что у клада, содержимое — из потока сундуков, `world.rng` не
// тронут, команда `~adchest` лежит в логе выбора, и повтор забега её исполняет. Забег без команды
// не меняется ни на бит. Был ли ролик, движок не знает: за это отвечают оболочка и сервер.

const GRUNT: EnemyDef = { id: "grunt", hp: 10, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };
const TICKS_PER_SEC = 60;

const ONLY_HOARD: SecretsDef = {
  ...SECRETS,
  rings: [{ minRadius: 700, maxRadius: 1_100, count: 1, kinds: [{ kind: "hoard", weight: 1 }] }],
};

function setup(seed = 1, patch: Partial<CreateWorldOptions> = {}): World {
  return createWorld({
    seed,
    enemies: [GRUNT],
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    chests: CHESTS,
    secrets: ONLY_HOARD,
    ...patch,
  });
}

function standOn(world: World, site: SecretSite): void {
  const player = world.player;
  player.x = site.x;
  player.y = site.y;
  player.prevX = site.x;
  player.prevY = site.y;
  player.vx = 0;
  player.vy = 0;
}

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepWorld(world, IDLE_INPUT);
}

/** Мир, в котором клад только что выкопан: окно сундука открыто. */
function digged(seed = 1): World {
  const world = setup(seed);
  standOn(world, world.secrets.sites[0]);
  run(world, 2 * TICKS_PER_SEC);
  return world;
}

describe("команда и правило", () => {
  it("условная команда — ~adchest, право одно на забег", () => {
    expect(AD_CHEST_COMMAND).toBe("~adchest");
    expect(MAX_AD_CHESTS).toBe(1);
    // Повтор забега обязан разбирать её до общего правила «~ — действие с карточками».
    expect(isCardToolCommand(AD_CHEST_COMMAND)).toBe(true);
  });

  it("новый мир: окна нет, второй сундук недоступен, команда не ложится", () => {
    const world = setup();
    expect(world.progression.adChests).toBe(0);
    expect(canAdChest(world)).toBe(false);
    expect(applyAdChest(world)).toBe(false);
    expect(world.chests.openings).toHaveLength(0);
    expect(world.progression.adChests).toBe(0);
  });
});

describe("сундук клада и чужой сундук", () => {
  it("клад открывает окно: canAdChest истинно, у сундука метка «клад»", () => {
    const world = digged();
    expect(world.chests.openings).toHaveLength(1);
    expect(world.chests.openings[0]).toMatchObject({ size: 3, via: "clad" });
    expect(canAdChest(world)).toBe(true);
  });

  it("сундук без клада — элиты, босса, разлома — окна не открывает", () => {
    const world = setup();
    openChest(world, 3);
    expect(world.chests.openings[0].via).toBeUndefined();
    expect(canAdChest(world)).toBe(false);
    expect(applyAdChest(world)).toBe(false);
    expect(world.chests.openings).toHaveLength(1);
  });

  it("сундук, открывшийся после клада, перебивает окно: второй сундук к кладу не относится", () => {
    const world = digged();
    openChest(world, 1);
    expect(canAdChest(world)).toBe(false);
    expect(applyAdChest(world)).toBe(false);
    expect(world.progression.adChests).toBe(0);
  });

  it("окно живёт до следующего шага мира: забег пошёл дальше — второй сундук уже не взять", () => {
    const world = digged();
    expect(canAdChest(world)).toBe(true);
    run(world, 1);
    expect(canAdChest(world)).toBe(false);
    expect(applyAdChest(world)).toBe(false);
    expect(world.chests.openings).toHaveLength(1);
  });
});

describe("второй сундук", () => {
  it("того же размера, что у клада; метка «клад за ролик»; право потрачено; счётчики сундуков растут", () => {
    const world = digged();
    const first = world.chests.openings[0];

    expect(applyAdChest(world)).toBe(true);

    expect(world.chests.openings).toHaveLength(2);
    const second = world.chests.openings[1];
    expect(second.size).toBe(first.size);
    expect(second.rewards).toHaveLength(first.size);
    expect(second.via).toBe("clad_ad");
    expect(second.index).toBe(1);
    expect(world.progression.adChests).toBe(1);
    expect(world.chests.opened).toBe(2);
    expect(world.stats.chestsOpened).toBe(2);
    expect(canAdChest(world)).toBe(false);
  });

  it("повтор — отказ: сундук один, право не растёт", () => {
    const world = digged();
    expect(applyAdChest(world)).toBe(true);
    const checksum = checksumWorld(world);
    const rng = world.chests.rng.getState();

    expect(applyAdChest(world)).toBe(false);
    expect(world.chests.openings).toHaveLength(2);
    expect(world.progression.adChests).toBe(1);
    expect(world.chests.rng.getState()).toBe(rng);
    expect(checksumWorld(world)).toBe(checksum);
  });

  it("право одно на забег, а не на клад: у следующего клада второго сундука уже нет", () => {
    const world = digged();
    applyAdChest(world);
    openChest(world, 3, "clad");
    expect(canAdChest(world)).toBe(false);
    expect(applyAdChest(world)).toBe(false);
    expect(world.progression.adChests).toBe(1);
  });

  it("содержимое — из потока сундуков, world.rng не тронут", () => {
    const world = digged();
    const rng = world.rng.getState();
    const chests = world.chests.rng.getState();
    applyAdChest(world);
    expect(world.rng.getState()).toBe(rng);
    expect(world.chests.rng.getState()).not.toBe(chests);
  });

  it("одинаковый seed — одинаковая награда; награды выданы в снаряжение", () => {
    const rewardsOf = (): string[] => {
      const world = digged(7);
      applyAdChest(world);
      return world.chests.openings[1].rewards.map((reward) => reward.id);
    };
    expect(rewardsOf()).toEqual(rewardsOf());

    const world = digged(7);
    const before = world.loadout.weapons.length + world.loadout.passives.length;
    applyAdChest(world);
    expect(world.loadout.weapons.length + world.loadout.passives.length).toBeGreaterThanOrEqual(before);
  });

  it("в файле сундуков нет обращений к world.rng — только к собственному потоку", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/game/sim/chests.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/.*/g, " ");
    expect(source).not.toMatch(/world\.rng/);
    expect(source).toMatch(/chests\.rng/);
  });
});

describe("забег без команды не меняется", () => {
  it("окно не попадает в свёртку мира: клад, на котором команду не дали, идёт как прежде", () => {
    const withWindow = digged(3);
    const closed = digged(3);
    closed.chests.adWindow = null;
    expect(checksumWorld(withWindow)).toBe(checksumWorld(closed));

    run(withWindow, 600);
    run(closed, 600);
    expect(checksumWorld(withWindow)).toBe(checksumWorld(closed));
    expect(withWindow.chests.rng.getState()).toBe(closed.chests.rng.getState());
    expect(withWindow.rng.getState()).toBe(closed.rng.getState());
  });

  it("поток сундуков стоит там же, где стоял: до команды второй сундук не тратит ни одного броска", () => {
    const world = digged(5);
    const direct = setup(5);
    openChest(direct, 3);
    expect(world.chests.rng.getState()).toBe(direct.chests.rng.getState());
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
        chests: CHESTS,
        secrets: ONLY_HOARD,
        map: MAPS[0],
      }),
      director: createTimelineDirector(TIMELINE, ENDLESS_CURVE),
    };
  }

  const roundTrip = (run: Run): Record<string, unknown> => JSON.parse(JSON.stringify(captureWorld(run.world, run.director))) as Record<string, unknown>;

  it("несёт потраченное право и поток сундуков; продолженный забег больше второго сундука не даст", () => {
    const original = newRun(77);
    standOn(original.world, original.world.secrets.sites[0]);
    run(original.world, 2 * TICKS_PER_SEC);
    expect(applyAdChest(original.world)).toBe(true);

    const resumed = newRun(77);
    restoreWorld(resumed.world, resumed.director, roundTrip(original));

    expect(resumed.world.progression.adChests).toBe(1);
    expect(resumed.world.chests.rng.getState()).toBe(original.world.chests.rng.getState());
    expect(resumed.world.chests.opened).toBe(2);
    expect(canAdChest(resumed.world)).toBe(false);
    expect(applyAdChest(resumed.world)).toBe(false);
  });

  it("окно сундука в снимок не входит: сундук, открытый до снимка и не взятый, после продолжения недоступен", () => {
    const original = newRun(78);
    standOn(original.world, original.world.secrets.sites[0]);
    run(original.world, 2 * TICKS_PER_SEC);
    expect(canAdChest(original.world)).toBe(true);

    const resumed = newRun(78);
    restoreWorld(resumed.world, resumed.director, roundTrip(original));
    expect(resumed.world.progression.adChests).toBe(0);
    expect(canAdChest(resumed.world)).toBe(false);
  });

  it("версия формата выросла, а снимок прежней версии не читается", () => {
    expect(WORLD_SNAPSHOT_VERSION).toBeGreaterThanOrEqual(20);
    const saved = roundTrip(newRun(1));
    expect(saved.version).toBe(WORLD_SNAPSHOT_VERSION);
    expect(() => restoreWorld(newRun(1).world, newRun(1).director, { ...saved, version: 19 })).toThrow(SnapshotError);
  });

  it("битое число вторых сундуков — SnapshotError, а не мир с бесконечными сундуками", () => {
    const saved = roundTrip(newRun(1)) as { progression: Record<string, unknown> };
    for (const adChests of [-1, 2, 0.5, "1", null, undefined, Number.NaN]) {
      const input = { ...saved, progression: { ...saved.progression, adChests } };
      expect(() => restoreWorld(newRun(1).world, newRun(1).director, input), String(adChests)).toThrow(SnapshotError);
    }
    const without = { ...saved.progression };
    delete without.adChests;
    expect(() => restoreWorld(newRun(1).world, newRun(1).director, { ...saved, progression: without })).toThrow(SnapshotError);
  });
});

describe("запись и итог забега", () => {
  /** Контент с одним кладом в первом кольце; хэш свой — боевой его не знает. */
  const CONTENT = { ...CONTENT_SNAPSHOT, secrets: ONLY_HOARD };
  const HASH = "ad-chest-test";

  /** Палец ведёт к кладу; выкопав его, второй сундук берут один раз, если сценарий просит. */
  function recorded(takeAdChest: boolean) {
    let taken = false;
    return recordHeadlessRun({
      seed: 3,
      maxTicks: 6_000,
      content: CONTENT,
      contentHash: HASH,
      steer: (_tick, world) => {
        const site = world.secrets.sites.find((entry) => entry.kind === "hoard");
        if (site === undefined) return null;
        const dx = site.x - world.player.x;
        const dy = site.y - world.player.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        return length < 1 ? null : [dx / length, dy / length];
      },
      command: (world) => {
        if (!takeAdChest || taken || !canAdChest(world)) return null;
        taken = true;
        return AD_CHEST_COMMAND;
      },
    });
  }

  const replay = (recording: ReturnType<typeof recorded>) => replayRecording(recording, HASH, { content: CONTENT });

  it("~adchest попадает в лог выбора условным id, а повтор забега «сошёлся»", () => {
    const recording = recorded(true);
    expect(recording.choices.map(([, id]) => id).filter((id) => id === AD_CHEST_COMMAND)).toEqual([AD_CHEST_COMMAND]);

    const outcome = replay(recording);
    expect(outcome.reason).toBeNull();
    expect(outcome.verdict).toBe("match");
    expect(outcome.actual).toEqual(recording.result);
  });

  it("тот же забег без команды сходится сам и кончается другим миром: второй сундук что-то изменил", () => {
    const withCommand = recorded(true);
    const without = recorded(false);
    expect(without.choices.some(([, id]) => id === AD_CHEST_COMMAND)).toBe(false);
    expect(without.result.checksum).not.toBe(withCommand.result.checksum);

    const outcome = replay(without);
    expect(outcome.reason).toBeNull();
    expect(outcome.verdict).toBe("match");
  });

  it("запись с командой, на которую в забеге нет клада, не ложится на забег", () => {
    const recording = recorded(false);
    const forged = { ...recording, choices: [...recording.choices, [recording.result.ticks, AD_CHEST_COMMAND] as [number, string]].sort((a, b) => a[0] - b[0]) };
    const outcome = replay(forged);
    expect(outcome.verdict).toBe("mismatch");
    expect(outcome.reason).toContain(AD_CHEST_COMMAND);
    expect(outcome.reason).toContain("не ложится на забег");
  });

  it("вторая команда в том же окне не ложится на забег", () => {
    const recording = recorded(true);
    const index = recording.choices.findIndex(([, id]) => id === AD_CHEST_COMMAND);
    const [tick] = recording.choices[index];
    const doubled = { ...recording, choices: [...recording.choices.slice(0, index + 1), [tick, AD_CHEST_COMMAND] as [number, string], ...recording.choices.slice(index + 1)] };

    const outcome = replay(doubled);
    expect(outcome.verdict).toBe("mismatch");
    expect(outcome.reason).toContain("не ложится на забег");
  });

  it("итог несёт adChests: 1, а без второго сундука поля нет", () => {
    const options = { runId: "run-x", seed: 1, outcome: "abandoned" as const, startingWeaponId: "spark", contentHash: "abc" };
    const world = digged();
    expect("adChests" in buildRunResult(world, options)).toBe(false);
    applyAdChest(world);
    expect(buildRunResult(world, options).adChests).toBe(1);
  });
});

describe("проводка в сцену и интерфейс движка", () => {
  const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

  it("сцена, шина и интерфейс сессии знают второй сундук", () => {
    const scene = read("../src/game/MainScene.ts");
    expect(scene).toMatch(/openAdChest\(\): void/);
    expect(scene).toMatch(/AD_CHEST_COMMAND/);
    expect(read("../src/engine/run-engine.ts")).toMatch(/openAdChest\(\): void/);
    const api = read("../src/run-api.ts");
    expect(api).toMatch(/openAdChest\(\): void/);
    expect(api).toMatch(/canAdChest: boolean/);
  });
});
