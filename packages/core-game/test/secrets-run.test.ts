import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SecretsDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { SECRETS } from "../src/content/secrets";
import { CONTENT_SNAPSHOT, type ContentSnapshot } from "../src/content/snapshot";
import { RunBus } from "../src/engine/run-bus";
import { createRunWorld } from "../src/game/run-world";
import { chooseBlessing, isAwaitingBlessing, takeSecretEvents, type SecretCursor } from "../src/game/sim/secrets";
import { IDLE_INPUT, stepWorld } from "../src/game/sim/step";
import type { SecretSite, World } from "../src/game/sim/world";

// Тайники в забеге (docs/35-stage4-plan.md, Р153; tasks/T-0352): движок тайников
// готов в T-0258, здесь — проводка: забег собирается с тайниками из контента,
// события доходят до шины, а капище при опции паузы стоит на выборе, пока не
// придёт `chooseBlessing`. Сцена Phaser в тесте не поднимается: её кусок —
// проверка по исходнику, как у `run-snapshot.test.ts`.

const SCENE_SOURCE = readFileSync(fileURLToPath(new URL("../src/game/MainScene.ts", import.meta.url)), "utf8");
const ENGINE_SOURCE = readFileSync(fileURLToPath(new URL("../src/engine/run-engine.ts", import.meta.url)), "utf8");
const API_SOURCE = readFileSync(fileURLToPath(new URL("../src/run-api.ts", import.meta.url)), "utf8");
const BUS_SOURCE = readFileSync(fileURLToPath(new URL("../src/engine/run-bus.ts", import.meta.url)), "utf8");

const TICKS_PER_SEC = 60;

/** Одно капище в первом кольце и три благословения: выбор известен до начала. */
const ONLY_SHRINE: SecretsDef = {
  ...SECRETS,
  rings: [{ minRadius: 700, maxRadius: 1_100, count: 1, kinds: [{ kind: "shrine", weight: 1 }] }],
  blessings: SECRETS.blessings.slice(0, 3),
};

function contentWith(secrets: SecretsDef): ContentSnapshot {
  return { ...CONTENT_SNAPSHOT, secrets };
}

function runWorld(secrets: SecretsDef = SECRETS, seed = 1): World {
  return createRunWorld({ seed, unitScale: 1, content: contentWith(secrets) }).world;
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

function shrineOf(world: World): SecretSite {
  const shrine = world.secrets.sites.find((site) => site.kind === "shrine");
  if (shrine === undefined) throw new Error("в раскладке нет капища");
  return shrine;
}

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepWorld(world, IDLE_INPUT);
}

const NO_EVENTS: SecretCursor = { found: 0, used: 0, blessings: 0 };

describe("забег собирается с тайниками из контента", () => {
  it("createRunWorld передаёт тайники в мир: раскладка из контента, а не пустая", () => {
    const world = runWorld();
    expect(world.secretRules).toBe(SECRETS);
    // Места из колец плюс огонёк, который один на забег.
    const places = SECRETS.rings.reduce((total, ring) => total + ring.count, 0);
    expect(world.secrets.sites).toHaveLength(places + 1);
    expect(world.secrets.sites.some((site) => site.kind === "shrine")).toBe(true);
  });

  it("правка тайников в снимке контента меняет раскладку: берётся снимок, а не импорт", () => {
    const none = runWorld({ ...SECRETS, rings: [] });
    expect(none.secrets.sites).toHaveLength(0);
    expect(runWorld(ONLY_SHRINE).secrets.sites.filter((site) => site.kind === "shrine")).toHaveLength(1);
  });

  it("раскладка зависит только от seed: тот же seed — те же места", () => {
    const layout = (world: World) => world.secrets.sites.map((site) => [site.kind, site.x, site.y]);
    expect(layout(runWorld(SECRETS, 77))).toEqual(layout(runWorld(SECRETS, 77)));
    expect(layout(runWorld(SECRETS, 77))).not.toEqual(layout(runWorld(SECRETS, 78)));
  });
});

