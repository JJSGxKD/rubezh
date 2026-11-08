import { describe, expect, it } from "vitest";
import { STRONG_BOT_TARGETS } from "../src/content/balance-targets";
import { contentBeforeT0388, withoutSiege } from "./helpers/content-before-t0388";
import type { ContentSnapshot } from "../src/content/snapshot";
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

// В тестах — коридоры, принятые владельцем (Р196, Р197). «Бегает» у новичка и порядок лесенки — вердикты
// `pnpm balance:sim -t "сильный бот"`: их вернёт задача подстройки T-0391, тест, который заведомо красный,
// или `it.skip` — не контроль (docs/32-balance.md §3.2).
describe("сильный бот: лесенка профилей (Р183, Р194)", () => {
  it("«бегает»: средний игрок живёт около 10 минут", { timeout: 600_000 }, () => {
    const { min, max } = STRONG_BOT_TARGETS.kite.average;
    expect(strongMedian(POWER_PROFILES.average, "kite")).toBeGreaterThanOrEqual(min);
    expect(strongMedian(POWER_PROFILES.average, "kite")).toBeLessThanOrEqual(max);
  });

  it("«бегает»: полный арсенал — в коридоре по замеру (Р197)", { timeout: 600_000 }, () => {
    const { min, max } = STRONG_BOT_TARGETS.kite.full;
    expect(strongMedian(POWER_PROFILES.full, "kite")).toBeGreaterThanOrEqual(min);
    expect(strongMedian(POWER_PROFILES.full, "kite")).toBeLessThanOrEqual(max);
  });
});

describe("сильный бот: стойка по забегу владельца (Р196)", () => {
  it("«стоит» + «ветеран» на числах до T-0388 без осады живёт не меньше 1020 с: бот не слабее человека (1242 с)", { timeout: 900_000 }, () => {
    const median = summarizeRuns(veteranStandRuns(contentBeforeT0388())).medianSurvivalSec;
    expect(median).toBeGreaterThanOrEqual(STRONG_BOT_TARGETS.stand.oldNumbersMinSec);
  });

  it("«стоит» + «ветеран» на нынешних числах с осадой падает к 6–10-й минуте (Р197, T-0392)", { timeout: 900_000 }, () => {
    const { min, max } = STRONG_BOT_TARGETS.stand.veteran;
    const median = summarizeRuns(veteranStandRuns()).medianSurvivalSec;
    expect(median).toBeGreaterThanOrEqual(min);
    expect(median).toBeLessThanOrEqual(max);
  });
});

/**
 * Прогоны «бегает» профиля: с осадой и без неё. Забег, в котором осада не наступила, побитово равен
 * забегу без неё (осада читает мир и берёт случайность из своего потока), поэтому без осады
 * перегоняются только забеги, где она была, — иначе проверка вдвое дольше ради тех же чисел.
 */
function kiteWithAndWithoutSiege(profile: PowerProfile): { with: BalanceRunResult[]; without: BalanceRunResult[]; sieged: number } {
  const profileWeapons = profile.startingWeaponId === undefined ? STARTING_WEAPONS : [profile.startingWeaponId];
  const seeds = profile.id === "veteran" ? STRONG_BOT_TARGETS.stand.seeds : STRONG_BOT_TARGETS.seeds;
  const off: ContentSnapshot = withoutSiege();
  const withSiege: BalanceRunResult[] = [];
  const without: BalanceRunResult[] = [];
  let sieged = 0;
  for (const startingWeaponId of profileWeapons) {
    for (let seed = 1; seed <= seeds; seed++) {
      const options = { seed, skill: "strong", stance: "kite", startingWeaponId, maxSec: 1800, loadout: profile.loadout } as const;
      const run = simulateBalanceRun(options);
      withSiege.push(run);
      if ((run.sieges ?? 0) === 0) {
        without.push(run);
        continue;
      }
      sieged++;
      without.push(simulateBalanceRun({ ...options, content: off }));
    }
  }
  return { with: withSiege, without, sieged };
}

describe("сильный бот: осада не наказывает того, кто двигается (T-0392)", () => {
  const profiles = [POWER_PROFILES.novice, POWER_PROFILES.average, POWER_PROFILES.full, POWER_PROFILES.veteran];

  for (const profile of profiles) {
    it(`«бегает», ${profile.titleRu}: медиана с осадой и без неё расходится не больше чем на 5%`, { timeout: 900_000 }, () => {
      const { with: withSiege, without } = kiteWithAndWithoutSiege(profile);
      const medianWith = summarizeRuns(withSiege).medianSurvivalSec;
      const medianWithout = summarizeRuns(without).medianSurvivalSec;
      expect(Math.abs(medianWith - medianWithout) / medianWithout, `${String(medianWith)} с с осадой против ${String(medianWithout)} без неё`).toBeLessThanOrEqual(
        STRONG_BOT_TARGETS.siege.kiteShiftMax,
      );
    });
  }

  it("забег, в котором осада не наступила, побитово равен забегу без неё", { timeout: 300_000 }, () => {
    const off = withoutSiege();
    for (let seed = 1; seed <= 3; seed++) {
      const options = { seed, skill: "strong", stance: "kite", startingWeaponId: STARTING_WEAPONS[0], maxSec: 400, loadout: POWER_PROFILES.average.loadout } as const;
      const run = simulateBalanceRun(options);
      expect(run.sieges ?? 0, `seed ${String(seed)}`).toBe(0);
      expect(simulateBalanceRun({ ...options, content: off }).survivalSec).toBe(run.survivalSec);
    }
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
