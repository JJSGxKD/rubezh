import { describe, expect, it } from "vitest";
import { PRESSURE_TARGETS, STRONG_BOT_TARGETS } from "../src/content/balance-targets";
import { contentBeforeT0388 } from "./helpers/content-before-t0388";
import { ACCOUNT_UNLOCKS } from "../src/content/unlocks";
import { WEAPONS } from "../src/content/weapons";
import { unlocksAt } from "../src/game/progression/unlocks";
import {
  POWER_PROFILES,
  simulateBalanceRun,
  summarizeRuns,
  type BalanceRunResult,
  type PowerProfile,
  type StrongStance,
} from "../src/game/balance";

/**
 * Сильный бот по лесенке Р183 и Р194 (T-0389): модель опытного игрока, которая собирает
 * опыт и держит связку. Старые боты (`balance-properties.test.ts`) проверяют ранний бой,
 * этот файл — поздний, и лежит он отдельно: десять seed на три стартовых оружия — это
 * несколько минут симуляции, и в одном файле с прежними свойствами они удлинили бы его
 * больше чем на 30%. Файлы идут параллельно, и время прежнего не меняется.
 *
 * Медиана считается по всем тридцати забегам, а не по одному оружию: у одного разброс
 * огромен, и десять забегов ловили бы удачу, а не баланс (docs/32-balance.md §3.2).
 */

const STARTING_WEAPONS = WEAPONS.filter((weapon) => unlocksAt(ACCOUNT_UNLOCKS, 1).weapons.has(weapon.id)).map(
  (weapon) => weapon.id,
);

const strongCache = new Map<string, BalanceRunResult[]>();

/** Прогоны сильного бота: профиль и стойка; считаются один раз на файл. */
function strongRuns(profile: PowerProfile, stance: StrongStance): BalanceRunResult[] {
  const key = `${profile.id}:${stance}`;
  const known = strongCache.get(key);
  if (known !== undefined) return known;

  const runs: BalanceRunResult[] = [];
  for (const startingWeaponId of STARTING_WEAPONS) {
    for (let seed = 1; seed <= STRONG_BOT_TARGETS.seeds; seed++) {
      runs.push(simulateBalanceRun({ seed, skill: "strong", stance, startingWeaponId, maxSec: 1800, loadout: profile.loadout }));
    }
  }
  strongCache.set(key, runs);
  return runs;
}

/** Прогоны «стоит» с профилем «ветеран»: стартовое оружие — «Очаг» из записи; контент нынешний или до T-0388. */
function veteranStandRuns(content?: ReturnType<typeof contentBeforeT0388>): BalanceRunResult[] {
  const runs: BalanceRunResult[] = [];
  for (let seed = 1; seed <= STRONG_BOT_TARGETS.stand.seeds; seed++) {
    runs.push(
      simulateBalanceRun({
        seed,
        skill: "strong",
        stance: "stand",
        startingWeaponId: POWER_PROFILES.veteran.startingWeaponId,
        maxSec: 2400,
        loadout: POWER_PROFILES.veteran.loadout,
        ...(content === undefined ? {} : { content }),
      }),
    );
  }
  return runs;
}

const strongMedian = (profile: PowerProfile, stance: StrongStance): number => summarizeRuns(strongRuns(profile, stance)).medianSurvivalSec;