describe("капище без опции паузы", () => {
  it("берёт первое из предложенных; события находки и использования приходят по разу", () => {
    const world = runWorld(ONLY_SHRINE, 3);
    const shrine = shrineOf(world);
    standOn(world, shrine);
    expect(world.secrets.manualBlessing).toBe(false);

    let cursor = NO_EVENTS;
    const found: string[] = [];
    const used: string[] = [];
    const offered: string[][] = [];
    // Стояние + запас: событие находки приходит на первом тике круга, использования — после стояния.
    for (let tick = 0; tick < (ONLY_SHRINE.shrine.holdSec + 2) * TICKS_PER_SEC; tick++) {
      stepWorld(world, IDLE_INPUT);
      const events = takeSecretEvents(world, cursor);
      cursor = events.cursor;
      found.push(...events.found.map((event) => event.kind));
      used.push(...events.used.map((event) => event.outcome));
      offered.push(...events.blessings.map((event) => event.options.map((option) => option.id)));
    }

    expect(found).toEqual(["shrine"]);
    expect(offered).toHaveLength(1);
    expect(offered[0]).toHaveLength(ONLY_SHRINE.shrine.offers);
    // Первое из предложенных — как в движке тайников, без остановки мира.
    expect(used).toEqual([offered[0][0]]);
    expect(isAwaitingBlessing(world)).toBe(false);
    expect(world.secrets.blessings).toEqual([offered[0][0]]);
  });

  it("мир не останавливается: тики идут и после находки", () => {
    const world = runWorld(ONLY_SHRINE, 3);
    standOn(world, shrineOf(world));
    run(world, (ONLY_SHRINE.shrine.holdSec + 2) * TICKS_PER_SEC);
    expect(world.stats.tick).toBe((ONLY_SHRINE.shrine.holdSec + 2) * TICKS_PER_SEC);
  });
});

describe("капище с опцией паузы", () => {
  /** Мир, как его собирает сцена при `pauseOnChest`: выбор отдан игроку. */
  function manualWorld(): World {
    const world = runWorld(ONLY_SHRINE, 3);
    world.secrets.manualBlessing = true;
    return world;
  }

  function standUntilOffer(world: World): void {
    standOn(world, shrineOf(world));
    for (let tick = 0; tick < (ONLY_SHRINE.shrine.holdSec + 2) * TICKS_PER_SEC && !isAwaitingBlessing(world); tick++) {
      stepWorld(world, IDLE_INPUT);
    }
  }

  it("стоит на капище, пока не придёт chooseBlessing: мир не шагает", () => {
    const world = manualWorld();
    standUntilOffer(world);
    expect(isAwaitingBlessing(world)).toBe(true);

    const tick = world.stats.tick;
    run(world, 120);
    expect(world.stats.tick).toBe(tick);
    expect(world.secrets.offer).not.toBeNull();
    expect(world.secrets.blessings).toEqual([]);
  });

  it("неизвестный id и id не из предложенных — забег стоит дальше", () => {
    const world = manualWorld();
    standUntilOffer(world);
    const offer = world.secrets.offer;
    if (offer === null) throw new Error("предложения нет");
    const foreign = ONLY_SHRINE.blessings.length < SECRETS.blessings.length ? SECRETS.blessings[SECRETS.blessings.length - 1].id : "not-offered";

    expect(chooseBlessing(world, "нет-такого")).toBe(false);
    expect(chooseBlessing(world, foreign)).toBe(false);
    expect(isAwaitingBlessing(world)).toBe(true);
    run(world, 30);
    expect(isAwaitingBlessing(world)).toBe(true);
  });

  it("выбор из предложенных снимает остановку: благословение взято, мир шагает, использование приходит событием", () => {
    const world = manualWorld();
    standUntilOffer(world);
    const offer = world.secrets.offer;
    if (offer === null) throw new Error("предложения нет");
    // Не первое: выбор игрока, а не запасной вариант без паузы.
    const picked = offer.options[1];

    let cursor = NO_EVENTS;
    const before = takeSecretEvents(world, cursor);
    cursor = before.cursor;
    expect(before.found.map((event) => event.kind)).toEqual(["shrine"]);
    expect(before.blessings).toHaveLength(1);
    expect(before.used).toEqual([]);

    expect(chooseBlessing(world, picked)).toBe(true);
    expect(isAwaitingBlessing(world)).toBe(false);
    const after = takeSecretEvents(world, cursor);
    expect(after.used.map((event) => event.outcome)).toEqual([picked]);
    expect(world.secrets.blessings).toEqual([picked]);

    const tick = world.stats.tick;
    run(world, 10);
    expect(world.stats.tick).toBe(tick + 10);
  });
});

