import { describe, expect, it } from "vitest";
import { buildRunResult } from "../src/game/run/run-result";
import { captureWorld, restoreWorld, WORLD_SNAPSHOT_VERSION } from "../src/game/run/snapshot";
import { inflictDamage, killEnemy } from "../src/game/sim/combat";
import { ELEMENT_FIRE } from "../src/game/sim/elements";
import { damagePlayer, despawnEnemy, spawnEnemy } from "../src/game/sim/world";
import { advanceRun, createCordonRun, type CordonRun } from "./helpers/scripted-run";

// Серии без попаданий и без убийств и убийства по стихиям (docs/35-stage4-plan.md
// Р161, tasks/T-0321): основа для «Без единой царапины», «Пацифиста» и
// стихийников. Мир строится на фикстурах кольца без отрезков таймлайна: тест
// смотрит на счётчики, а не на бой. Крыса — тип 1.

const RAT_TYPE = 1;

function run(): CordonRun {
  return createCordonRun({ timeline: [{ fromSec: 0, spawns: [], events: [] }] });
}

function result(r: CordonRun) {
  return buildRunResult(r.world, { runId: "streaks", seed: 1, outcome: "died", startingWeaponId: "spark", contentHash: "test" });
}

/** Игрок получил удар от крысы. */
const hit = (r: CordonRun, amount = 5): void => damagePlayer(r.world, amount, RAT_TYPE);

/** Крыса поставлена и убита: стихия удара — физическая, если не задана другая. */
function kill(r: CordonRun, element?: number): void {
  const slot = spawnEnemy(r.world, RAT_TYPE, 300, 300);
  expect(slot).toBeGreaterThanOrEqual(0);
  if (element === undefined) inflictDamage(r.world, slot, 1e9, -1);
  else inflictDamage(r.world, slot, 1e9, -1, element);
}

describe("серия без попаданий", () => {
  it("десять минут без единого удара — 600 секунд", () => {
    const r = run();
    advanceRun(r, 600);
    expect(result(r).noHitSec).toBe(600);
  });

  it("удар на 200-й секунде: закрытая серия 200, текущая до конца 400 — в итог идёт большая", () => {
    const r = run();
    advanceRun(r, 200);
    hit(r);
    advanceRun(r, 400);
    expect(result(r).noHitSec).toBe(400);
  });

  it("удар на 400-й секунде: закрытая 400, текущая 200 — идёт закрытая", () => {
    const r = run();
    advanceRun(r, 400);
    hit(r);
    advanceRun(r, 200);
    expect(result(r).noHitSec).toBe(400);
  });

  it("секунды — целые вниз: 59,9 секунды — это 59", () => {
    const r = run();
    advanceRun(r, 59.9);
    expect(result(r).noHitSec).toBe(59);
  });

  it("попадание в щит буста закрывает серию: купленный щит не облегчает «Без единой царапины»", () => {
    const r = run();
    r.world.player.shieldHits = 1;
    advanceRun(r, 100);
    hit(r);
    advanceRun(r, 20);
    expect(r.world.player.shieldHits).toBe(0);
    expect(result(r).noHitSec).toBe(100);
  });

  it("удар в неуязвимость серию не рвёт: такого попадания нет", () => {
    const r = run();
    r.world.player.invulnerableTicks = 10_000;
    advanceRun(r, 100);
    hit(r);
    advanceRun(r, 20);
    expect(result(r).noHitSec).toBe(120);
  });

  it("тик горения — попадание", () => {
    const r = run();
    advanceRun(r, 50);
    r.world.player.burnTimer = 2;
    r.world.player.burnDps = 10;
    r.world.player.burnSource = RAT_TYPE;
    advanceRun(r, 70);
    // горение ударило на 50-й секунде и закрыло серию: ни 50, ни 120 без попаданий
    expect(result(r).noHitSec).toBeLessThan(120);
    expect(result(r).noHitSec).toBeGreaterThanOrEqual(50);
    expect(r.world.stats.damageTaken).toBeGreaterThan(0);
  });

  it("бессмертие разработчика и броня серию не спасают: счёт — до них", () => {
    const r = run();
    r.world.cheats.godMode = true;
    advanceRun(r, 100);
    hit(r);
    advanceRun(r, 20);
    expect(r.world.stats.damageTaken).toBe(0);
    expect(result(r).noHitSec).toBe(100);
  });
});

