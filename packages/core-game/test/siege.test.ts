import { readFileSync } from "node:fs";
import type { EndlessCurveDef, EnemyDef, SecretsDef, SiegeDef, TimelineSegmentDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { CHESTS } from "../src/content/chests";
import { ENEMIES } from "../src/content/enemies";
import { SECRETS } from "../src/content/secrets";
import { SIEGE } from "../src/content/siege";
import { CONTENT_HASH } from "../src/content/hash";
import { CONTENT_SNAPSHOT, hashSnapshot } from "../src/content/snapshot";
import { contentSnapshotSchema } from "../src/content/snapshot-schema";
import { ENEMY_STAGES } from "../src/content/stages";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { ENDLESS_CURVE } from "../src/content/waves";
import { WEAPONS } from "../src/content/weapons";
import { findContentProblems } from "../src/game/content-problems";
import { buildRunResult } from "../src/game/run/run-result";
import { createRunWorld } from "../src/game/run-world";
import { captureWorld, restoreWorld, SnapshotError } from "../src/game/run/snapshot";
import { checksumWorld } from "../src/game/sim/checksum";
import { applyContinue } from "../src/game/sim/continue";
import { startCordon } from "../src/game/sim/cordon";
import { createTimelineDirector } from "../src/game/sim/director";
import { createRng, deriveSeed, STREAM_SALT } from "../src/game/sim/rng";
import { findSiegeProblems, siegeWarning, takeSiegeEvents, type SiegeEvent } from "../src/game/sim/siege";
import { chooseUpgrade, isAwaitingChoice } from "../src/game/progression/levels";
import { IDLE_INPUT, stepWorld } from "../src/game/sim/step";
import { createWorld, TICK_SEC, type World } from "../src/game/sim/world";

// Осада стоящего (tasks/T-0392, Р197): кто после третьей минуты долго стоит в одном круге,
// того рубеж берёт в осаду — строй стражей и кольцо элит, и с каждым разом сильнее. Здесь —
// правила на маленьких числах фикстуры; числа боя и калибровка — в balance-strong-properties.

const GRUNT: EnemyDef = { id: "grunt", hp: 10, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };
/** Страж не бьёт и почти не двигается: он нужен как тело в строю, игрок в тестах не умирает. */
const GUARD: EnemyDef = { id: "guard", hp: 1_000_000, speed: 40, damage: 0, xp: 1, threat: 1, pattern: "cordon" };
const ELITE_A: EnemyDef = { id: "elite_a", hp: 1_000_000, speed: 0.001, damage: 0, xp: 5, pattern: "swarm", rank: "elite" };
const ELITE_B: EnemyDef = { ...ELITE_A, id: "elite_b" };

/** Первая элита на 100-й секунде, вторая на 200-й: пул элит осады растёт вместе с таймлайном. */
const TIMELINE: TimelineSegmentDef[] = [
  { fromSec: 0, spawns: [{ enemy: "grunt", perSec: 0.2 }] },
  { fromSec: 100, spawns: [{ enemy: "grunt", perSec: 0.2 }], events: [{ kind: "ring", enemy: "elite_a", count: 1 }] },
  { fromSec: 200, spawns: [{ enemy: "grunt", perSec: 0.2 }], events: [{ kind: "ring", enemy: "elite_b", count: 1 }] },
];
const CURVE: EndlessCurveDef = { ...ENDLESS_CURVE, fromSec: 300, events: [] };

const RULES: SiegeDef = {
  fromSec: 10,
  radius: 100,
  holdSec: 8,
  warnSec: 2,
  cooldownSec: 6,
  calmSec: 20,
  growth: 1.5,
  maxLevel: 3,
  cordon: { enemy: "guard", count: 8, ring: { radius: 200, minRadius: 80, shrinkPerSec: 6, lifeSec: 12 } },
  eliteCount: 2,
};

const ONLY_TREE: SecretsDef = { ...SECRETS, rings: [{ minRadius: 700, maxRadius: 1_100, count: 1, kinds: [{ kind: "tree", weight: 1 }] }] };

interface Run {
  world: World;
  director: ReturnType<typeof createTimelineDirector>;
  cursor: number;
  log: SiegeEvent[];
}

function setup(patch: { seed?: number; siege?: SiegeDef; secrets?: SecretsDef; stages?: boolean } = {}): Run {
  const world = createWorld({
    seed: patch.seed ?? 1,
    enemies: [GRUNT, GUARD, ELITE_A, ELITE_B],
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    chests: CHESTS,
    secrets: patch.secrets ?? { ...SECRETS, rings: [] },
    timeline: TIMELINE,
    endlessCurve: CURVE,
    ...(patch.siege === undefined ? {} : { siege: patch.siege }),
    ...(patch.stages === true ? { stages: ENEMY_STAGES } : {}),
  });
  return { world, director: createTimelineDirector(TIMELINE, CURVE), cursor: 0, log: [] };
}

/** Один тик: директор (в нём осада) и шаг мира; события забираются в журнал прогона. */
function tick(run: Run, move?: { x: number; y: number }): void {
  if (move !== undefined) {
    run.world.player.x = move.x;
    run.world.player.y = move.y;
  }
  run.director.update(run.world, TICK_SEC);
  stepWorld(run.world, IDLE_INPUT);
  const taken = takeSiegeEvents(run.world, run.cursor);
  run.cursor = taken.cursor;
  run.log.push(...taken.events);
}

function advance(run: Run, sec: number): void {
  const ticks = Math.round(sec / TICK_SEC);
  for (let i = 0; i < ticks; i++) tick(run);
}

/** Идти до события нужного вида; false, если за `limitSec` оно не пришло. */
function advanceUntil(run: Run, kind: SiegeEvent["kind"], limitSec: number): boolean {
  const seen = run.log.filter((event) => event.kind === kind).length;
  const ticks = Math.round(limitSec / TICK_SEC);
  for (let i = 0; i < ticks; i++) {
    tick(run);
    if (run.log.filter((event) => event.kind === kind).length > seen) return true;
  }
  return false;
}

const eventsOf = <K extends SiegeEvent["kind"]>(run: Run, kind: K): Extract<SiegeEvent, { kind: K }>[] =>
  run.log.filter((event): event is Extract<SiegeEvent, { kind: K }> => event.kind === kind);

function aliveOfRank(world: World, pattern: "cordon" | "elite"): number {
  let alive = 0;
  for (let i = 0; i < world.enemies.count; i++) {
    if (world.enemies.alive[i] === 0) continue;
    const type = world.enemyTypes[world.enemies.type[i]];
    if (pattern === "cordon" ? type.anchored : type.rank === "elite") alive++;
  }
  return alive;
}

describe("осада: когда она начинается", () => {
  it("до fromSec осады нет, сколько ни стой", () => {
    const run = setup({ siege: RULES });
    // Предупреждение пришло бы на 16-й секунде; если бы счёт шёл с нуля, оно прозвучало бы на 6-й.
    advance(run, RULES.fromSec + RULES.holdSec - RULES.warnSec - 0.5);

    expect(run.log).toHaveLength(0);
    expect(run.world.siege.count).toBe(0);
    expect(run.world.cordon.active).toBe(false);
  });

  it("счётчик идёт с fromSec: первая осада — на fromSec + holdSec, а не раньше", () => {
    const run = setup({ siege: RULES });
    expect(advanceUntil(run, "start", 60)).toBe(true);

    const expected = RULES.fromSec + RULES.holdSec;
    expect(run.world.stats.elapsedSec).toBeGreaterThanOrEqual(expected);
    expect(run.world.stats.elapsedSec).toBeLessThanOrEqual(expected + 3 * TICK_SEC);
  });

  it("сначала предупреждение за warnSec, потом осада строем и элитами", () => {
    const run = setup({ siege: RULES });
    expect(advanceUntil(run, "warn", 60)).toBe(true);

    const warnAt = run.world.stats.elapsedSec;
    expect(warnAt).toBeGreaterThanOrEqual(RULES.fromSec + RULES.holdSec - RULES.warnSec);
    expect(warnAt).toBeLessThanOrEqual(RULES.fromSec + RULES.holdSec - RULES.warnSec + 3 * TICK_SEC);
    const warn = eventsOf(run, "warn")[0];
    expect(warn).toMatchObject({ x: run.world.player.x, y: run.world.player.y, radius: RULES.radius, level: 0 });
    // пока кольцо горит, осады ещё нет
    expect(run.world.siege.count).toBe(0);
    expect(siegeWarning(run.world)).not.toBeNull();

    expect(advanceUntil(run, "start", 10)).toBe(true);
    const startAt = run.world.stats.elapsedSec;
    expect(startAt - warnAt).toBeGreaterThanOrEqual(RULES.warnSec - 3 * TICK_SEC);
    expect(startAt - warnAt).toBeLessThanOrEqual(RULES.warnSec + 3 * TICK_SEC);

    expect(eventsOf(run, "start")[0]).toMatchObject({ level: 0, guards: 8, elites: 2 });
    expect(run.world.siege.count).toBe(1);
    expect(run.world.cordon.active).toBe(true);
    // центр строя — якорь, а не прыжок за игроком
    expect(run.world.cordon.centerX).toBe(warn.x);
    expect(run.world.cordon.centerY).toBe(warn.y);
    expect(aliveOfRank(run.world, "cordon")).toBe(8);
    expect(aliveOfRank(run.world, "elite")).toBeGreaterThanOrEqual(2);
    // кольцо на земле погасло: осада уже идёт
    expect(siegeWarning(run.world)).toBeNull();
  });

  it("вышел из круга на последней секунде — осады нет, счётчик с нуля, якорь на новом месте", () => {
    const run = setup({ siege: RULES });
    expect(advanceUntil(run, "warn", 60)).toBe(true);
    const anchorX = run.world.siege.anchorX;

    tick(run, { x: anchorX + RULES.radius + 40, y: run.world.player.y });
    expect(siegeWarning(run.world)).toBeNull();
    expect(run.world.siege.holdTicks).toBe(0);
    expect(run.world.siege.anchorX).toBe(anchorX + RULES.radius + 40);

    // оригинальный срок прошёл — осады нет
    advance(run, RULES.warnSec + 1);
    expect(eventsOf(run, "start")).toHaveLength(0);
    expect(run.world.cordon.active).toBe(false);

    // а на новом месте через holdSec она всё же приходит
    expect(advanceUntil(run, "start", RULES.holdSec)).toBe(true);
  });

  it("мелкие шаги внутри круга счётчик не сбрасывают, а якорь остаётся на месте", () => {
    const run = setup({ siege: RULES });
    advance(run, RULES.fromSec + 0.2);
    const anchorX = run.world.siege.anchorX;
    const anchorY = run.world.siege.anchorY;

    for (let second = 0; second < RULES.holdSec + 2 && eventsOf(run, "start").length === 0; second++) {
      tick(run, { x: anchorX + (second % 2 === 0 ? 30 : -30), y: anchorY });
      advance(run, 1);
    }
    expect(eventsOf(run, "start")).toHaveLength(1);
    expect(run.world.siege.anchorX).toBe(anchorX);
  });

  it("в круге тайника счётчик не растёт: древо-оберег — законное стояние", () => {
    const run = setup({ siege: RULES, secrets: ONLY_TREE });
    const tree = run.world.secrets.sites.find((site) => site.kind === "tree");
    if (tree === undefined) throw new Error("в раскладке нет древа");
    run.world.player.x = tree.x;
    run.world.player.y = tree.y;

    advance(run, RULES.fromSec + RULES.holdSec * 3);
    expect(run.world.siege.holdTicks).toBe(0);
    expect(run.world.siege.count).toBe(0);
    expect(run.log).toHaveLength(0);

    // отошёл от древа — отсчёт начинается с нуля, а не продолжается с накопленного
    tick(run, { x: tree.x + 400, y: tree.y });
    expect(advanceUntil(run, "start", RULES.holdSec + 1)).toBe(true);
    expect(run.world.stats.elapsedSec).toBeGreaterThanOrEqual(RULES.fromSec + RULES.holdSec * 3 + RULES.holdSec - 0.1);
  });

  it("мёртвый игрок осаду не копит", () => {
    const run = setup({ siege: RULES });
    advance(run, RULES.fromSec + 3);
    run.world.player.alive = false;
    advance(run, RULES.holdSec * 2);
    expect(run.world.siege.holdTicks).toBeLessThan(Math.round(4 / TICK_SEC));
    expect(eventsOf(run, "start")).toHaveLength(0);
  });
});

describe("осада: рост, перезарядка, спад", () => {
  it("вторая осада — в growth раз больше, и так до maxLevel; выше уровня не растёт", () => {
    const run = setup({ siege: RULES });
    const guards: number[] = [];
    const elites: number[] = [];
    for (let n = 0; n < 6; n++) {
      expect(advanceUntil(run, "start", 120), `осада ${n + 1}`).toBe(true);
      const start = eventsOf(run, "start")[n];
      guards.push(start.guards);
      elites.push(start.elites);
      expect(start.level).toBe(Math.min(n, RULES.maxLevel));
    }
    // 8 · 1,5^уровень: 8, 12, 18, 27 и потолок
    expect(guards).toEqual([8, 12, 18, 27, 27, 27]);
    expect(elites).toEqual([2, 3, 5, 7, 7, 7]);
    expect(run.world.siege.level).toBe(RULES.maxLevel);
  });

  it("в течение cooldownSec после осады новой нет: следующая — не раньше конца + cooldown + hold", () => {
    const run = setup({ siege: RULES });
    expect(advanceUntil(run, "start", 60)).toBe(true);
    expect(advanceUntil(run, "end", 60)).toBe(true);
    const endedAt = run.world.stats.elapsedSec;

    expect(advanceUntil(run, "start", 60)).toBe(true);
    const startedAt = run.world.stats.elapsedSec;
    expect(startedAt - endedAt).toBeGreaterThanOrEqual(RULES.cooldownSec + RULES.holdSec - 3 * TICK_SEC);
  });

  it("осада кончается вместе со строем: событие end один раз, перезарядка идёт", () => {
    const run = setup({ siege: RULES });
    expect(advanceUntil(run, "start", 60)).toBe(true);
    expect(advanceUntil(run, "end", RULES.cordon.ring.lifeSec + 5)).toBe(true);

    expect(eventsOf(run, "end")).toHaveLength(1);
    expect(eventsOf(run, "end")[0]).toMatchObject({ level: 0 });
    expect(run.world.cordon.active).toBe(false);
    expect(run.world.siege.active).toBe(false);
    expect(run.world.siege.cooldownTicks).toBeGreaterThan(0);
  });

  it("calmSec вне осады снимает один уровень; идущий не накапливает уровень зря", () => {
    const run = setup({ siege: RULES });
    expect(advanceUntil(run, "start", 60)).toBe(true);
    expect(advanceUntil(run, "end", 60)).toBe(true);
    expect(run.world.siege.level).toBe(1);

    // бегает: каждую секунду уходит за радиус круга, поэтому новой осады нет
    for (let second = 0; second < RULES.calmSec + 2; second++) {
      tick(run, { x: run.world.player.x + 150, y: run.world.player.y });
      advance(run, 1);
    }
    expect(run.world.siege.level).toBe(0);
    expect(eventsOf(run, "start")).toHaveLength(1);

    // следующая осада — снова с базового размера
    tick(run, { x: run.world.player.x + 150, y: run.world.player.y });
    expect(advanceUntil(run, "start", 60)).toBe(true);
    expect(eventsOf(run, "start")[1]).toMatchObject({ level: 0, guards: 8 });
  });

  it("если строй уже стоит (другое кольцо), второй не ставится, а осада идёт до конца того", () => {
    const run = setup({ siege: RULES });
    advance(run, RULES.fromSec + 1);
    // кольцо таймлайна уже стоит: страж — второй тип фикстуры
    startCordon(run.world, 1, 4, { radius: 200, minRadius: 80, shrinkPerSec: 2, lifeSec: 20 });
    expect(run.world.cordon.guards).toBe(4);
    expect(advanceUntil(run, "start", 30)).toBe(true);

    expect(eventsOf(run, "start")[0].guards).toBe(0);
    expect(run.world.cordon.guards).toBe(4);
    expect(run.world.siege.active).toBe(true);
    expect(eventsOf(run, "end")).toHaveLength(0);
    expect(advanceUntil(run, "end", 30)).toBe(true);
    expect(run.world.cordon.active).toBe(false);
  });
});

describe("осада: где её нет", () => {
  it("мир без директора осады не знает: на шаге мира она не идёт", () => {
    const world = createWorld({ seed: 1, enemies: [GRUNT, GUARD, ELITE_A, ELITE_B], siege: RULES, timeline: TIMELINE, endlessCurve: CURVE });
    for (let i = 0; i < Math.round((RULES.fromSec + RULES.holdSec + 5) / TICK_SEC); i++) stepWorld(world, IDLE_INPUT);
    expect(world.siege.count).toBe(0);
    expect(world.cordon.active).toBe(false);
  });

  it("мир без правил (стенды, тесты паттернов) осады не имеет", () => {
    const run = setup();
    advance(run, RULES.fromSec + RULES.holdSec + 5);
    expect(run.world.siegeRules).toBeNull();
    expect(run.log).toHaveLength(0);
  });

  it("в прологе и на «Лёгкой» правил осады в мире нет, а на «Сложной» они есть", () => {
    const base = { mapId: CONTENT_SNAPSHOT.maps[0].id, unitScale: 1 } as const;
    expect(createRunWorld({ ...base, seed: 1, difficultyId: "hard" }).world.siegeRules).toEqual(SIEGE);
    expect(createRunWorld({ ...base, seed: 1, difficultyId: "easy" }).world.siegeRules).toBeNull();
    expect(createRunWorld({ ...base, seed: 1, difficultyId: "hard", mode: "prologue" }).world.siegeRules).toBeNull();
  });

  it("стоящий на «Сложной» боевого контента получает предупреждение и осаду; на «Лёгкой» — нет", () => {
    const base = { mapId: CONTENT_SNAPSHOT.maps[0].id, unitScale: 1 } as const;
    const stand = (difficultyId: "easy" | "hard"): { warns: number; starts: number } => {
      const { world, spawner } = createRunWorld({ ...base, seed: 3, difficultyId });
      world.cheats.godMode = true;
      let cursor = 0;
      let warns = 0;
      let starts = 0;
      const ticks = Math.round((SIEGE.fromSec + SIEGE.holdSec + 6) / TICK_SEC);
      for (let i = 0; i < ticks; i++) {
        // Стоящий отвечает на выбор уровня первой карточкой: пока выбор не сделан, мир стоит.
        if (isAwaitingChoice(world)) chooseUpgrade(world, world.progression.offers[0].id);
        spawner.update(world, TICK_SEC);
        stepWorld(world, IDLE_INPUT);
        const taken = takeSiegeEvents(world, cursor);
        cursor = taken.cursor;
        for (const event of taken.events) {
          if (event.kind === "warn") warns++;
          if (event.kind === "start") starts++;
        }
      }
      return { warns, starts };
    };

    expect(stand("hard")).toEqual({ warns: 1, starts: 1 });
    expect(stand("easy")).toEqual({ warns: 0, starts: 0 });
  });
});

describe("осада: случайность — свой поток", () => {
  it("поток осады — от seed забега с собственной солью, а не world.rng", () => {
    const run = setup({ siege: RULES, seed: 99 });
    expect(run.world.siege.rng.getState()).toBe(createRng(deriveSeed(99, STREAM_SALT.siege)).getState());
    expect(run.world.siege.rng.getState()).not.toBe(run.world.rng.getState());
  });

  it("в файле осады нет обращений к world.rng — только к собственному потоку", () => {
    const source = readFileSync(new URL("../src/game/sim/siege.ts", import.meta.url), "utf8");
    expect(source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*/g, " ")).not.toMatch(/world\.rng/);
  });

  it("мир с осадой и мир без неё дают одинаковые предложения уровней, а world.rng не сдвинут", () => {
    // Ступени врагов открыты (с 150-й секунды): страж обычного ранга бросает ступень из rng, и без
    // отдельного потока осада сдвинула бы world.rng уже на спавне строя.
    const rules: SiegeDef = { ...RULES, fromSec: 150 };
    const withSiege = setup({ siege: rules, stages: true });
    const without = setup({ stages: true });
    withSiege.world.cheats.godMode = true;
    without.world.cheats.godMode = true;

    expect(advanceUntil(withSiege, "start", 170)).toBe(true);
    const ticks = withSiege.world.stats.tick;
    while (without.world.stats.tick < ticks) tick(without);
    expect(aliveOfRank(withSiege.world, "cordon")).toBe(8);
    expect(aliveOfRank(without.world, "cordon")).toBe(0);

    expect(withSiege.world.rng.getState()).toBe(without.world.rng.getState());
    for (const run of [withSiege, without]) run.world.progression.pendingLevelUps = 1;
    tick(withSiege);
    tick(without);
    expect(withSiege.world.progression.offers.length).toBeGreaterThan(0);
    expect(withSiege.world.progression.offers.map((offer) => offer.id)).toEqual(without.world.progression.offers.map((offer) => offer.id));
  });
});

