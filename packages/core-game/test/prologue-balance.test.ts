import { describe, expect, it } from "vitest";
import { BALANCE_TARGETS } from "../src/content/balance-targets";
import { quantile } from "../src/game/balance/simulate";
import { playPrologueWithBot, type BotPrologue } from "./helpers/prologue-run";

// Коридоры пролога (T-0278, docs/32-balance.md «Пролог»): уклоняющийся бот
// на двадцати зёрнах побеждает всегда, забег кончается за 170–230 с, Страж
// живёт 25–50 с, первый сундук выпадает на 75–110 с. Числа стартовые — правит
// геймдизайнер; коридоры зафиксированы до калибровки (`balance-targets.ts`).

const TARGETS = BALANCE_TARGETS.prologue;

const SEEDS = Array.from({ length: TARGETS.seeds }, (_, i) => i + 1);

/** Один прогон на зерно на весь файл: шестьсот тысяч тиков дважды считать незачем. */
let cache: BotPrologue[] | null = null;
function runs(): BotPrologue[] {
  cache ??= SEEDS.map((seed) => playPrologueWithBot(seed));
  return cache;
}

function median(values: readonly number[]): number {
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

describe("коридоры пролога по уклоняющемуся боту", () => {
  it("коридоры заданы по решению: 20 зёрен, победа всегда", () => {
    expect(TARGETS.seeds).toBe(20);
    expect(TARGETS.winRatioMin).toBe(1);
    expect(TARGETS.endSec).toEqual({ min: 170, max: 230 });
    expect(TARGETS.guardLifeSec).toEqual({ min: 25, max: 50 });
    expect(TARGETS.firstChestSec).toEqual({ min: 75, max: 110 });
  });

  it("бот побеждает во всех забегах", { timeout: 240_000 }, () => {
    const lost = runs().filter((run) => !run.won).map((run) => run.seed);
    expect(lost, `не победили на зёрнах: ${lost.join(", ")}`).toEqual([]);
    expect(runs().filter((run) => run.won).length / runs().length).toBeGreaterThanOrEqual(TARGETS.winRatioMin);
  });

  it("бот не умирает: оберег держит", { timeout: 240_000 }, () => {
    expect(runs().filter((run) => !run.world.player.alive)).toHaveLength(0);
  });

  it("конец забега — в коридоре на каждом зерне", { timeout: 240_000 }, () => {
    for (const run of runs()) {
      expect(run.endSec, `seed ${String(run.seed)}`).toBeGreaterThanOrEqual(TARGETS.endSec.min);
      expect(run.endSec, `seed ${String(run.seed)}`).toBeLessThanOrEqual(TARGETS.endSec.max);
    }
  });

  it("Страж живёт 25–50 с в медиане по зёрнам; ни один бой не короче 10 с и не дольше двух минут", { timeout: 240_000 }, () => {
    const lives = runs().map((run) => run.guardLifeSec);
    expect(median(lives)).toBeGreaterThanOrEqual(TARGETS.guardLifeSec.min);
    expect(median(lives)).toBeLessThanOrEqual(TARGETS.guardLifeSec.max);
    // Бот бьёт Стража по-разному от зерна к зерну (рывок уводит Стража из зоны оружия), поэтому коридор
    // задан медианой; хвосты ограничены грубо: «мгновенный» бой и бой, затянувшийся дольше пролога, — дефект.
    for (const life of lives) {
      expect(life).toBeGreaterThanOrEqual(10);
      expect(life).toBeLessThanOrEqual(120);
    }
  });

  it("первый сундук выпадает на 75–110 с на каждом зерне", { timeout: 240_000 }, () => {
    for (const run of runs()) {
      expect(run.firstChestSec, `seed ${String(run.seed)}`).toBeGreaterThanOrEqual(TARGETS.firstChestSec.min);
      expect(run.firstChestSec, `seed ${String(run.seed)}`).toBeLessThanOrEqual(TARGETS.firstChestSec.max);
    }
  });
});
