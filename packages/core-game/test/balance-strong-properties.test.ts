import { describe, expect, it } from "vitest";
import { STRONG_BOT_TARGETS } from "../src/content/balance-targets";
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

// В тестах — то, что сходится. Остальные коридоры сильного бота («бегает» у новичка и полного арсенала, порядок
// лесенки, «стоит» + «ветеран» на нынешних числах) — вердикты `pnpm balance:sim -t "сильный бот"` и вопросы
// к тимлиду в PR T-0389 (docs/32-balance.md §3.2): тест, который заведомо красный, или `it.skip` — не контроль.
describe("сильный бот: лесенка профилей (Р183, Р194)", () => {
  it("«бегает»: средний игрок живёт около 10 минут", { timeout: 600_000 }, () => {
    const { min, max } = STRONG_BOT_TARGETS.kite.average;
    expect(strongMedian(POWER_PROFILES.average, "kite")).toBeGreaterThanOrEqual(min);
    expect(strongMedian(POWER_PROFILES.average, "kite")).toBeLessThanOrEqual(max);
  });
});

describe("сильный бот: стойка по забегу владельца (Р196)", () => {
  it("«стоит» + «ветеран» на числах до T-0388 живёт не меньше 1020 с: бот не слабее человека (1242 с)", { timeout: 900_000 }, () => {
    const median = summarizeRuns(veteranStandRuns(contentBeforeT0388())).medianSurvivalSec;
    expect(median).toBeGreaterThanOrEqual(STRONG_BOT_TARGETS.stand.oldNumbersMinSec);
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