describe("серия без убийств — только закрытая убийством", () => {
  it("убийства на 10-й и 75-й секунде — серия 65 секунд", () => {
    const r = run();
    advanceRun(r, 10);
    kill(r);
    advanceRun(r, 65);
    kill(r);
    expect(result(r).noKillSec).toBe(65);
  });

  it("хвост до смерти не считается: двести секунд после последнего убийства ничего не дают", () => {
    const r = run();
    advanceRun(r, 10);
    kill(r);
    advanceRun(r, 65);
    kill(r);
    advanceRun(r, 200);
    expect(result(r).noKillSec).toBe(65);
  });

  it("без единого убийства серия не закрыта — ноль: «отбежать минуту и сдаться» достижения не даёт", () => {
    const r = run();
    advanceRun(r, 300);
    expect(result(r).noKillSec).toBe(0);
  });

  it("первая серия — с первого тика забега до первого убийства", () => {
    const r = run();
    advanceRun(r, 90);
    kill(r);
    expect(result(r).noKillSec).toBe(90);
  });

  it("враги, снятые вторым шансом, не убиты: серия не закрывается", () => {
    const r = run();
    advanceRun(r, 10);
    const slot = spawnEnemy(r.world, RAT_TYPE, 300, 300);
    despawnEnemy(r.world, slot);
    advanceRun(r, 50);
    expect(result(r).noKillSec).toBe(0);
  });
});

describe("убийства по стихии", () => {
  it("огонь — ключ fire; физическое и динамит — без ключа", () => {
    const r = run();
    kill(r, ELEMENT_FIRE);
    kill(r);
    const slot = spawnEnemy(r.world, RAT_TYPE, 300, 300);
    killEnemy(r.world, slot);

    const kills = result(r).killsByElement;
    expect(kills).toEqual({ fire: 1 });
    expect(result(r).enemiesKilled).toBe(3);
  });

  it("стихии без убийств в итог не попадают", () => {
    const r = run();
    advanceRun(r, 5);
    expect(result(r).killsByElement).toEqual({});
  });
});

describe("снимок и продолжение", () => {
  it("снимок на середине серии: продолжение даёт те же числа, что непрерывный забег", () => {
    const first = run();
    advanceRun(first, 40);
    kill(first);
    advanceRun(first, 100);
    hit(first);
    advanceRun(first, 30);
    const saved = JSON.parse(JSON.stringify(captureWorld(first.world, first.director))) as unknown;

    const resumed = run();
    restoreWorld(resumed.world, resumed.director, saved);
    advanceRun(first, 200);
    advanceRun(resumed, 200);

    expect(result(resumed)).toMatchObject({ noHitSec: result(first).noHitSec, noKillSec: result(first).noKillSec, killsByElement: result(first).killsByElement });
    expect(result(first)).toMatchObject({ noHitSec: 230, noKillSec: 40 });
  });

  it("версия снимка поднята: старые снимки без счётчиков не читаются молча", () => {
    expect(WORLD_SNAPSHOT_VERSION).toBeGreaterThan(10);
    const r = run();
    const saved = JSON.parse(JSON.stringify(captureWorld(r.world, r.director))) as { version: number };
    expect(saved.version).toBe(WORLD_SNAPSHOT_VERSION);
  });
});

describe("счётчики не трогают случайность", () => {
  it("два забега с одним seed и одним вводом: те же суммы, с ударами и убийствами или без них", () => {
    const quiet = run();
    const busy = run();
    advanceRun(quiet, 20);
    advanceRun(busy, 20);
    hit(busy, 0.0001);
    kill(busy);
    expect(busy.world.rng.getState()).toBe(quiet.world.rng.getState());
  });
});