// Лесенка Р183 по сильному боту (Р197, T-0391): подстройка под силу калибруется им, а не уклоняющимся.
// Медианы «бегает» считаются один раз на файл и переиспользуются свойствами ниже.
describe("сильный бот: лесенка профилей (Р183, Р194, Р197)", () => {
  it("«бегает»: новичок живёт около 7 минут", { timeout: 600_000 }, () => {
    const { min, max } = STRONG_BOT_TARGETS.kite.novice;
    expect(strongMedian(POWER_PROFILES.novice, "kite")).toBeGreaterThanOrEqual(min);
    expect(strongMedian(POWER_PROFILES.novice, "kite")).toBeLessThanOrEqual(max);
  });

  it("«бегает»: средний игрок живёт около 10 минут", { timeout: 600_000 }, () => {
    const { min, max } = STRONG_BOT_TARGETS.kite.average;
    expect(strongMedian(POWER_PROFILES.average, "kite")).toBeGreaterThanOrEqual(min);
    expect(strongMedian(POWER_PROFILES.average, "kite")).toBeLessThanOrEqual(max);
  });

  it("«бегает»: полный арсенал — в коридоре лесенки", { timeout: 600_000 }, () => {
    const { min, max } = STRONG_BOT_TARGETS.kite.full;
    expect(strongMedian(POWER_PROFILES.full, "kite")).toBeGreaterThanOrEqual(min);
    expect(strongMedian(POWER_PROFILES.full, "kite")).toBeLessThanOrEqual(max);
  });

  it("порядок лесенки: новичок < средний < полный арсенал, с подстройкой", { timeout: 600_000 }, () => {
    const novice = strongMedian(POWER_PROFILES.novice, "kite");
    const average = strongMedian(POWER_PROFILES.average, "kite");
    const full = strongMedian(POWER_PROFILES.full, "kite");
    expect(novice).toBeLessThan(average);
    expect(average).toBeLessThan(full);
  });

  it("новичок к среднему — в коридоре отношений (цель 0,7 = 7 / 10 минут)", { timeout: 600_000 }, () => {
    const { min, max } = PRESSURE_TARGETS.noviceToAverage;
    const ratio = strongMedian(POWER_PROFILES.novice, "kite") / strongMedian(POWER_PROFILES.average, "kite");
    expect(ratio).toBeGreaterThanOrEqual(min);
    expect(ratio).toBeLessThanOrEqual(max);
  });

  it("полный арсенал к среднему — в коридоре отношений (цель 1,4 = 14 / 10 минут)", { timeout: 600_000 }, () => {
    const { min, max } = PRESSURE_TARGETS.fullToAverage;
    const ratio = strongMedian(POWER_PROFILES.full, "kite") / strongMedian(POWER_PROFILES.average, "kite");
    expect(ratio).toBeGreaterThanOrEqual(min);
    expect(ratio).toBeLessThanOrEqual(max);
  });
});

describe("сильный бот: стойка по забегу владельца (Р196)", () => {
  it("«стоит» + «ветеран» на числах до T-0388 живёт не меньше 1020 с: бот не слабее человека (1242 с)", { timeout: 900_000 }, () => {
    const median = summarizeRuns(veteranStandRuns(contentBeforeT0388())).medianSurvivalSec;
    expect(median).toBeGreaterThanOrEqual(STRONG_BOT_TARGETS.stand.oldNumbersMinSec);
  });

  it("«стоит» + «ветеран» на нынешних числах падает к 12–16-й минуте (Р197)", { timeout: 900_000 }, () => {
    const { min, max } = STRONG_BOT_TARGETS.stand.veteran;
    const median = summarizeRuns(veteranStandRuns()).medianSurvivalSec;
    expect(median).toBeGreaterThanOrEqual(min);
    expect(median).toBeLessThanOrEqual(max);
  });
});

describe("сильный бот: сборка набора около 15-й минуты (Р127, Р194)", () => {
  it("бессмертный «бегает» со средним профилем собирает набор в коридоре", { timeout: 900_000 }, () => {
    const { min, max } = STRONG_BOT_TARGETS.build.average;
    const runs: BalanceRunResult[] = [];
    for (let seed = 1; seed <= STRONG_BOT_TARGETS.seeds; seed++) {
      runs.push(
        simulateBalanceRun({
          seed,
          skill: "strong",
          stance: "kite",
          startingWeaponId: "spark",
          loadout: POWER_PROFILES.average.loadout,
          godMode: true,
          stopOnBuild: true,
          maxSec: Math.ceil(max * STRONG_BOT_TARGETS.build.horizon),
        }),
      );
    }
    const summary = summarizeRuns(runs);
    expect(summary.buildCompleteRatio).toBeGreaterThanOrEqual(STRONG_BOT_TARGETS.build.shareMin);
    expect(summary.medianBuildCompleteSec).toBeGreaterThanOrEqual(min);
    expect(summary.medianBuildCompleteSec).toBeLessThanOrEqual(max);
  });
});