describe("осада: снимок прерванного забега", () => {
  /** Мир, восстановленный из снимка: тот же seed и контент, как у продолженного забега. */
  function resumed(run: Run): Run {
    const next = setup({ siege: RULES, seed: 1 });
    restoreWorld(next.world, next.director, JSON.parse(JSON.stringify(captureWorld(run.world, run.director))));
    return next;
  }

  function sameFuture(a: Run, b: Run, sec: number): void {
    const ticks = Math.round(sec / TICK_SEC);
    for (let i = 0; i < ticks; i++) {
      tick(a);
      tick(b);
      if (checksumWorld(a.world) !== checksumWorld(b.world)) throw new Error(`расхождение на тике ${a.world.stats.tick}`);
    }
    expect(b.log.map((event) => event.kind)).toEqual(a.log.slice(a.log.length - b.log.length).map((event) => event.kind));
  }

  it("посреди отсчёта: счётчик, якорь и предупреждение вернулись, дальше мир идёт одинаково", () => {
    const run = setup({ siege: RULES });
    expect(advanceUntil(run, "warn", 60)).toBe(true);
    advance(run, 1);

    const copy = resumed(run);
    expect(copy.world.siege).toMatchObject({
      anchored: true,
      anchorX: run.world.siege.anchorX,
      holdTicks: run.world.siege.holdTicks,
      warned: true,
      level: run.world.siege.level,
    });
    expect(siegeWarning(copy.world)).toEqual(siegeWarning(run.world));
    expect(checksumWorld(copy.world)).toBe(checksumWorld(run.world));
    sameFuture(run, copy, RULES.holdSec + 20);
    expect(copy.world.siege.count).toBe(run.world.siege.count);
    expect(copy.world.siege.count).toBeGreaterThanOrEqual(1);
  });

  it("посреди осады и в перезарядке: уровень, перезарядка, отсчёт calmSec и поток вернулись", () => {
    const run = setup({ siege: RULES });
    expect(advanceUntil(run, "start", 60)).toBe(true);
    advance(run, 3);
    const during = resumed(run);
    expect(during.world.siege.active).toBe(true);
    expect(during.world.siege.rng.getState()).toBe(run.world.siege.rng.getState());
    sameFuture(run, during, RULES.cordon.ring.lifeSec + RULES.cooldownSec + RULES.holdSec + 10);

    const cooling = setup({ siege: RULES });
    expect(advanceUntil(cooling, "end", 60)).toBe(true);
    advance(cooling, 2);
    const copy = resumed(cooling);
    expect(copy.world.siege).toMatchObject({
      cooldownTicks: cooling.world.siege.cooldownTicks,
      calmTicks: cooling.world.siege.calmTicks,
      level: 1,
      count: 1,
    });
    sameFuture(cooling, copy, 40);
    expect(copy.world.siege.count).toBe(cooling.world.siege.count);
  });

  it("контрольная сумма видит расхождение в осаде", () => {
    const a = setup({ siege: RULES });
    const b = setup({ siege: RULES });
    advance(a, RULES.fromSec + 3);
    advance(b, RULES.fromSec + 3);
    expect(checksumWorld(a.world)).toBe(checksumWorld(b.world));
    b.world.siege.holdTicks += 1;
    expect(checksumWorld(a.world)).not.toBe(checksumWorld(b.world));
    b.world.siege.holdTicks -= 1;
    b.world.siege.level = 2;
    expect(checksumWorld(a.world)).not.toBe(checksumWorld(b.world));
  });

  it("снимок без поля осады (прежний формат) читается: осада начинается заново", () => {
    const run = setup({ siege: RULES });
    advance(run, RULES.fromSec + 3);
    const snapshot = JSON.parse(JSON.stringify(captureWorld(run.world, run.director))) as Record<string, unknown>;
    delete snapshot.siege;

    const next = setup({ siege: RULES });
    restoreWorld(next.world, next.director, snapshot);
    expect(next.world.siege).toMatchObject({ anchored: false, holdTicks: 0, level: 0, count: 0, active: false });
  });

  it("битое поле осады — SnapshotError, а не мир с NaN", () => {
    const run = setup({ siege: RULES });
    advance(run, RULES.fromSec + 3);
    const good = JSON.parse(JSON.stringify(captureWorld(run.world, run.director))) as { siege: Record<string, unknown> };

    for (const patch of [{ holdTicks: "много" }, { level: -1 }, { rng: null }, { anchored: 1 }, { count: 1.5 }]) {
      const bad = { ...good, siege: { ...good.siege, ...patch } };
      expect(() => restoreWorld(setup({ siege: RULES }).world, run.director, bad), JSON.stringify(patch)).toThrow(SnapshotError);
    }
  });
});

