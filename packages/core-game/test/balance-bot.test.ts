import type { EnemyDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { createBot, DODGING_BOT_DEFAULTS, simulateBalanceRun } from "../src/game/balance";
import { createWorld, spawnEnemy, type World } from "../src/game/sim/world";

// Бот калибровки с задержкой реакции и ограниченным вниманием (tasks/T-0152):
// без них он обходит любую толпу пеших врагов медленнее себя, и калибровка
// видит только стрелков.

const RAT: EnemyDef = { id: "rat", hp: 10, speed: 1, damage: 1, xp: 1, pattern: "swarm" };

function world(): World {
  return createWorld({ seed: 1, enemies: [RAT], config: { progressionEnabled: false } });
}

/** Ставит врагов в единицах контента и перестраивает сетку, как это делает шаг мира. */
function place(w: World, points: readonly (readonly [number, number])[]): void {
  const scale = w.config.unitScale;
  for (const [x, y] of points) spawnEnemy(w, 0, x * scale, y * scale);
  rebuild(w);
}

function rebuild(w: World): void {
  w.enemyGrid.rebuild(w.player.x, w.player.y, w.enemies.x, w.enemies.y, w.enemies.alive, w.enemies.count);
}

/** Переносит единственного врага: сетка после этого перестраивается. */
function moveEnemy(w: World, index: number, x: number, y: number): void {
  const scale = w.config.unitScale;
  w.enemies.x[index] = x * scale;
  w.enemies.y[index] = y * scale;
  rebuild(w);
}

describe("задержка реакции", () => {
  it("между пересчётами бот идёт прежним курсом", () => {
    const w = world();
    place(w, [[100, 0]]);
    const bot = createBot("dodging", { reactionTicks: 5, attentionCount: 8 });

    expect(bot.input(w).moveX).toBeLessThan(0);

    moveEnemy(w, 0, -100, 0);
    for (let call = 2; call <= 5; call++) {
      expect(bot.input(w).moveX, `вызов ${String(call)}`).toBeLessThan(0);
    }
    expect(bot.input(w).moveX, "вызов 6").toBeGreaterThan(0);
  });

  it("при reactionTicks 1 курс пересчитывается каждый тик", () => {
    const w = world();
    place(w, [[100, 0]]);
    const bot = createBot("dodging", { reactionTicks: 1, attentionCount: 8 });

    expect(bot.input(w).moveX).toBeLessThan(0);

    moveEnemy(w, 0, -100, 0);
    expect(bot.input(w).moveX).toBeGreaterThan(0);
  });
});

describe("ограниченное внимание", () => {
  // Двое слева ближе (вес 0,7), шестеро справа дальше (вес около 0,4).
  const LEFT: [number, number][] = [
    [-60, -5],
    [-60, 5],
  ];
  const RIGHT: [number, number][] = [
    [120, -30],
    [120, -15],
    [120, 0],
    [120, 15],
    [120, 30],
    [125, 0],
  ];

  it("при внимании 8 правая толпа перевешивает двух ближних слева", () => {
    const w = world();
    place(w, [...LEFT, ...RIGHT]);
    const bot = createBot("dodging", { reactionTicks: 1, attentionCount: 8 });

    expect(bot.input(w).moveX).toBeLessThan(0);
  });

  it("при внимании 2 в счёт идут только два ближайших", () => {
    const w = world();
    place(w, [...LEFT, ...RIGHT]);
    const bot = createBot("dodging", { reactionTicks: 1, attentionCount: 2 });

    expect(bot.input(w).moveX).toBeGreaterThan(0);
  });
});

describe("детерминизм", () => {
  it("повтор забега с теми же параметрами даёт тот же результат", { timeout: 60_000 }, () => {
    const options = { seed: 5, skill: "dodging", maxSec: 120, bot: { reactionTicks: 12, attentionCount: 3 } } as const;

    expect(simulateBalanceRun(options)).toEqual(simulateBalanceRun(options));
  });
});

describe("параметры", () => {
  it("reactionTicks — целое от 1", () => {
    expect(() => createBot("dodging", { reactionTicks: 0 })).toThrow("reactionTicks");
    expect(() => createBot("dodging", { reactionTicks: 2.5 })).toThrow("reactionTicks");
  });

  it("attentionCount — целое от 1", () => {
    expect(() => createBot("dodging", { attentionCount: 0 })).toThrow("attentionCount");
    expect(() => createBot("dodging", { attentionCount: 1.5 })).toThrow("attentionCount");
  });

  it("пассивный бот параметры принимает и не двигается", () => {
    const w = world();
    place(w, [[100, 0]]);
    const bot = createBot("passive", { reactionTicks: 30 });

    for (let call = 0; call < 3; call++) expect(bot.input(w)).toEqual({ moveX: 0, moveY: 0 });
  });

  it("умолчания взяты из сетки замера", () => {
    expect([6, 12, 18, 24, 30]).toContain(DODGING_BOT_DEFAULTS.reactionTicks);
    expect([8, 6, 4, 3, 2]).toContain(DODGING_BOT_DEFAULTS.attentionCount);
  });
});
