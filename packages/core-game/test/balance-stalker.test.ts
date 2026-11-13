import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STALKER } from "../src/content/stalker";
import { createBot } from "../src/game/balance/bot";
import { POWER_PROFILES, simulateBalanceRun } from "../src/game/balance";
import { createRunWorld, type RunWorld } from "../src/game/run-world";
import { TICK_HZ } from "../src/game/sim/world";
import { stepRun } from "./helpers/prologue-run";

/**
 * Карачун в боевом забеге (Р205, tasks/T-0424): `createRunWorld` отдаёт миру правила из контента, а сцена
 * раздаёт журнал появлений оболочке событием `stalkerEnded`. Коридоры калибровки — в
 * `balance-strong-properties.test.ts`: десять минут ботом здесь проверяют подключение, а не баланс.
 */

const SCENE_SOURCE = readFileSync(fileURLToPath(new URL("../src/game/MainScene.ts", import.meta.url)), "utf8");
const API_SOURCE = readFileSync(fileURLToPath(new URL("../src/run-api.ts", import.meta.url)), "utf8");
const BUS_SOURCE = readFileSync(fileURLToPath(new URL("../src/engine/run-bus.ts", import.meta.url)), "utf8");

const TEN_MINUTES_SEC = 600;

/** Забег на «Сложной» с уровнем аккаунта; бессмертие — чтобы бот дожил до Карачуна, а не погиб раньше. */
function immortalRun(accountLevel: number, mode?: "prologue"): RunWorld {
  const run = createRunWorld({
    seed: 3,
    mapId: "",
    difficultyId: "hard",
    unitScale: 1,
    loadout: { modifiers: {}, boosts: [], accountLevel },
    ...(mode === undefined ? {} : { mode }),
  });
  run.world.cheats.godMode = true;
  return run;
}

describe("Карачун в боевом забеге", () => {
  it("с 4-го уровня аккаунта за 10 минут были предвестие и выход", { timeout: 120_000 }, () => {
    const run = immortalRun(9);
    expect(run.world.stalker.phase, "в новом мире директор ждёт отметки").toBe("waiting");
    const bot = createBot("dodging");
    stepRun(run, TEN_MINUTES_SEC * TICK_HZ, { input: (world) => bot.input(world), until: (world) => world.stalker.ended.length > 0 });

    const ended = run.world.stalker.ended;
    expect(ended.length, "появление закончилось").toBeGreaterThanOrEqual(1);
    expect(ended[0].index).toBe(0);
    expect(ended[0].elapsedSec, "не раньше отметки fromSec").toBeGreaterThanOrEqual(STALKER.appear.fromSec);
    expect(ended[0].lifeSec, "он выходил на поле, а не остался предвестием").toBeGreaterThan(0);
    // Бессмертного бота он не убивает, а строй стражей может срезать погоню: исход — не гибель.
    expect(ended[0].outcome).not.toBe("died");
  });

  it("в прологе Карачуна нет", { timeout: 120_000 }, () => {
    const run = immortalRun(9, "prologue");
    expect(run.world.stalker.phase).toBe("off");
    const bot = createBot("dodging");
    stepRun(run, TEN_MINUTES_SEC * TICK_HZ, { input: (world) => bot.input(world) });
    expect(run.world.stalker.ended).toHaveLength(0);
    expect(run.world.stalker.index).toBe(0);
  });

  it("у новичка ниже порога Карачуна нет, на пороге — есть", { timeout: 120_000 }, () => {
    const below = immortalRun(STALKER.appear.minAccountLevel - 1);
    expect(below.world.stalker.phase).toBe("off");
    const bot = createBot("dodging");
    stepRun(below, TEN_MINUTES_SEC * TICK_HZ, { input: (world) => bot.input(world) });
    expect(below.world.stalker.ended).toHaveLength(0);

    expect(immortalRun(STALKER.appear.minAccountLevel).world.stalker.phase).toBe("waiting");
  });
});

// Сцена Phaser в тесте не поднимается: её кусок проверяется по исходнику, как у `secrets-run.test.ts`.
describe("шина сцены: stalkerEnded", () => {
  it("событие объявлено в контракте с полями журнала и имеет набор обработчиков в шине", () => {
    expect(API_SOURCE).toMatch(
      /stalkerEnded:\s*\{[^}]*index: number;[^}]*outcome: "faded" \| "cut" \| "died";[^}]*hits: number;[^}]*pushes: number;[^}]*relocations: number;[^}]*lifeSec: number;[^}]*elapsedSec: number/,
    );
    expect(BUS_SOURCE).toContain("stalkerEnded: new Set()");
  });

  it("сцена раздаёт весь журнал появлений и очищает его, чтобы запись не ушла дважды", () => {
    expect(SCENE_SOURCE).toMatch(/emit\("stalkerEnded",\s*ended\)/);
    expect(SCENE_SOURCE).toContain("settleStalkerDeath(this.world)");
    expect(SCENE_SOURCE).toMatch(/journal\.length = 0/);
    // Раздача идёт в обоих циклах шагов: боевом и пошаговой паузе.
    expect(SCENE_SOURCE.match(/this\.emitStalkerEvents\(\)/g)?.length).toBe(2);
  });
});

// Эталон забега с Карачуном — golden боевого забега (docs/32-balance.md §3.3). Бессмертный бот, чтобы
// забег шёл до конца окна и появления не обрывала смерть. Ломается при правке чисел Карачуна или боя:
// числа обновляются в том же PR.
describe("эталон забега с Карачуном", () => {
  it("повторяет появления, касания и толчки бессмертного сильного бота", { timeout: 120_000 }, () => {
    const run = simulateBalanceRun({
      seed: 1,
      skill: "strong",
      stance: "kite",
      startingWeaponId: "spark",
      loadout: POWER_PROFILES.average.loadout,
      godMode: true,
      maxSec: 600,
    });
    expect({ survivalSec: run.survivalSec, stalker: run.stalker }).toEqual({ survivalSec: 600, stalker: { appearances: 3, hits: 1, pushes: 363 } });
  });
});