describe("случайность", () => {
  it("world.rng не трогается: состояние то же, что в мире без тайников", () => {
    const withSecrets = runWorld(SECRETS, 11);
    const without = runWorld({ ...SECRETS, rings: [] }, 11);
    const shrine = withSecrets.secrets.sites.find((site) => site.kind === "shrine");
    if (shrine === undefined) throw new Error("в раскладке нет капища");

    // Игрок стоит на капище, а во втором мире — на том же месте без тайника: сравнивается только генератор.
    for (const world of [withSecrets, without]) {
      standOn(world, shrine);
      run(world, (SECRETS.shrine.holdSec + 2) * TICKS_PER_SEC);
    }
    expect(withSecrets.secrets.blessings).toHaveLength(1);
    expect(withSecrets.rng.getState()).toBe(without.rng.getState());
  });
});

describe("шина и сессия забега", () => {
  it("шина знает события тайников: слушатель получает ровно то, что отправлено", () => {
    const bus = new RunBus();
    const seen: unknown[] = [];
    bus.on("secretFound", (event) => seen.push(["found", event.kind]));
    bus.on("secretUsed", (event) => seen.push(["used", event.outcome]));
    bus.on("secretBlessing", (event) => seen.push(["blessing", event.options.length]));

    bus.emit("secretFound", { index: 0, kind: "shrine", elapsedSec: 12 });
    bus.emit("secretBlessing", { index: 0, options: SECRETS.blessings.slice(0, 3), elapsedSec: 15 });
    bus.emit("secretUsed", { index: 0, kind: "shrine", outcome: "fury", elapsedSec: 16 });
    expect(seen).toEqual([["found", "shrine"], ["blessing", 3], ["used", "fury"]]);

    bus.clear();
    bus.emit("secretFound", { index: 1, kind: "hoard", elapsedSec: 40 });
    expect(seen).toHaveLength(3);
  });

  it("контракт: события в RunEvents, chooseBlessing в RunSession и в движке, сцена его принимает", () => {
    for (const name of ["secretFound", "secretUsed", "secretBlessing"]) {
      expect(API_SOURCE, name).toContain(`${name}:`);
      expect(BUS_SOURCE, name).toContain(`${name}: new Set()`);
      expect(SCENE_SOURCE, name).toContain(`emit("${name}"`);
    }
    expect(API_SOURCE).toMatch(/chooseBlessing\(id: string\): void/);
    expect(ENGINE_SOURCE).toContain("chooseBlessing(id: string): void");
    expect(ENGINE_SOURCE).toMatch(/scene\(\)\?\.chooseBlessing\(id\)/);
  });

  it("сцена отдаёт выбор игроку только при pauseOnChest и пишет выбор в запись забега", () => {
    expect(SCENE_SOURCE).toMatch(/manualBlessing\s*=\s*this\.sceneData\.pauseOnChest === true/);
    expect(SCENE_SOURCE).toMatch(/probe\.choice\(this\.world, `blessing:\$\{id\}`\)/);
    expect(SCENE_SOURCE).toContain("isAwaitingBlessing");
  });
});
