import { describe, expect, it } from "vitest";
import { BALANCE_TARGETS } from "../src/content/balance-targets";
import { simulateBalanceRun, summarizeRuns } from "../src/game/balance";

/**
 * Свойства баланса (docs/17-testing-strategy.md §3.3): утверждения, которые
 * обязаны выполняться при любых числах и переживут несколько итераций
 * баланса. Конкретные значения проверяет golden-прогон, а распределение по
 * десяткам seed — `pnpm balance:sim` (docs/26-stage2-plan.md, WP4.6).
 *
 * Seed немного: гейт перед PR должен оставаться быстрым. Полный свод —
 * отдельной командой, когда геймдизайнер крутит числа.
 */

const SEEDS = [1, 2, 3, 4, 5];

describe("свойства баланса", () => {
  it("не даёт пассивному игроку жить вечно", () => {
    // Бесконечный забег без единого действия означает, что играть незачем.
    for (const seed of SEEDS) {
      const run = simulateBalanceRun({ seed, skill: "passive", maxSec: 300 });
      expect(run.timedOut, `seed ${seed}`).toBe(false);
      expect(run.survivalSec, `seed ${seed}`).toBeLessThan(
        BALANCE_TARGETS.passiveDeathBeforeSec,
      );
    }
  });

  it("доводит уклоняющегося до целевого коридора выживания", () => {
    const runs = SEEDS.map((seed) => simulateBalanceRun({ seed, skill: "dodging", maxSec: 900 }));
    const summary = summarizeRuns(runs);

    expect(summary.medianSurvivalSec).toBeGreaterThanOrEqual(
      BALANCE_TARGETS.dodgingMedianSec.min,
    );
    expect(summary.medianSurvivalSec).toBeLessThanOrEqual(BALANCE_TARGETS.dodgingMedianSec.max);
  });

  it("не убивает новичка в первую минуту знакомства", () => {
    const runs = SEEDS.map((seed) => simulateBalanceRun({ seed, skill: "dodging", maxSec: 900 }));
    const summary = summarizeRuns(runs);

    expect(summary.deathsBeforeMinuteRatio).toBeLessThanOrEqual(
      BALANCE_TARGETS.dodgingDeathsBeforeMinuteRatioMax,
    );
  });

  it("повторяет забег бота в точности — иначе таблица калибровки ничего не значит", () => {
    const first = simulateBalanceRun({ seed: 77, skill: "dodging", maxSec: 900 });
    const second = simulateBalanceRun({ seed: 77, skill: "dodging", maxSec: 900 });

    expect(second).toEqual(first);
  });
});
