import { describe, expect, it } from "vitest";
import { BALANCE_TARGETS } from "../src/content/balance-targets";
import { WEAPONS } from "../src/content/weapons";
import {
  simulateBalanceRun,
  summarizeRuns,
  type BalanceRunResult,
} from "../src/game/balance";

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

/**
 * Коридор выживания меряется по всем стартовым оружиям сразу, а не по одному.
 *
 * Разброс внутри одного оружия огромен — у «Искры» p10 около 210 секунд, а
 * p90 за 670, — и медиана пяти забегов там пляшет на сотни секунд. Тест ловил
 * бы не баланс, а удачный seed. Сумма по трём оружиям даёт то же, что
 * показывает `pnpm balance:sim` на двадцати seed, и стоит шесть секунд.
 */
const STARTING_WEAPONS = WEAPONS.filter((weapon) => weapon.starting === true).map(
  (weapon) => weapon.id,
);

let cached: BalanceRunResult[] | null = null;

/** Прогоны считаются один раз на файл: пятнадцать забегов — это секунды. */
function dodgingRuns(): BalanceRunResult[] {
  if (cached !== null) return cached;

  const runs: BalanceRunResult[] = [];
  for (const startingWeaponId of STARTING_WEAPONS) {
    for (const seed of SEEDS) {
      runs.push(simulateBalanceRun({ seed, skill: "dodging", startingWeaponId, maxSec: 900 }));
    }
  }
  cached = runs;
  return runs;
}

describe("свойства баланса", () => {
  it("не даёт пассивному игроку жить вечно", { timeout: 60_000 }, () => {
    // Бесконечный забег без единого действия означает, что играть незачем.
    for (const seed of SEEDS) {
      const run = simulateBalanceRun({ seed, skill: "passive", maxSec: 300 });
      expect(run.timedOut, `seed ${seed}`).toBe(false);
      expect(run.survivalSec, `seed ${seed}`).toBeLessThan(
        BALANCE_TARGETS.passiveDeathBeforeSec,
      );
    }
  });

  it("доводит уклоняющегося до целевого коридора выживания", { timeout: 60_000 }, () => {
    const runs = dodgingRuns();
    const summary = summarizeRuns(runs);

    expect(summary.medianSurvivalSec).toBeGreaterThanOrEqual(
      BALANCE_TARGETS.dodgingMedianSec.min,
    );
    expect(summary.medianSurvivalSec).toBeLessThanOrEqual(BALANCE_TARGETS.dodgingMedianSec.max);
  });

  it("не убивает новичка в первую минуту знакомства", { timeout: 60_000 }, () => {
    const runs = dodgingRuns();
    const summary = summarizeRuns(runs);

    expect(summary.deathsBeforeMinuteRatio).toBeLessThanOrEqual(
      BALANCE_TARGETS.dodgingDeathsBeforeMinuteRatioMax,
    );
  });

  it("повторяет забег бота в точности — иначе таблица калибровки ничего не значит", { timeout: 60_000 }, () => {
    const first = simulateBalanceRun({ seed: 77, skill: "dodging", maxSec: 900 });
    const second = simulateBalanceRun({ seed: 77, skill: "dodging", maxSec: 900 });

    expect(second).toEqual(first);
  });
});