describe("осада: второй шанс и итог", () => {
  it("«Второй шанс» сбрасывает якорь и счётчик, кольцо на земле гаснет", () => {
    const run = setup({ siege: RULES });
    expect(advanceUntil(run, "warn", 60)).toBe(true);
    expect(run.world.siege.holdTicks).toBeGreaterThan(0);

    run.world.player.alive = false;
    run.world.player.hp = 0;
    expect(applyContinue(run.world)).toBe(true);

    expect(run.world.siege).toMatchObject({ anchored: false, holdTicks: 0, warned: false });
    expect(siegeWarning(run.world)).toBeNull();
    // и после продолжения счёт идёт заново: осада не прилетает через секунду
    advance(run, RULES.holdSec - 1);
    expect(eventsOf(run, "start")).toHaveLength(0);
  });

  it("итог забега несёт число осад", () => {
    const run = setup({ siege: RULES });
    const options = { runId: "r", seed: 1, outcome: "died", startingWeaponId: "spark", contentHash: "x" } as const;
    expect(buildRunResult(run.world, options).sieges).toBe(0);
    expect(advanceUntil(run, "start", 60)).toBe(true);
    expect(buildRunResult(run.world, options).sieges).toBe(1);
    expect(advanceUntil(run, "start", 120)).toBe(true);
    expect(buildRunResult(run.world, options).sieges).toBe(2);
  });
});

