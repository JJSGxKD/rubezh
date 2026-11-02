import { describe, expect, it } from "vitest";
import type { DifficultyId } from "@bh/shared-types";
import { BALANCE_TARGETS } from "../src/content/balance-targets";
import { DEFAULT_DIFFICULTY_ID } from "../src/content/difficulty";
import { ACCOUNT_UNLOCKS } from "../src/content/unlocks";
import { WEAPONS } from "../src/content/weapons";
import { unlocksAt } from "../src/game/progression/unlocks";
import { PRESSURE } from "../src/content/pressure";
import {
  POWER_PROFILES,
  simulateBalanceRun,
  summarizeRuns,
  withDevice,
  type BalanceRunResult,
  type PowerProfile,
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

  it("бессмертный бот на «Сложной» за 300 с жив и берёт не менее десяти уровней", { timeout: 60_000 }, () => {
    // Растянутая прокачка (T-0193) не должна оставлять игрока без выбора: к
    // пятой минуте уровни ещё идут часто. Сам замер сборки — в `balance:sim`.
    const run = simulateBalanceRun({ seed: 1, skill: "dodging", startingWeaponId: STARTING_WEAPONS[0], godMode: true, maxSec: 300 });
    expect(run.timedOut).toBe(true);
    expect(run.level).toBeGreaterThanOrEqual(10);
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
      survivalSec: 317.48333333333335,
      level: 21,
      wave: 10,
      enemiesKilled: 2032,
    });
  });

  it("повторяет забег бота в точности — иначе таблица калибровки ничего не значит", { timeout: 60_000 }, () => {
    const first = simulateBalanceRun({ seed: 77, skill: "dodging", maxSec: 900 });
    const second = simulateBalanceRun({ seed: 77, skill: "dodging", maxSec: 900 });

    expect(second).toEqual(first);
  });
});

// Подстройка под силу (tasks/T-0196, решение 2, Р131, Р183): коридоры профилей
// на тех же seed и оружии, что у `dodgingRuns()`. Бот слабее человека, поэтому
// коридоры заданы отношениями медиан, а не минутами: лесенку в минутах сверяют
// по аналитике после выката.

const profileCache = new Map<string, BalanceRunResult[]>();

/** Прогоны профиля: подстройка включена (по умолчанию) или выключена, обычное устройство или слабое. */
function profileRuns(profile: PowerProfile, device?: "light", pressure = true): BalanceRunResult[] {
  const key = `${profile.id}/${device ?? "standard"}/${pressure ? "on" : "off"}`;
  const known = profileCache.get(key);
  if (known !== undefined) return known;

  const loadout = device === undefined ? profile.loadout : withDevice(profile, device).loadout;
  const runs: BalanceRunResult[] = [];
  for (const startingWeaponId of STARTING_WEAPONS) {
    for (const seed of SEEDS) {
      runs.push(simulateBalanceRun({ seed, skill: "dodging", startingWeaponId, maxSec: 1800, loadout, pressure }));
    }
  }
  profileCache.set(key, runs);
  return runs;
}

const medianOf = (runs: readonly BalanceRunResult[]): number => summarizeRuns(runs).medianSurvivalSec;

describe("подстройка под силу: профили", () => {
  const { novice, average, full } = POWER_PROFILES;
  const LONG = { timeout: 180_000 };

  it("средний профиль держится около базового бота без набора (0,85–1,15)", LONG, () => {
    const ratio = medianOf(profileRuns(average)) / medianOf(dodgingRuns());
    expect(ratio).toBeGreaterThanOrEqual(0.85);
    expect(ratio).toBeLessThanOrEqual(1.15);
  });

  it("лесенка: новичок к среднему 0,6–0,8, полный к среднему 1,25–1,6", LONG, () => {
    const mid = medianOf(profileRuns(average));
    expect(medianOf(profileRuns(novice)) / mid).toBeGreaterThanOrEqual(0.6);
    expect(medianOf(profileRuns(novice)) / mid).toBeLessThanOrEqual(0.8);
    expect(medianOf(profileRuns(full)) / mid).toBeGreaterThanOrEqual(1.25);
    expect(medianOf(profileRuns(full)) / mid).toBeLessThanOrEqual(1.6);
  });

  it("порядок профилей один — и с подстройкой, и без неё", LONG, () => {
    for (const pressure of [true, false]) {
      expect(medianOf(profileRuns(novice, undefined, pressure)), `pressure ${pressure}`).toBeLessThan(medianOf(profileRuns(average, undefined, pressure)));
      expect(medianOf(profileRuns(average, undefined, pressure)), `pressure ${pressure}`).toBeLessThan(medianOf(profileRuns(full, undefined, pressure)));
    }
  });

  it("подстройка забирает у сильного не больше половины преимущества (Р183)", LONG, () => {
    const pairs: [PowerProfile, PowerProfile][] = [
      [novice, average],
      [average, full],
    ];
    for (const [weak, strong] of pairs) {
      const withPressure = medianOf(profileRuns(strong)) / medianOf(profileRuns(weak));
      const without = medianOf(profileRuns(strong, undefined, false)) / medianOf(profileRuns(weak, undefined, false));
      expect(withPressure, `${weak.id} → ${strong.id}`).toBeGreaterThanOrEqual(Math.sqrt(without));
    }
  });

  it("слабое устройство живёт столько же, сколько обычное (0,85–1,15)", LONG, () => {
    const ratio = medianOf(profileRuns(average, "light")) / medianOf(profileRuns(average));
    expect(ratio).toBeGreaterThanOrEqual(0.85);
    expect(ratio).toBeLessThanOrEqual(1.15);
  });

  it("пик врагов на слабом устройстве не выше потолка и не больше 0,8 от обычного", LONG, () => {
    const cap = PRESSURE.devices.caps.light;
    const light = profileRuns(average, "light");
    const standard = profileRuns(average);
    expect(Math.max(...light.map((run) => run.peakEnemies))).toBeLessThanOrEqual(cap + 8);

    const peak = (runs: readonly BalanceRunResult[]): number => runs.map((run) => run.peakEnemies).sort((a, b) => a - b)[Math.floor(runs.length / 2)] ?? 0;
    if (peak(standard) >= 1.25 * cap) expect(peak(light)).toBeLessThanOrEqual(0.8 * peak(standard));
  });
});
