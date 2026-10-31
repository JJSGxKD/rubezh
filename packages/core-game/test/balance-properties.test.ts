import { describe, expect, it } from "vitest";
import type { DifficultyId } from "@bh/shared-types";
import { BALANCE_TARGETS } from "../src/content/balance-targets";
import { DEFAULT_DIFFICULTY_ID } from "../src/content/difficulty";
import { ACCOUNT_UNLOCKS } from "../src/content/unlocks";
import { WEAPONS } from "../src/content/weapons";
import { unlocksAt } from "../src/game/progression/unlocks";
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
const STARTING_WEAPONS = WEAPONS.filter((weapon) => unlocksAt(ACCOUNT_UNLOCKS, 1).weapons.has(weapon.id)).map(
  (weapon) => weapon.id,
);

const cached = new Map<DifficultyId, BalanceRunResult[]>();

/** Прогоны считаются один раз на файл и сложность: пятнадцать забегов — это секунды. */
function dodgingRunsOn(difficultyId?: DifficultyId): BalanceRunResult[] {
  const key = difficultyId ?? DEFAULT_DIFFICULTY_ID;
  const known = cached.get(key);
  if (known !== undefined) return known;

  const runs: BalanceRunResult[] = [];
  for (const startingWeaponId of STARTING_WEAPONS) {
    for (const seed of SEEDS) {
      runs.push(simulateBalanceRun({ seed, skill: "dodging", startingWeaponId, maxSec: 900, ...(difficultyId === undefined ? {} : { difficultyId }) }));
    }
  }
  cached.set(key, runs);
  return runs;
}

/** Главный бой — «Сложная»: коридоры калибровки заданы для неё. */
const dodgingRuns = (): BalanceRunResult[] => dodgingRunsOn();

/** «Лёгкая»: на ней бот доживает до четвёртой минуты — путь к сундуку и добыче проверяется здесь. Коридора выживания у неё нет (Р179). */
const tutorialRuns = (): BalanceRunResult[] => dodgingRunsOn("easy");

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

  it("доводит уклоняющегося до целевого коридора выживания на «Сложной»", { timeout: 60_000 }, () => {
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

  it("роняет сундук в забегах уклоняющегося бота дольше четырёх минут", { timeout: 60_000 }, () => {
    // Порог не подгоняется под результат: сундук — награда дожившему до
    // элиты. Бот — прибор для замера выживания, а не модель игрока, который
    // идёт за добычей, поэтому здесь проверяется, что сундук выпал, а не что
    // бот к нему дошёл.
    // Идёт на обучающей «Лёгкой»: бот на «Сложной» до четвёртой минуты может
    // не дожить, а путь к сундуку от сложности не зависит.
    const longRuns = tutorialRuns().filter((run) => run.survivalSec > 240);
    expect(longRuns.length).toBeGreaterThan(0);

    const withChest = longRuns.filter((run) => run.chestsFound >= 1).length;
    expect(withChest / longRuns.length).toBeGreaterThanOrEqual(0.5);
  });

  it("хотя бы раз открывает сундук: путь к нему боту не закрыт", { timeout: 60_000 }, () => {
    expect(tutorialRuns().some((run) => run.chestsOpened >= 1)).toBe(true);
  });

  it("по умолчанию идёт на «Сложной»", { timeout: 60_000 }, () => {
    const byDefault = simulateBalanceRun({ seed: 3, skill: "dodging", maxSec: 300 });
    const explicit = simulateBalanceRun({ seed: 3, skill: "dodging", difficultyId: "hard", maxSec: 300 });
    expect(byDefault).toEqual(explicit);
  });

  it("зонд давления не убивает бота и считает полные минуты", { timeout: 60_000 }, () => {
    const probe = simulateBalanceRun({ seed: 1, skill: "dodging", immortalPlayer: true, maxSec: 180 });
    expect(probe.timedOut).toBe(true);
    expect(probe.damageTakenByMinute).toHaveLength(3);
    expect(probe.damageTakenByMinute.every((damage) => damage >= 0)).toBe(true);

    const mortal = simulateBalanceRun({ seed: 1, skill: "dodging", maxSec: 900 });
    expect(mortal.damageTakenByMinute.length).toBeLessThanOrEqual(Math.floor(mortal.survivalSec / 60));
  });

  // Эталонный забег бота на «Сложной» — golden главного боя. Ломается при любой
  // правке контента боя, и это ожидаемо: числа обновляются в том же PR
  // (docs/32-balance.md §3.3).
  it("повторяет эталонный забег бота на «Сложной»", { timeout: 60_000 }, () => {
    const run = simulateBalanceRun({ seed: 1, skill: "dodging", startingWeaponId: STARTING_WEAPONS[0], maxSec: 900 });
    expect({ survivalSec: run.survivalSec, level: run.level, wave: run.wave, enemiesKilled: run.enemiesKilled }).toEqual({
      survivalSec: 507.95,
      level: 28,
      wave: 13,
      enemiesKilled: 5117,
    });
  });

  it("повторяет забег бота в точности — иначе таблица калибровки ничего не значит", { timeout: 60_000 }, () => {
    const first = simulateBalanceRun({ seed: 77, skill: "dodging", maxSec: 900 });
    const second = simulateBalanceRun({ seed: 77, skill: "dodging", maxSec: 900 });

    expect(second).toEqual(first);
  });
});