describe("осада: контент и проверка", () => {
  const problems = (patch: Partial<SiegeDef>): string[] => findSiegeProblems({ ...SIEGE, ...patch }, ENEMIES);

  it("боевой SIEGE проверку проходит, а снимок контента и хэш его знают", () => {
    expect(findSiegeProblems(SIEGE, ENEMIES)).toEqual([]);
    expect(CONTENT_SNAPSHOT.siege).toBe(SIEGE);
    expect(findContentProblems(CONTENT_SNAPSHOT)).toEqual([]);
    expect(contentSnapshotSchema.safeParse(JSON.parse(JSON.stringify(CONTENT_SNAPSHOT))).success).toBe(true);
    expect(hashSnapshot({ ...CONTENT_SNAPSHOT, siege: { ...SIEGE, holdSec: SIEGE.holdSec + 1 } })).not.toBe(CONTENT_HASH);
  });

  it("warnSec меньше holdSec и больше нуля", () => {
    expect(problems({ warnSec: SIEGE.holdSec }).join("\n")).toMatch(/siege\.warnSec/);
    expect(problems({ warnSec: SIEGE.holdSec + 5 }).join("\n")).toMatch(/siege\.warnSec/);
    expect(problems({ warnSec: 0 }).join("\n")).toMatch(/siege\.warnSec/);
  });

  it("radius меньше радиуса строя: иначе игрок в круге оказался бы за стражами", () => {
    expect(problems({ radius: SIEGE.cordon.ring.radius }).join("\n")).toMatch(/siege\.radius/);
    expect(problems({ radius: 0 }).join("\n")).toMatch(/siege\.radius/);
  });

  it("числа кольца — в коридорах события cordon", () => {
    const ring = SIEGE.cordon.ring;
    expect(problems({ cordon: { ...SIEGE.cordon, ring: { ...ring, minRadius: 10 } } }).join("\n")).toMatch(/siege\.cordon: ring\.minRadius/);
    expect(problems({ cordon: { ...SIEGE.cordon, ring: { ...ring, radius: 999 } } }).join("\n")).toMatch(/siege\.cordon: ring\.radius/);
    expect(problems({ cordon: { ...SIEGE.cordon, ring: { ...ring, lifeSec: 1 } } }).join("\n")).toMatch(/siege\.cordon: ring\.lifeSec/);
    expect(problems({ cordon: { ...SIEGE.cordon, ring: { ...ring, shrinkPerSec: 0 } } }).join("\n")).toMatch(/siege\.cordon: ring\.shrinkPerSec/);
  });

  it("враг строя — страж паттерна cordon из контента", () => {
    expect(problems({ cordon: { ...SIEGE.cordon, enemy: "нет_такого" } }).join("\n")).toMatch(/siege\.cordon\.enemy/);
    expect(problems({ cordon: { ...SIEGE.cordon, enemy: "swarm_rat" } }).join("\n")).toMatch(/siege\.cordon\.enemy/);
  });

  it("growth от 1 до 2, maxLevel от 1 до 10 целым", () => {
    expect(problems({ growth: 0.9 }).join("\n")).toMatch(/siege\.growth/);
    expect(problems({ growth: 2.1 }).join("\n")).toMatch(/siege\.growth/);
    expect(problems({ growth: 1 })).toEqual([]);
    expect(problems({ growth: 2, maxLevel: 1 }).join("\n")).not.toMatch(/siege\.growth/);
    expect(problems({ maxLevel: 0 }).join("\n")).toMatch(/siege\.maxLevel/);
    expect(problems({ maxLevel: 11 }).join("\n")).toMatch(/siege\.maxLevel/);
    expect(problems({ maxLevel: 2.5 }).join("\n")).toMatch(/siege\.maxLevel/);
  });

  it("строй на максимальном уровне помещается в потолок кольца и пула", () => {
    expect(problems({ growth: 2, maxLevel: 10 }).join("\n")).toMatch(/siege\.(growth|maxLevel|cordon\.count)/);
  });

  it("секунды и счётчики — конечные положительные числа, число элит — целое", () => {
    for (const field of ["fromSec", "holdSec", "calmSec", "cooldownSec"] as const) {
      expect(problems({ [field]: Number.NaN }).join("\n"), field).toMatch(new RegExp(`siege\\.${field}`));
      expect(problems({ [field]: -1 }).join("\n"), field).toMatch(new RegExp(`siege\\.${field}`));
    }
    expect(problems({ eliteCount: 1.5 }).join("\n")).toMatch(/siege\.eliteCount/);
    expect(problems({ eliteCount: -1 }).join("\n")).toMatch(/siege\.eliteCount/);
  });

  it("мир с некорректной осадой не создаётся: сообщение называет поле", () => {
    expect(() => setup({ siege: { ...RULES, warnSec: 99 } })).toThrow(/siege\.warnSec/);
  });
});

describe("осада: чистота кода", () => {
  it("в game/sim/siege.ts нет тригонометрии, Math.pow и часов", () => {
    const source = readFileSync(new URL("../src/game/sim/siege.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/.*/g, " ");
    expect(source).not.toMatch(/Math\.(hypot|pow|sin|cos|tan|asin|acos|atan|atan2|exp|log|log2|log10|cbrt|random)\b/);
    expect(source).not.toMatch(/\*\*/);
    expect(source).not.toMatch(/Date\.now|new Date\(|performance\.now/);
  });
});
